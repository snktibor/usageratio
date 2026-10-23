import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import { applyGroundTruth, applySegmentFigures, parseOfficialPercent, timelineRates } from "@/lib/ground-truth";
import type { ResetEvent } from "@/lib/resets";

const HOUR = 3_600_000;
// The zone is fixed explicitly: these fixtures are written in Budapest time, independent of
// DEFAULT_RESET's own (deploy-time) default.
const config = {
  ...getConfig({}),
  useTokenLimits: true,
  limit: 500_000,
  tokenMode: "delta" as const,
  reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
};

// Wednesday 12:00 Budapest time; the weekly cycle started Monday 00:00, 60 h ago.
const NOW = new Date("2026-09-23T10:00:00Z");
const CYCLE_START = Date.parse("2026-09-20T22:00:00Z");

function report(machineId: string, groupId: string, tokens: number, hoursIntoCycle = 10) {
  return { machineId, groupId, tokens, ts: CYCLE_START + hoursIntoCycle * HOUR };
}

// The example of the specification: 40k measured in total, 10k of it by the Mac.
const model = buildDashboard(NOW, config, {
  events: [report("mac", "Personal", 10_000), report("win-1", "Work", 18_000), report("win-2", "Work", 12_000)],
  groups: [],
  machines: [{ machineId: "retired", groupId: "Work", lastSeenAt: NOW.getTime() - 200 * HOUR, lastTokens: 0 }],
});

describe("parseOfficialPercent", () => {
  it.each([
    ["45", 45],
    ["45,5", 45.5],
    ["45.5", 45.5],
    [" 45,25 % ", 45.25],
    ["45%", 45],
    ["0", 0],
    ["100", 100],
    ["7.", 7], // a decimal being typed
  ])("reads %j as %d", (raw, percent) => {
    expect(parseOfficialPercent(raw)).toEqual({ percent, invalid: false });
  });

  it("takes an empty field as 'not given', not as an error", () => {
    expect(parseOfficialPercent("")).toEqual({ percent: null, invalid: false });
    expect(parseOfficialPercent("   ")).toEqual({ percent: null, invalid: false });
    // A lone "%" holds no number yet: the field shows that sign anyway.
    expect(parseOfficialPercent("%")).toEqual({ percent: null, invalid: false });
  });

  it.each(["abc", "-5", "100,1", "101", "1000", "4 5", "45,555", "1e2", ",5", "%45"])("rejects %j", (raw) => {
    expect(parseOfficialPercent(raw)).toEqual({ percent: null, invalid: true });
  });
});

describe("applyGroundTruth — no official figure", () => {
  const view = applyGroundTruth(model, null);

  it("passes the measured figures through", () => {
    expect(view.calibrated).toBe(false);
    expect(view.scale).toBeNull();
    expect(view.quota?.total).toBe(40_000);
    expect(view.quota?.usedFraction).toBe(0.08);
    expect(view.quota?.status).toBe(model.quota?.status);
    expect(view.quota).toBe(model.quota);
    expect(view.groups).toBe(model.groups);
    expect(view.machines).toBe(model.machines);
  });

  it("measures every machine against the configured limit", () => {
    expect(view.machines.map((m) => [m.machineId, m.limitShare])).toEqual([
      ["win-1", 0.036],
      ["win-2", 0.024],
      ["mac", 0.02],
      ["retired", 0],
    ]);
  });
});

describe("applyGroundTruth — with the official figure", () => {
  const view = applyGroundTruth(model, { percent: 20, atMs: null });
  const machine = (id: string) => view.machines.find((m) => m.machineId === id)!;
  const group = (id: string) => view.groups.find((g) => g.groupId === id)!;

  it("leads with the official figure", () => {
    expect(view.calibrated).toBe(true);
    expect(view.quota?.usedFraction).toBe(0.2);
    expect(view.quota?.total).toBe(100_000);
    expect(view.quota?.remaining).toBe(400_000);
    expect(view.quota?.limit).toBe(500_000);
  });

  it("still knows what the machines measured, and how far off that is", () => {
    expect(view.measured).toEqual({ total: 40_000, usedFraction: 0.08 });
    expect(view.scale).toBe(2.5);
  });

  it("gives the Mac, with a quarter of the measured tokens, 5% of the official limit", () => {
    expect(machine("mac").share).toBe(0.25);
    expect(machine("mac").limitShare).toBeCloseTo(0.05, 12);
    expect(machine("mac").tokens).toBeCloseTo(25_000, 6);
  });

  it("restates every machine and group by the same proportion", () => {
    expect(machine("win-1").limitShare).toBeCloseTo(0.09, 12);
    expect(machine("win-2").tokens).toBeCloseTo(30_000, 6);
    expect(group("Work").limitShare).toBeCloseTo(0.15, 12);
    expect(group("Work").tokens).toBeCloseTo(75_000, 6);
    expect(group("Personal").tokens).toBeCloseTo(25_000, 6);
    expect(machine("retired").tokens).toBe(0);
  });

  it("adds up: the parts make the official total", () => {
    // A missing share of the limit makes the sum NaN: every calibrated row must have one.
    const sum = (rows: { tokens: number; limitShare: number | null }[]) =>
      rows.reduce((acc, row) => ({ tokens: acc.tokens + row.tokens, share: acc.share + (row.limitShare ?? NaN) }), {
        tokens: 0,
        share: 0,
      });
    expect(sum(view.machines).tokens).toBeCloseTo(100_000, 6);
    expect(sum(view.machines).share).toBeCloseTo(0.2, 12);
    expect(sum(view.groups).tokens).toBeCloseTo(100_000, 6);
  });

  it("leaves everything that is not a quantity alone, and never touches the model", () => {
    expect(machine("mac")).toMatchObject({ groupId: "Personal", reports: 1, health: model.machines[2]!.health });
    expect(group("Work").machines).toBe(2);
    expect(view.groups.map((g) => g.share)).toEqual(model.groups.map((g) => g.share));
    expect(model.machines.find((m) => m.machineId === "mac")!.tokens).toBe(10_000);
    expect(model.total).toBe(40_000);
  });

  it("judges the pace by the official figure", () => {
    // 8% measured in 60 of 168 hours projects to 22%: fine. 45% official projects to 126%.
    expect(model.quota?.status).toBe("good");
    const hot = applyGroundTruth(model, { percent: 45, atMs: null });
    expect(hot.quota?.status).toBe("warning");
    expect(hot.quota?.pace.projectedTotal).toBeCloseTo(630_000, 5);
    // 45% took 60 h, so 100% lasts 133 h 20 min.
    expect(hot.quota?.pace.runOutAt).toBe(CYCLE_START + Math.round((60 / 0.45) * HOUR));

    expect(applyGroundTruth(model, { percent: 85, atMs: null }).quota?.status).toBe("warning");
    const spent = applyGroundTruth(model, { percent: 100, atMs: null });
    expect(spent.quota?.status).toBe("critical");
    expect(spent.quota?.remaining).toBe(0);
  });

  it("judges the pace as of the moment the figure was read", () => {
    // 45% read at hour 30 is a much faster burn than 45% at hour 60.
    const earlier = applyGroundTruth(model, { percent: 45, atMs: CYCLE_START + 30 * HOUR });
    expect(earlier.quota?.pace.projectedTotal).toBeCloseTo(1_260_000, 5);
    expect(earlier.quota?.pace.runOutAt).toBe(CYCLE_START + Math.round((30 / 0.45) * HOUR));
  });

  it("keeps the reading's time inside the cycle, and not after the dashboard's own", () => {
    const fromTheFuture = applyGroundTruth(model, { percent: 45, atMs: NOW.getTime() + 5 * HOUR });
    expect(fromTheFuture.quota?.pace.projectedTotal).toBeCloseTo(630_000, 5);
    const fromLastCycle = applyGroundTruth(model, { percent: 45, atMs: CYCLE_START - 5 * HOUR });
    expect(fromLastCycle.quota?.pace.projectedTotal).toBeNull();
  });

  it("accepts 0%: nothing is used, whatever the machines measured", () => {
    const zero = applyGroundTruth(model, { percent: 0, atMs: null });
    expect(zero.calibrated).toBe(true);
    expect(zero.quota?.total).toBe(0);
    expect(zero.scale).toBe(0);
    expect(zero.machines.every((m) => m.tokens === 0 && m.limitShare === 0)).toBe(true);
    // The proportions are still there for the share bar.
    expect(zero.groups.map((g) => g.share)).toEqual(model.groups.map((g) => g.share));
  });
});

describe("applyGroundTruth — without token limits", () => {
  const bare = buildDashboard(
    NOW,
    { ...config, useTokenLimits: false },
    {
      events: [report("mac", "Personal", 10_000), report("win-1", "Work", 18_000), report("win-2", "Work", 12_000)],
      groups: [],
      machines: [],
    },
  );
  const officialView = applyGroundTruth(bare, { percent: 20, atMs: null });
  const machine = (id: string) => officialView.machines.find((m) => m.machineId === id)!;
  const group = (id: string) => officialView.groups.find((g) => g.groupId === id)!;

  it("knows nothing of the budget until the official figure is given", () => {
    const view = applyGroundTruth(bare, null);
    expect(view.calibrated).toBe(false);
    expect(view.inTokens).toBe(false);
    expect(view.quota).toBeNull();
    expect(view.scale).toBeNull();
    expect(view.measured).toEqual({ total: 40_000, usedFraction: null });
    expect(view.machines.map((m) => [m.machineId, m.tokens, m.limitShare])).toEqual([
      ["win-1", 18_000, null],
      ["win-2", 12_000, null],
      ["mac", 10_000, null],
    ]);
  });

  it("takes the official figure as the part of the budget gone", () => {
    expect(officialView.calibrated).toBe(true);
    expect(officialView.inTokens).toBe(false);
    expect(officialView.quota?.usedFraction).toBe(0.2);
    // No limit, so no official tokens: neither a factor nor a measured share of the limit.
    expect(officialView.scale).toBeNull();
    expect(officialView.measured).toEqual({ total: 40_000, usedFraction: null });
  });

  it("splits it by the measured proportions: the Mac's quarter of the tokens is 5% of the budget", () => {
    expect(machine("mac").limitShare).toBeCloseTo(0.05, 12);
    expect(machine("win-1").limitShare).toBeCloseTo(0.09, 12);
    expect(group("Work").limitShare).toBeCloseTo(0.15, 12);
    expect(group("Personal").limitShare).toBeCloseTo(0.05, 12);
    const sum = officialView.machines.reduce((acc, m) => acc + (m.limitShare ?? NaN), 0);
    expect(sum).toBeCloseTo(0.2, 12);
  });

  it("leaves the token counts as measured: there is no limit to convert by", () => {
    expect(officialView.machines.map((m) => [m.machineId, m.tokens])).toEqual([
      ["win-1", 18_000],
      ["win-2", 12_000],
      ["mac", 10_000],
    ]);
    expect(group("Work").tokens).toBe(30_000);
    expect(bare.machines.every((m) => m.limitShare === null)).toBe(true);
  });

  it.each([
    [0, null],
    [20, null],
    [45, null],
    [85, null],
    [100, null],
    [45, CYCLE_START + 30 * HOUR],
    [30, CYCLE_START + 5 * HOUR],
  ])("judges the pace of %d%% exactly as against a limit (read at %s)", (percent, atMs) => {
    const without = applyGroundTruth(bare, { percent, atMs }).quota!;
    const against = applyGroundTruth(model, { percent, atMs }).quota!;
    expect(without.status).toBe(against.status);
    expect(without.usedFraction).toBeCloseTo(against.usedFraction, 12);
    expect(without.pace.runOutAt).toBe(against.pace.runOutAt);
    expect(without.pace.earlyBurn).toBe(against.pace.earlyBurn);
    // Counted in fractions of the budget: the limit is 1.
    expect(without.limit).toBe(1);
    if (against.pace.projectedTotal === null) expect(without.pace.projectedTotal).toBeNull();
    else expect(without.pace.projectedTotal).toBeCloseTo(against.pace.projectedTotal / against.limit, 12);
  });
});

describe("applyGroundTruth — nothing measured", () => {
  const idle = buildDashboard(NOW, config, {
    events: [report("mac", "Personal", 0)],
    groups: [],
    machines: [],
  });

  it("shows the official figure, but has no proportions to split it by", () => {
    const view = applyGroundTruth(idle, { percent: 30, atMs: null });
    expect(view.quota?.usedFraction).toBe(0.3);
    expect(view.quota?.total).toBe(150_000);
    expect(view.scale).toBeNull();
    expect(view.machines.map((m) => [m.tokens, m.limitShare])).toEqual([[0, 0]]);
  });
});

describe("applyGroundTruth — after a keep reset", () => {
  // Tuesday 14:00, 38 h into the cycle; 50k measured before it (Work 30k, Home 20k), 12k of Work's since.
  const R = CYCLE_START + 38 * HOUR;
  const keep = (before: number | null): ResetEvent => ({
    id: "k",
    atMs: R,
    kind: "keep",
    cycleStartMs: CYCLE_START,
    before,
    beforeAtMs: null,
    source: "manual",
    recordedAtMs: R,
  });
  const events = [
    report("win-1", "Work", 30_000, 10),
    report("mac", "Home", 20_000, 20),
    report("win-1", "Work", 12_000, 40),
  ];
  const withReset = (before: number | null, limits = true) =>
    buildDashboard(
      NOW,
      { ...config, useTokenLimits: limits },
      { events, groups: [], machines: [], resets: [keep(before)] },
    );

  it("judges the pace from the reset, never from before it", () => {
    const model = withReset(80);
    const view = applyGroundTruth(model, { percent: 6, atMs: CYCLE_START + 20 * HOUR });
    expect(view.asOfMs).toBe(R);
    expect(view.quota!.pace.dailyShare).toBeCloseTo(24 / 130);
  });

  it("rates each finished segment at its own before-figure under an official reading", () => {
    const model = withReset(80);
    const rates = timelineRates(model, applyGroundTruth(model, { percent: 6, atMs: null }))!;
    const { times } = model.timeline;
    expect(rates).toHaveLength(times.length);
    expect(rates[times.indexOf(R - 1)]! * 50_000).toBeCloseTo(0.8);
    expect(rates[times.indexOf(R)]! * 12_000).toBeCloseTo(0.06);
    expect(rates.at(-1)! * 12_000).toBeCloseTo(0.06);
  });

  it("rates every sample at the token limit's rate without an official reading", () => {
    const model = withReset(80);
    const rates = timelineRates(model, applyGroundTruth(model, null))!;
    for (const rate of rates) expect(rate * 500_000).toBeCloseTo(1);
  });

  it("rates a finished segment with no known before-figure at the current rate", () => {
    const model = withReset(null);
    const rates = timelineRates(model, applyGroundTruth(model, { percent: 6, atMs: null }))!;
    expect(rates[model.timeline.times.indexOf(R - 1)]! * 12_000).toBeCloseTo(0.06);
  });

  it("has no rates while nothing tells how much of the budget is gone", () => {
    const model = withReset(80, false);
    expect(timelineRates(model, applyGroundTruth(model, null))).toBeNull();
  });
});

describe("timelineRates — more than one reset", () => {
  const rateAt = (rates: number[], times: number[], ms: number) => rates[times.indexOf(ms)];

  it("rates each finished segment at its own before-figure across two keep resets", () => {
    // Resets on Tuesday 14:00 (80% over 50k) and 22:00 (60% over 12k); 7k since the second.
    const R1 = CYCLE_START + 38 * HOUR;
    const R2 = CYCLE_START + 46 * HOUR;
    const keep = (id: string, atMs: number, before: number): ResetEvent => ({
      id,
      atMs,
      kind: "keep",
      cycleStartMs: CYCLE_START,
      before,
      beforeAtMs: null,
      source: "manual",
      recordedAtMs: atMs,
    });
    const twice = buildDashboard(NOW, config, {
      events: [
        report("win-1", "Work", 30_000, 10),
        report("mac", "Home", 20_000, 20),
        report("win-1", "Work", 12_000, 40),
        report("win-1", "Work", 7_000, 50),
      ],
      groups: [],
      machines: [],
      resets: [keep("k1", R1, 80), keep("k2", R2, 60)],
    });
    const rates = timelineRates(twice, applyGroundTruth(twice, { percent: 6, atMs: null }))!;
    const { times } = twice.timeline;
    expect(rates).toHaveLength(times.length);
    expect(rateAt(rates, times, CYCLE_START)! * 50_000).toBeCloseTo(0.8);
    expect(rateAt(rates, times, R1 - 1)! * 50_000).toBeCloseTo(0.8);
    expect(rateAt(rates, times, R1)! * 12_000).toBeCloseTo(0.6);
    expect(rateAt(rates, times, R2 - 1)! * 12_000).toBeCloseTo(0.6);
    expect(rateAt(rates, times, R2)! * 7_000).toBeCloseTo(0.06);
    expect(rates.at(-1)! * 7_000).toBeCloseTo(0.06);
  });

  it("does not take the restart a cycle began with for the end of a segment", () => {
    // The restart on Tuesday 14:00 began the cycle; the keep reset on Wednesday 04:00 (80% over 12k) cut it; 8k since.
    const RESTART = CYCLE_START + 38 * HOUR;
    const KEEP = CYCLE_START + 50 * HOUR;
    const restart: ResetEvent = {
      id: "restart",
      atMs: RESTART,
      kind: "restart",
      cycleStartMs: CYCLE_START,
      before: 62,
      beforeAtMs: null,
      source: "manual",
      recordedAtMs: RESTART,
      previousOverride: null,
    };
    const keep: ResetEvent = {
      id: "keep",
      atMs: KEEP,
      kind: "keep",
      cycleStartMs: RESTART,
      before: 80,
      beforeAtMs: null,
      source: "manual",
      recordedAtMs: KEEP,
    };
    const restarted = buildDashboard(
      NOW,
      config,
      {
        events: [
          report("win-1", "Work", 30_000, 10),
          report("win-1", "Work", 12_000, 40),
          report("win-1", "Work", 8_000, 55),
        ],
        groups: [],
        machines: [],
        resets: [restart, keep],
      },
      [],
      {
        cycle: { start: new Date(RESTART), end: new Date(RESTART + 168 * HOUR) },
        previous: { start: new Date(CYCLE_START), end: new Date(RESTART) },
      },
    );
    const rates = timelineRates(restarted, applyGroundTruth(restarted, { percent: 6, atMs: null }))!;
    const { times } = restarted.timeline;
    // The cycle's first sample is the restart itself: rated as the stretch the keep reset ended, not as a segment end of its own.
    expect(rateAt(rates, times, RESTART)! * 12_000).toBeCloseTo(0.8);
    expect(rateAt(rates, times, KEEP - 1)! * 12_000).toBeCloseTo(0.8);
    expect(rateAt(rates, times, KEEP)! * 8_000).toBeCloseTo(0.06);
    expect(rates.at(-1)! * 8_000).toBeCloseTo(0.06);
  });
});

describe("applySegmentFigures — a closed cycle with keep resets", () => {
  const R = CYCLE_START + 38 * HOUR;
  const END = CYCLE_START + 168 * HOUR;
  const closed = buildDashboard(
    new Date(END + 32 * HOUR),
    config,
    {
      events: [
        report("win-1", "Work", 30_000, 10),
        report("mac", "Home", 20_000, 20),
        report("win-1", "Work", 12_000, 40),
      ],
      groups: [],
      machines: [],
      archivedSegments: [
        { start: CYCLE_START, end: R, official: 80, total: 0, groups: {} },
        { start: R, end: END, official: 44, total: 0, groups: {} },
      ],
    },
    [],
    {
      cycle: { start: new Date(CYCLE_START), end: new Date(END) },
      previous: { start: new Date(CYCLE_START - 168 * HOUR), end: new Date(CYCLE_START) },
    },
  );

  it("comes to the sum of the figures, each split by its own segment's tokens", () => {
    const view = applySegmentFigures(closed, [80, 44]);
    expect(view.calibrated).toBe(true);
    expect(view.quota!.usedFraction).toBeCloseTo(1.24);
    expect(view.segmentFigures).toEqual([80, 44]);
    // Work: 30k of the first segment's 50k at 80%, all of the second's 12k at 44%. Home: 20k of 50k at 80%.
    const work = view.groups.find((group) => group.groupId === "Work")!;
    const home = view.groups.find((group) => group.groupId === "Home")!;
    expect(work.limitShare).toBeCloseTo(0.92);
    expect(home.limitShare).toBeCloseTo(0.32);
    expect(work.tokens).toBeCloseTo(0.92 * 500_000);
    expect(view.machines.find((machine) => machine.machineId === "win-1")!.limitShare).toBeCloseTo(0.92);
  });

  it("leaves a segment without a figure out, and is the measured view with none known", () => {
    expect(applySegmentFigures(closed, [null, 44]).quota!.usedFraction).toBeCloseTo(0.44);
    const measured = applySegmentFigures(closed, [null, null]);
    expect(measured.calibrated).toBe(false);
    expect(measured.segmentFigures).toBeUndefined();
  });

  it("rates each segment of the timeline at its own figure, an unknown one at the token limit's rate", () => {
    const { times } = closed.timeline;
    const rates = timelineRates(closed, applySegmentFigures(closed, [80, 44]))!;
    expect(rates[times.indexOf(R - 1)]! * 50_000).toBeCloseTo(0.8);
    expect(rates.at(-1)! * 12_000).toBeCloseTo(0.44);
    const partial = timelineRates(closed, applySegmentFigures(closed, [null, 44]))!;
    expect(partial[times.indexOf(R - 1)]! * 500_000).toBeCloseTo(1);
  });

  it("adds the figures up to two decimals, so a sum of 100 is the full budget and critical", () => {
    const R1 = CYCLE_START + 38 * HOUR;
    const R2 = CYCLE_START + 90 * HOUR;
    const three = buildDashboard(
      new Date(END + 32 * HOUR),
      config,
      {
        events: [
          report("win-1", "Work", 30_000, 10),
          report("win-1", "Work", 20_000, 50),
          report("win-1", "Work", 12_000, 100),
        ],
        groups: [],
        machines: [],
        archivedSegments: [
          { start: CYCLE_START, end: R1, official: 0.08, total: 0, groups: {} },
          { start: R1, end: R2, official: 86.07, total: 0, groups: {} },
          { start: R2, end: END, official: 13.85, total: 0, groups: {} },
        ],
      },
      [],
      {
        cycle: { start: new Date(CYCLE_START), end: new Date(END) },
        previous: { start: new Date(CYCLE_START - 168 * HOUR), end: new Date(CYCLE_START) },
      },
    );
    // 0.08 + 86.07 + 13.85 is 99.99999999999999 as floats.
    const view = applySegmentFigures(three, [0.08, 86.07, 13.85]);
    expect(view.quota!.usedFraction).toBe(1);
    expect(view.quota!.status).toBe("critical");
  });
});

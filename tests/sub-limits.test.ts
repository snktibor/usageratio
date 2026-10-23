import { describe, expect, it } from "vitest";
import type { UsageEvent } from "@/lib/aggregate";
import { getConfig } from "@/lib/config";
import { buildDashboard, type StoreSnapshot } from "@/lib/dashboard";
import { applyGroundTruth, applySubLimitReading, subLimitTimeline } from "@/lib/ground-truth";
import {
  measureSubLimits,
  normalizeModelPart,
  normalizeSubLimitName,
  type SubLimit,
  splitBySubLimits,
  subLimitIdFor,
  subLimitOf,
} from "@/lib/sub-limits";
import { sampleTimes, withResetSamples } from "@/lib/timeline";

const HOUR = 3_600_000;
// Wednesday 12:00 Budapest time; the weekly cycle started Monday 00:00 (= Sunday 22:00 UTC), 60 h ago.
const NOW = new Date("2026-09-23T10:00:00Z");
const CYCLE_START = Date.parse("2026-09-20T22:00:00Z");
const CYCLE_END = CYCLE_START + 7 * 24 * HOUR;
// The zone is fixed explicitly: these fixtures are written in Budapest time, independent of
// DEFAULT_RESET's own (deploy-time) default.
const config = {
  ...getConfig({}),
  tokenMode: "snapshot" as const,
  reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
};

const FABLE: SubLimit = {
  id: "fable",
  name: "Fable",
  models: ["fable"],
  mode: "separate",
  sharePercent: 50,
  limit: 200_000,
};
const OPUS: SubLimit = { id: "opus", name: "Opus", models: ["opus"], mode: "share", sharePercent: 40, limit: 1 };

function report(
  machineId: string,
  groupId: string,
  hoursIntoCycle: number,
  models?: Record<string, number>,
  tokens?: number,
): UsageEvent {
  const total = tokens ?? Object.values(models ?? {}).reduce((sum, amount) => sum + amount, 0);
  return { machineId, groupId, tokens: total, ts: CYCLE_START + hoursIntoCycle * HOUR, ...(models && { models }) };
}

function snapshot(events: UsageEvent[]): StoreSnapshot {
  return { events, groups: [], machines: [] };
}

describe("sub-limit definitions", () => {
  it("take a model by any of their parts, the first sub-limit first", () => {
    const greedy: SubLimit = { ...OPUS, id: "claude", models: ["claude"] };
    expect(subLimitOf("claude-fable-5-1", [FABLE, OPUS])?.id).toBe("fable");
    expect(subLimitOf("Claude-Opus-5-20260101", [FABLE, OPUS])?.id).toBe("opus");
    expect(subLimitOf("claude-sonnet-5", [FABLE, OPUS])).toBeNull();
    expect(subLimitOf("claude-fable-5-1", [greedy, FABLE])?.id).toBe("claude");
  });

  it("normalize names and model parts as typed", () => {
    expect(normalizeSubLimitName("  Fable   5 ")).toBe("Fable 5");
    expect(normalizeSubLimitName("")).toBeNull();
    expect(normalizeSubLimitName("x".repeat(41))).toBeNull();
    expect(normalizeSubLimitName("a\u0007b")).toBeNull();
    expect(normalizeModelPart(" Opus-5 ")).toBe("opus-5");
    expect(normalizeModelPart("a/b")).toBeNull();
    expect(normalizeModelPart("-fable")).toBeNull();
  });

  it("get an id from the name that is free and stays readable", () => {
    expect(subLimitIdFor("Fable 5", [])).toBe("fable-5");
    expect(subLimitIdFor("Fable", ["fable", "fable-2"])).toBe("fable-3");
    expect(subLimitIdFor("Ősz ünnep", [])).toBe("osz-unnep");
    expect(subLimitIdFor("★", [])).toBe("sub-limit");
    expect(subLimitIdFor("a".repeat(40), [])).toHaveLength(24);
  });
});

describe("splitBySubLimits", () => {
  const events = [
    report("mac", "Home", 10, { "claude-fable-5-1": 300, "claude-opus-5": 500, "claude-sonnet-5": 200 }),
    report("old-pc", "Home", 10, undefined, 700),
  ];

  it("takes a separate sub-limit's tokens out of the provider's, and leaves a part's in", () => {
    const { main, bySubLimit } = splitBySubLimits(events, [FABLE, OPUS]);
    expect(main.map((e) => e.tokens)).toEqual([700, 700]);
    expect(main[0]!.models).toEqual({ "claude-opus-5": 500, "claude-sonnet-5": 200 });
    expect(bySubLimit.get("fable")!.map((e) => [e.machineId, e.tokens])).toEqual([["mac", 300]]);
    expect(bySubLimit.get("opus")!.map((e) => [e.machineId, e.tokens])).toEqual([["mac", 500]]);
  });

  it("gives a sub-limit zero from a split that names none of its models, and nothing from a report without a split", () => {
    const { bySubLimit } = splitBySubLimits([report("mac", "Home", 1, { "claude-sonnet-5": 10 }), events[1]!], [FABLE]);
    expect(bySubLimit.get("fable")!.map((e) => e.tokens)).toEqual([0]);
  });

  it("keeps every other field of a report", () => {
    const checkpoint = { ...events[0]!, checkpoint: true } as UsageEvent;
    const { main, bySubLimit } = splitBySubLimits([checkpoint], [FABLE]);
    expect(main[0]).toMatchObject({ machineId: "mac", groupId: "Home", ts: checkpoint.ts, checkpoint: true });
    expect(bySubLimit.get("fable")![0]).toMatchObject({ checkpoint: true });
  });

  it("changes nothing without sub-limits", () => {
    expect(splitBySubLimits(events, []).main).toBe(events);
  });
});

describe("measureSubLimits", () => {
  const window = { startMs: CYCLE_START, endMs: CYCLE_END, nowMs: NOW.getTime() };
  const times = sampleTimes(CYCLE_START, CYCLE_END, NOW.getTime());

  it("measures the cycle's tokens in the token mode, and names the models", () => {
    const events = [
      report("mac", "Home", -5, { "claude-fable-5-1": 999 }), // the previous cycle
      report("mac", "Home", 10, { "claude-fable-5-1": 100 }),
      report("mac", "Home", 20, { "claude-fable-5-1-20260901": 250, "claude-opus-5": 50 }),
      report("win", "Work", 30, { "claude-fable-5-1": 40 }),
    ];
    const [fable] = measureSubLimits(
      [FABLE],
      splitBySubLimits(events, [FABLE]).bySubLimit,
      window,
      times,
      "snapshot",
      null,
    );
    expect(fable).toMatchObject({
      id: "fable",
      name: "Fable",
      mode: "separate",
      shareCap: null,
      total: 290,
      hasSplit: true,
    });
    expect(fable!.models).toEqual(["Claude Fable 5.1"]);
    expect(fable!.quota).toBeNull();
  });

  it("follows the cycle on the dashboard's timeline, ending on its total", () => {
    const events = [
      report("mac", "Home", 10, { "claude-fable-5-1": 100 }),
      report("mac", "Home", 20, { "claude-fable-5-1": 250 }),
      report("win", "Work", 30, { "claude-fable-5-1": 40 }),
    ];
    const [fable] = measureSubLimits(
      [FABLE],
      splitBySubLimits(events, [FABLE]).bySubLimit,
      window,
      times,
      "snapshot",
      null,
    );
    const at = (hours: number) => fable!.values[times.indexOf(CYCLE_START + hours * HOUR)];
    expect(fable!.values).toHaveLength(times.length);
    expect(at(0)).toBe(0);
    expect(at(10)).toBe(100);
    expect(at(25)).toBe(250);
    expect(fable!.values[times.length - 1]).toBe(290);
  });

  it("measures a separate one against its own token limit, a part against its share of the provider's", () => {
    const events = [report("mac", "Home", 10, { "claude-fable-5-1": 50_000, "claude-opus-5": 120_000 })];
    const split = splitBySubLimits(events, [FABLE, OPUS]).bySubLimit;
    const [fable, opus] = measureSubLimits([FABLE, OPUS], split, window, times, "snapshot", 1_000_000);
    expect(fable!.quota).toMatchObject({ limit: 200_000, usedFraction: 0.25 });
    expect(opus!.shareCap).toBe(0.4);
    expect(opus!.quota).toMatchObject({ limit: 400_000, usedFraction: 0.3 });
  });

  it("knows it knows nothing while no report of the cycle came with a split", () => {
    const [fable] = measureSubLimits(
      [FABLE],
      splitBySubLimits([report("old-pc", "Home", 10, undefined, 500)], [FABLE]).bySubLimit,
      window,
      times,
      "snapshot",
      null,
    );
    expect(fable).toMatchObject({ total: 0, hasSplit: false, models: [] });
    expect(fable!.values.every((value) => value === 0)).toBe(true);
  });

  it("measures the current segment after a keep reset, its line restarting from 0", () => {
    const reset = CYCLE_START + 15 * HOUR;
    const events = [
      report("mac", "Home", 10, { "claude-fable-5-1": 100 }),
      report("mac", "Home", 20, { "claude-fable-5-1": 250 }),
      report("win", "Work", 30, { "claude-fable-5-1": 40 }),
    ];
    const segmentTimes = withResetSamples(times, [reset]);
    const [fable] = measureSubLimits(
      [FABLE],
      splitBySubLimits(events, [FABLE]).bySubLimit,
      window,
      segmentTimes,
      "snapshot",
      1_000_000,
      [reset],
    );
    // Running totals: the Mac's 250 less the 100 it had counted before the reset, and the PC's 40.
    expect(fable!.total).toBe(190);
    expect(fable!.values[segmentTimes.indexOf(reset - 1)]).toBe(100);
    expect(fable!.values[segmentTimes.indexOf(reset)]).toBe(0);
    expect(fable!.values.at(-1)).toBe(190);
    expect(fable!.quota).toMatchObject({ limit: 200_000, usedFraction: 190 / 200_000 });
    expect(fable!.quota!.pace.dailyShare).toBeCloseTo((24 * HOUR) / (CYCLE_END - reset));
  });

  it("knows nothing of a sub-limit whose models reported only before the reset", () => {
    const reset = CYCLE_START + 15 * HOUR;
    const events = [report("mac", "Home", 10, { "claude-fable-5-1": 100 })];
    const [fable] = measureSubLimits(
      [FABLE],
      splitBySubLimits(events, [FABLE]).bySubLimit,
      window,
      withResetSamples(times, [reset]),
      "snapshot",
      null,
      [reset],
    );
    expect(fable).toMatchObject({ total: 0, hasSplit: false, models: [] });
  });
});

describe("buildDashboard with sub-limits", () => {
  const events = [
    report("mac", "Home", 10, { "claude-fable-5-1": 300, "claude-opus-5": 500 }),
    report("win", "Work", 10, { "claude-opus-5": 200 }),
  ];

  it("leaves a separate sub-limit out of every figure but its own and the models", () => {
    const model = buildDashboard(NOW, config, snapshot(events), [FABLE]);
    expect(model.total).toBe(700);
    expect(model.groups.map((g) => [g.groupId, g.tokens])).toEqual([
      ["Home", 500],
      ["Work", 200],
    ]);
    expect(model.machines.map((m) => [m.machineId, m.tokens])).toEqual([
      ["mac", 500],
      ["win", 200],
    ]);
    const lastOf = (values: number[]) => values[values.length - 1];
    expect(model.timeline.groups.map((g) => lastOf(g.values))).toEqual([500, 200]);
    // The model chart still has every model.
    expect(model.timeline.models.map((m) => [m.modelId, m.tokens])).toEqual([
      ["claude-opus-5", 700],
      ["claude-fable-5-1", 300],
    ]);
    expect(model.subLimits.map((s) => [s.id, s.total])).toEqual([["fable", 300]]);
  });

  it("keeps a part in the provider's figures", () => {
    const model = buildDashboard(NOW, config, snapshot(events), [{ ...FABLE, mode: "share" }]);
    expect(model.total).toBe(1000);
    expect(model.subLimits[0]).toMatchObject({ total: 300, shareCap: 0.5 });
  });

  it("has no sub-limits by default", () => {
    expect(buildDashboard(NOW, config, snapshot(events)).subLimits).toEqual([]);
  });
});

describe("applySubLimitReading", () => {
  const events = [report("mac", "Home", 30, { "claude-fable-5-1": 200, "claude-opus-5": 800 })];
  const reading = (percent: number) => ({ percent, atMs: null });

  it("takes its own official reading first", () => {
    const model = buildDashboard(NOW, config, snapshot(events), [FABLE]);
    const view = applyGroundTruth(model, null);
    const sub = applySubLimitReading(model, view, model.subLimits[0]!, reading(35));
    expect(sub).toMatchObject({ source: "official", ofProvider: null });
    expect(sub.quota).toMatchObject({ usedFraction: 0.35, limit: 1 });
  });

  it("states a part's share of the provider's budget from its own reading", () => {
    const model = buildDashboard(NOW, config, snapshot(events), [OPUS]);
    const sub = applySubLimitReading(model, applyGroundTruth(model, null), model.subLimits[0]!, reading(50));
    expect(sub.ofProvider).toBeCloseTo(0.2);
  });

  it("derives a part from the provider's official figure by the measured proportion", () => {
    const model = buildDashboard(NOW, config, snapshot(events), [OPUS]);
    // Opus is 800 of 1000 measured tokens; the provider stands at 30%, Opus may use 40% of it.
    const view = applyGroundTruth(model, reading(30));
    const sub = applySubLimitReading(model, view, model.subLimits[0]!, null);
    expect(sub.source).toBe("provider");
    expect(sub.ofProvider).toBeCloseTo(0.24);
    expect(sub.quota!.usedFraction).toBeCloseTo(0.6);
  });

  it("paces a derived part as of the provider's reading", () => {
    const model = buildDashboard(NOW, config, snapshot(events), [OPUS]);
    const atMs = CYCLE_START + 36 * HOUR;
    const view = applyGroundTruth(model, { percent: 30, atMs });
    const sub = applySubLimitReading(model, view, model.subLimits[0]!, null);
    expect(sub.quota!.pace.projectedTotal).toBeCloseTo(0.6 / (36 / 168));
  });

  it("measures a part against the token limit while there is no official figure", () => {
    const limited = { ...config, useTokenLimits: true, limit: 2000 };
    const model = buildDashboard(NOW, limited, snapshot(events), [OPUS]);
    const sub = applySubLimitReading(model, applyGroundTruth(model, null), model.subLimits[0]!, null);
    expect(sub.source).toBe("measured");
    // 800 of the 40% × 2000 it may use.
    expect(sub.quota!.usedFraction).toBeCloseTo(1);
    expect(sub.quota!.status).toBe("critical");
  });

  it("measures a separate one against its own token limit, and knows nothing without one", () => {
    const limited = { ...config, useTokenLimits: true, limit: 2000 };
    const model = buildDashboard(NOW, limited, snapshot(events), [{ ...FABLE, limit: 800 }]);
    const sub = applySubLimitReading(model, applyGroundTruth(model, reading(50)), model.subLimits[0]!, null);
    expect(sub).toMatchObject({ source: "measured", ofProvider: null });
    expect(sub.quota!.usedFraction).toBeCloseTo(0.25);

    const unlimited = buildDashboard(NOW, config, snapshot(events), [FABLE]);
    const unknown = applySubLimitReading(
      unlimited,
      applyGroundTruth(unlimited, reading(50)),
      unlimited.subLimits[0]!,
      null,
    );
    expect(unknown).toMatchObject({ source: null, quota: null });
  });

  it("gives the chart a line ending on its figure, and none while the figure is unknown", () => {
    const twoReports = [
      report("mac", "Home", 10, { "claude-fable-5-1": 100, "claude-opus-5": 100 }),
      report("mac", "Home", 30, { "claude-fable-5-1": 200, "claude-opus-5": 800 }),
    ];
    const model = buildDashboard(NOW, config, snapshot(twoReports), [FABLE]);
    const view = applyGroundTruth(model, reading(50));
    const line = subLimitTimeline(applySubLimitReading(model, view, model.subLimits[0]!, reading(80)))!;
    const times = model.timeline.times;
    expect(line[line.length - 1]).toBeCloseTo(0.8);
    // Half of its tokens were there at hour 10: half of its figure.
    expect(line[times.indexOf(CYCLE_START + 10 * HOUR)]).toBeCloseTo(0.4);
    expect(subLimitTimeline(applySubLimitReading(model, view, model.subLimits[0]!, null))).toBeNull();
  });

  it("draws no line for a figure with no measured tokens to shape it", () => {
    const model = buildDashboard(NOW, config, snapshot([report("mac", "Home", 30, { "claude-opus-5": 800 })]), [FABLE]);
    const sub = applySubLimitReading(model, applyGroundTruth(model, null), model.subLimits[0]!, reading(20));
    expect(sub.quota).not.toBeNull();
    expect(subLimitTimeline(sub)).toBeNull();
  });

  it("does not claim 0% for a part while no report came with a split by model", () => {
    const model = buildDashboard(NOW, config, snapshot([report("old-pc", "Home", 30, undefined, 900)]), [OPUS]);
    const sub = applySubLimitReading(model, applyGroundTruth(model, reading(30)), model.subLimits[0]!, null);
    expect(sub).toMatchObject({ source: null, quota: null });
  });

  it("flags a part's own reading as mismatched once it outruns the provider's by more than the tolerance", () => {
    const model = buildDashboard(NOW, config, snapshot(events), [OPUS]);
    // Opus may use at most 40% of the whole; at 100% of that, it alone accounts for 40% of the total.
    const view = applyGroundTruth(model, reading(20));
    const sub = applySubLimitReading(model, view, model.subLimits[0]!, reading(100));
    expect(sub).toMatchObject({ ofProvider: 0.4, providerUsedFraction: 0.2, mismatched: true });
  });

  it("stays quiet inside the 5-point tolerance, and once the provider's figure covers it", () => {
    const model = buildDashboard(NOW, config, snapshot(events), [OPUS]);
    // 40% of the 40% share is 16% of the whole: 1 point over the provider's 15%, within tolerance.
    const close = applySubLimitReading(model, applyGroundTruth(model, reading(15)), model.subLimits[0]!, reading(40));
    expect(close.ofProvider).toBeCloseTo(0.16);
    expect(close).toMatchObject({ providerUsedFraction: 0.15, mismatched: false });

    const covered = applySubLimitReading(model, applyGroundTruth(model, reading(50)), model.subLimits[0]!, reading(40));
    expect(covered.ofProvider).toBeCloseTo(0.16);
    expect(covered).toMatchObject({ providerUsedFraction: 0.5, mismatched: false });
  });

  it("has nothing to mismatch without the provider's own figure", () => {
    const model = buildDashboard(NOW, config, snapshot(events), [OPUS]);
    const sub = applySubLimitReading(model, applyGroundTruth(model, null), model.subLimits[0]!, reading(100));
    expect(sub).toMatchObject({ providerUsedFraction: null, mismatched: false });
  });
});

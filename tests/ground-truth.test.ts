import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import { applyGroundTruth, parseOfficialPercent } from "@/lib/ground-truth";

const HOUR = 3_600_000;
const config = { ...getConfig({}), limit: 500_000 };

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
  machines: [
    { machineId: "retired", groupId: "Work", lastSeenAt: NOW.getTime() - 200 * HOUR, lastTokens: 0 },
  ],
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
    expect(view.quota.total).toBe(40_000);
    expect(view.quota.usedFraction).toBe(0.08);
    expect(view.quota.status).toBe(model.status);
    expect(view.quota.pace).toBe(model.pace);
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
    expect(view.quota.usedFraction).toBe(0.2);
    expect(view.quota.total).toBe(100_000);
    expect(view.quota.remaining).toBe(400_000);
    expect(view.quota.limit).toBe(500_000);
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
    const sum = (rows: { tokens: number; limitShare: number }[]) =>
      rows.reduce((acc, row) => ({ tokens: acc.tokens + row.tokens, share: acc.share + row.limitShare }), {
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
    expect(model.status).toBe("good");
    const hot = applyGroundTruth(model, { percent: 45, atMs: null });
    expect(hot.quota.status).toBe("warning");
    expect(hot.quota.pace.projectedTotal).toBeCloseTo(630_000, 5);
    // 45% took 60 h, so 100% lasts 133 h 20 min.
    expect(hot.quota.pace.runOutAt).toBe(CYCLE_START + Math.round((60 / 0.45) * HOUR));

    expect(applyGroundTruth(model, { percent: 85, atMs: null }).quota.status).toBe("warning");
    const spent = applyGroundTruth(model, { percent: 100, atMs: null });
    expect(spent.quota.status).toBe("critical");
    expect(spent.quota.remaining).toBe(0);
  });

  it("judges the pace as of the moment the figure was read", () => {
    // 45% read at hour 30 is a much faster burn than 45% at hour 60.
    const earlier = applyGroundTruth(model, { percent: 45, atMs: CYCLE_START + 30 * HOUR });
    expect(earlier.quota.pace.projectedTotal).toBeCloseTo(1_260_000, 5);
    expect(earlier.quota.pace.runOutAt).toBe(CYCLE_START + Math.round((30 / 0.45) * HOUR));
  });

  it("keeps the reading's time inside the cycle, and not after the dashboard's own", () => {
    const fromTheFuture = applyGroundTruth(model, { percent: 45, atMs: NOW.getTime() + 5 * HOUR });
    expect(fromTheFuture.quota.pace.projectedTotal).toBeCloseTo(630_000, 5);
    const fromLastCycle = applyGroundTruth(model, { percent: 45, atMs: CYCLE_START - 5 * HOUR });
    expect(fromLastCycle.quota.pace.projectedTotal).toBeNull();
  });

  it("accepts 0%: nothing is used, whatever the machines measured", () => {
    const zero = applyGroundTruth(model, { percent: 0, atMs: null });
    expect(zero.calibrated).toBe(true);
    expect(zero.quota.total).toBe(0);
    expect(zero.scale).toBe(0);
    expect(zero.machines.every((m) => m.tokens === 0 && m.limitShare === 0)).toBe(true);
    // The proportions are still there for the share bar.
    expect(zero.groups.map((g) => g.share)).toEqual(model.groups.map((g) => g.share));
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
    expect(view.quota.usedFraction).toBe(0.3);
    expect(view.quota.total).toBe(150_000);
    expect(view.scale).toBeNull();
    expect(view.machines.map((m) => [m.tokens, m.limitShare])).toEqual([[0, 0]]);
  });
});

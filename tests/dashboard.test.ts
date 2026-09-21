import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { buildDashboard, type StoreSnapshot } from "@/lib/dashboard";

const HOUR = 3_600_000;
const config = { ...getConfig({}), weeklyLimit: 500_000 };

// Wednesday 12:00 Budapest time; the cycle started Monday 00:00 (= Sunday 22:00 UTC), 60 h ago.
const NOW = new Date("2026-09-23T10:00:00Z");
const CYCLE_START = Date.parse("2026-09-20T22:00:00Z");

function snapshot(partial: Partial<StoreSnapshot>): StoreSnapshot {
  return { events: [], groups: [], machines: [], ...partial };
}

function report(machineId: string, groupId: string, tokens: number, hoursIntoCycle: number) {
  return { machineId, groupId, tokens, ts: CYCLE_START + hoursIntoCycle * HOUR };
}

describe("buildDashboard — quota and pace", () => {
  it("measures usage against the weekly limit", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        events: [report("win-1", "Work", 150_000, 10), report("mac", "Personal", 100_000, 20)],
      }),
    );
    expect(model.total).toBe(250_000);
    expect(model.usedFraction).toBe(0.5);
    expect(model.remaining).toBe(250_000);
    expect(model.overage).toBe(0);
    expect(model.cycle.elapsedFraction).toBeCloseTo(60 / 168, 10);
  });

  it("warns when the current pace would exhaust the limit before the reset", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({ events: [report("win-1", "Work", 250_000, 10)] }),
    );
    expect(model.pace.projectedTotal).toBeCloseTo(700_000, 5);
    expect(model.status).toBe("warning");
    // Half the limit took 60 h, so the whole limit lasts 120 h.
    expect(model.pace.runOutAt).toBe(CYCLE_START + 120 * HOUR);
  });

  it("is fine when the pace fits the limit", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({ events: [report("win-1", "Work", 100_000, 10)] }),
    );
    expect(model.status).toBe("good");
    expect(model.pace.projectedTotal).toBeCloseTo(280_000, 5);
    expect(model.pace.runOutAt).toBeNull();
  });

  it("warns above 80% even if the pace is fine", () => {
    const lateInCycle = new Date(CYCLE_START + 160 * HOUR);
    const model = buildDashboard(
      lateInCycle,
      config,
      snapshot({ events: [report("win-1", "Work", 410_000, 10)] }),
    );
    expect(model.pace.projectedTotal).toBeLessThan(500_000);
    expect(model.status).toBe("warning");
  });

  it("is critical once the limit is used up", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({ events: [report("win-1", "Work", 560_000, 10)] }),
    );
    expect(model.status).toBe("critical");
    expect(model.remaining).toBe(0);
    expect(model.overage).toBe(60_000);
    expect(model.pace.runOutAt).toBeNull();
  });

  it("does not extrapolate during the first day of a cycle", () => {
    const early = new Date(CYCLE_START + 5 * HOUR);
    const model = buildDashboard(
      early,
      config,
      snapshot({ events: [report("win-1", "Work", 60_000, 2)] }),
    );
    expect(model.pace.projectedTotal).toBeNull();
    expect(model.pace.earlyBurn).toBe(false);
    expect(model.status).toBe("good");
  });

  it("still warns on the first day when usage is far beyond a day's fair share", () => {
    const early = new Date(CYCLE_START + 13 * HOUR);
    // 40% gone in 13 hours; a whole day's even share is only 1/7 ≈ 14%.
    const model = buildDashboard(
      early,
      config,
      snapshot({ events: [report("win-1", "Work", 200_000, 2)] }),
    );
    expect(model.pace.projectedTotal).toBeNull();
    expect(model.pace.earlyBurn).toBe(true);
    expect(model.pace.dailyShare).toBeCloseTo(1 / 7, 10);
    expect(model.status).toBe("warning");
  });

  it("stops flagging an early burn once a real projection is available", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({ events: [report("win-1", "Work", 200_000, 2)] }),
    );
    expect(model.pace.projectedTotal).not.toBeNull();
    expect(model.pace.earlyBurn).toBe(false);
  });

  it("ignores reports from before the current cycle, but totals the previous one", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        events: [
          report("win-1", "Work", 40_000, -30),
          report("mac", "Personal", 2_000, -100),
          report("win-1", "Work", 7_000, 3),
        ],
      }),
    );
    expect(model.total).toBe(7_000);
    expect(model.previousTotal).toBe(42_000);
  });

  it("lays the cycle out as seven day segments from 0 to 1", () => {
    const model = buildDashboard(NOW, config, snapshot({}));
    expect(model.cycle.segments).toHaveLength(7);
    expect(model.cycle.segments[0]?.startFraction).toBe(0);
    expect(model.cycle.segments[6]?.endFraction).toBe(1);
    expect(model.cycle.segments.map((s) => s.weekday)).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });
});

describe("buildDashboard — groups", () => {
  it("gives every group a colour slot by first appearance, not by rank", () => {
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        events: [report("mac", "Personal", 900, 5), report("win-1", "Work", 100, 5)],
        groups: [
          { groupId: "Work", firstSeenAt: 100 },
          { groupId: "Personal", firstSeenAt: 200 },
        ],
      }),
    );
    expect(model.groups.map((g) => [g.groupId, g.colorSlot])).toEqual([
      ["Personal", 2],
      ["Work", 1],
    ]);
    expect(model.groups[0]?.share).toBe(0.9);
    expect(model.groups[0]?.limitShare).toBe(900 / 500_000);
  });

  it("never invents a ninth colour", () => {
    const groups = Array.from({ length: 10 }, (_, i) => ({ groupId: `g${i}`, firstSeenAt: i }));
    const model = buildDashboard(
      NOW,
      config,
      snapshot({ groups, events: groups.map((g) => report("m", g.groupId, 10, 1)) }),
    );
    const slots = Object.fromEntries(model.groups.map((g) => [g.groupId, g.colorSlot]));
    expect(slots.g7).toBe(8);
    expect(slots.g8).toBe(0);
    expect(slots.g9).toBe(0);
  });
});

describe("buildDashboard — machines", () => {
  const known = [
    { machineId: "mac", groupId: "Personal", lastSeenAt: NOW.getTime() - 0.5 * HOUR, lastTokens: 10 },
    { machineId: "win-1", groupId: "Work", lastSeenAt: NOW.getTime() - 5 * HOUR, lastTokens: 0 },
    { machineId: "win-2", groupId: "Work", lastSeenAt: NOW.getTime() - 9 * 24 * HOUR, lastTokens: 0 },
    { machineId: "retired", groupId: "Work", lastSeenAt: NOW.getTime() - 60 * 24 * HOUR, lastTokens: 0 },
  ];

  const model = buildDashboard(
    NOW,
    config,
    snapshot({
      machines: known,
      groups: [
        { groupId: "Work", firstSeenAt: 1 },
        { groupId: "Personal", firstSeenAt: 2 },
      ],
      events: [
        { machineId: "mac", groupId: "Personal", tokens: 300, ts: NOW.getTime() - 0.5 * HOUR },
        { machineId: "win-1", groupId: "Work", tokens: 100, ts: NOW.getTime() - 5 * HOUR },
      ],
    }),
  );

  it("lists reporting machines first, then silent ones with zero usage", () => {
    expect(model.machines.map((m) => [m.machineId, m.tokens])).toEqual([
      ["mac", 300],
      ["win-1", 100],
      ["win-2", 0],
    ]);
  });

  it("drops machines not seen within the retention window", () => {
    expect(model.machines.some((m) => m.machineId === "retired")).toBe(false);
  });

  it("grades freshness from the report interval", () => {
    expect(model.machines.map((m) => m.health)).toEqual(["active", "late", "inactive"]);
  });

  it("colours a machine like its group", () => {
    expect(model.machines.map((m) => m.colorSlot)).toEqual([2, 1, 1]);
  });
});

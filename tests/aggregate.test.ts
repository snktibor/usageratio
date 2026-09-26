import { describe, expect, it } from "vitest";
import { summarizeCost, summarizeUsage, type UsageEvent } from "@/lib/aggregate";

const WINDOW = { startMs: 1000, endMs: 2000 };

function ev(machineId: string, groupId: string, tokens: number, ts: number): UsageEvent {
  return { machineId, groupId, tokens, ts };
}

describe("summarizeUsage — delta mode", () => {
  const events = [
    ev("win-1", "Work", 300, 1999),
    ev("mac", "Personal", 100, 900), // before the window
    ev("mac", "Personal", 50, 1000), // exactly at the start → included
    ev("mac", "Personal", 70, 1500),
    ev("win-1", "Work", 200, 1200),
    ev("win-2", "Work", 25, 2000), // exactly at the end → excluded
  ];
  const summary = summarizeUsage(events, WINDOW, "delta");

  it("adds up only the reports inside the window", () => {
    expect(summary.total).toBe(620);
  });

  it("totals per group, biggest first, with shares of the overall usage", () => {
    expect(summary.groups).toEqual([
      { groupId: "Work", tokens: 500, share: 500 / 620, machines: 1 },
      { groupId: "Personal", tokens: 120, share: 120 / 620, machines: 1 },
    ]);
  });

  it("totals per machine and remembers the latest report", () => {
    expect(summary.series).toEqual([
      { machineId: "win-1", groupId: "Work", tokens: 500, share: 500 / 620, reports: 2, lastReportAt: 1999 },
      { machineId: "mac", groupId: "Personal", tokens: 120, share: 120 / 620, reports: 2, lastReportAt: 1500 },
    ]);
  });
});

describe("summarizeUsage — snapshot mode", () => {
  it("takes the latest in-window report of every machine", () => {
    const summary = summarizeUsage(
      [
        ev("mac", "Personal", 100, 900),
        ev("mac", "Personal", 400, 1800),
        ev("mac", "Personal", 150, 1100),
        ev("win-1", "Work", 80, 1500),
      ],
      WINDOW,
      "snapshot",
    );
    expect(summary.total).toBe(480);
    expect(summary.series.map((s) => [s.machineId, s.tokens])).toEqual([
      ["mac", 400],
      ["win-1", 80],
    ]);
  });

  it("keeps the highest running total when a later report of the cycle sees less", () => {
    // The machine's session logs of the first days were deleted before the last report.
    const summary = summarizeUsage(
      [
        { ...ev("mac", "Personal", 300, 1400), checkpoint: true },
        ev("mac", "Personal", 500, 1500),
        ev("mac", "Personal", 120, 1800),
      ],
      WINDOW,
      "snapshot",
    );
    expect(summary.series[0]).toMatchObject({ tokens: 500, reports: 2, lastReportAt: 1800 });
  });

  it("keeps a higher checkpoint over a later, lower report", () => {
    const summary = summarizeUsage(
      [{ ...ev("mac", "Personal", 300, 1400), checkpoint: true }, ev("mac", "Personal", 200, 1500)],
      WINDOW,
      "snapshot",
    );
    expect(summary.total).toBe(300);
  });

  it("starts over in a new cycle, however high the previous one ended", () => {
    const events = [ev("mac", "Personal", 900, 1900), ev("mac", "Personal", 40, 2100)];
    expect(summarizeUsage(events, WINDOW, "snapshot").total).toBe(900);
    expect(summarizeUsage(events, { startMs: 2000, endMs: 3000 }, "snapshot").total).toBe(40);
  });
});

describe("summarizeUsage — day checkpoints", () => {
  const checkpoint = (tokens: number, ts: number): UsageEvent => ({
    ...ev("mac", "Personal", tokens, ts),
    checkpoint: true,
  });
  const events = [checkpoint(100, 1100), checkpoint(300, 1400), ev("mac", "Personal", 350, 1500)];

  it("does not count them as reports", () => {
    const [series] = summarizeUsage(events, WINDOW, "snapshot").series;
    expect(series).toMatchObject({ tokens: 350, reports: 1, lastReportAt: 1500 });
  });

  it("reads the running total of the last finished day when no report of the window follows it", () => {
    // The report that brought the checkpoint in was already made in the next window.
    const [series] = summarizeUsage(
      [checkpoint(300, 1400), ev("mac", "Personal", 350, 2100)],
      WINDOW,
      "snapshot",
    ).series;
    expect(series).toMatchObject({ tokens: 300, reports: 0, lastReportAt: null });
  });

  it("ignores them outside snapshot mode", () => {
    expect(summarizeUsage(events, WINDOW, "delta").total).toBe(350);
    expect(summarizeUsage([checkpoint(300, 1400)], WINDOW, "counter").series).toEqual([]);
  });
});

describe("summarizeUsage — counter mode", () => {
  const summary = summarizeUsage(
    [
      // Baseline from before the window, then +500, +0, +700.
      ev("mac", "Personal", 10_000, 900),
      ev("mac", "Personal", 10_500, 1100),
      ev("mac", "Personal", 10_500, 1300),
      ev("mac", "Personal", 11_200, 1900),
      // No baseline: the first reading only establishes one, then +300.
      ev("win-1", "Work", 5_000, 1200),
      ev("win-1", "Work", 5_300, 1500),
      // Counter restarted between reports: a drop counts from zero.
      ev("win-2", "Work", 900, 950),
      ev("win-2", "Work", 1_000, 1100),
      ev("win-2", "Work", 200, 1400),
      ev("win-2", "Work", 450, 1700),
    ],
    WINDOW,
    "counter",
  );

  it("adds up the increases between consecutive readings", () => {
    const bySeries = Object.fromEntries(summary.series.map((s) => [s.machineId, s.tokens]));
    expect(bySeries).toEqual({ mac: 1200, "win-1": 300, "win-2": 550 });
    expect(summary.total).toBe(2050);
  });

  it("groups the machines", () => {
    expect(summary.groups.map((g) => [g.groupId, g.tokens, g.machines])).toEqual([
      ["Personal", 1200, 1],
      ["Work", 850, 2],
    ]);
  });
});

describe("summarizeUsage — edge cases", () => {
  it("returns zeros for no data", () => {
    expect(summarizeUsage([], WINDOW, "delta")).toEqual({ total: 0, groups: [], series: [] });
  });

  it("keeps idle machines (only zero-token reports) visible with a 0 share", () => {
    const summary = summarizeUsage([ev("mac", "Personal", 0, 1500)], WINDOW, "delta");
    expect(summary.total).toBe(0);
    expect(summary.series).toEqual([
      { machineId: "mac", groupId: "Personal", tokens: 0, share: 0, reports: 1, lastReportAt: 1500 },
    ]);
  });

  it("treats one machine reporting into two groups as two independent series", () => {
    const summary = summarizeUsage([ev("mac", "Work", 10, 1100), ev("mac", "Personal", 30, 1200)], WINDOW, "delta");
    expect(summary.groups.map((g) => [g.groupId, g.tokens])).toEqual([
      ["Personal", 30],
      ["Work", 10],
    ]);
    expect(summary.series).toHaveLength(2);
  });

  it("breaks ties alphabetically so the order is stable", () => {
    const summary = summarizeUsage([ev("b", "Zeta", 5, 1100), ev("a", "Alpha", 5, 1200)], WINDOW, "delta");
    expect(summary.groups.map((g) => g.groupId)).toEqual(["Alpha", "Zeta"]);
    expect(summary.series.map((s) => s.machineId)).toEqual(["a", "b"]);
  });
});

describe("summarizeCost", () => {
  function withCost(machineId: string, groupId: string, tokens: number, ts: number, costUsd: number): UsageEvent {
    return { ...ev(machineId, groupId, tokens, ts), costUsd };
  }

  it("takes each machine's highest in-window cost reading, always the cycle-to-date snapshot", () => {
    const cost = summarizeCost(
      [
        withCost("mac", "Personal", 100, 900, 1), // before the window
        withCost("mac", "Personal", 400, 1800, 5.5),
        withCost("mac", "Personal", 150, 1100, 2.25),
        withCost("win-1", "Work", 80, 1500, 0.75),
      ],
      WINDOW,
    );
    expect(cost.total).toBe(6.25);
    expect(cost.byMachine).toEqual({ mac: 5.5, "win-1": 0.75 });
    expect(cost.byGroup).toEqual({ Personal: 5.5, Work: 0.75 });
    expect(cost.hasCost).toBe(true);
  });

  it("leaves out a machine that never reported a cost figure, rather than showing it at $0", () => {
    const cost = summarizeCost([ev("mac", "Personal", 500, 1500), withCost("win-1", "Work", 80, 1500, 1.2)], WINDOW);
    expect(cost.byMachine).toEqual({ "win-1": 1.2 });
    expect(cost.hasCost).toBe(true);
  });

  it("reports hasCost false, and empty totals, without a single cost-bearing event", () => {
    const cost = summarizeCost([ev("mac", "Personal", 500, 1500)], WINDOW);
    expect(cost).toEqual({ total: 0, byGroup: {}, byMachine: {}, hasCost: false });
  });

  it("ignores a cost reading from outside the window, even as the machine's baseline", () => {
    // Cost is always snapshot semantics: nothing before startMs ever counts, unlike counter mode's baseline.
    const cost = summarizeCost([withCost("mac", "Personal", 900, 500, 9), withCost("mac", "Personal", 40, 2100, 0.4)], {
      startMs: 1000,
      endMs: 2000,
    });
    expect(cost.hasCost).toBe(false);
  });

  it("sums two machines of the same group", () => {
    const cost = summarizeCost([withCost("a", "Work", 10, 1100, 1), withCost("b", "Work", 20, 1200, 2)], WINDOW);
    expect(cost.byGroup).toEqual({ Work: 3 });
    expect(cost.total).toBe(3);
  });
});

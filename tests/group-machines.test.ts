import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import { applyGroundTruth } from "@/lib/ground-truth";
import { groupMachineChart, machineColors, machinesOfGroup } from "@/lib/group-machines";
import type { ResetEvent } from "@/lib/resets";
import { PRESET_COLORS } from "@/lib/settings";

const HOUR = 3_600_000;
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

const model = buildDashboard(NOW, config, {
  events: [
    report("mac", "Personal", 10_000),
    report("win-1", "Work", 6_000, 5),
    report("win-1", "Work", 12_000, 30),
    report("win-2", "Work", 12_000),
  ],
  groups: [],
  // Silent this cycle, but seen recently enough to stay listed.
  machines: [{ machineId: "win-3", groupId: "Work", lastSeenAt: NOW.getTime() - 100 * HOUR, lastTokens: 0 }],
});
const groupOf = (groups: typeof model.groups, groupId: string) => groups.find((group) => group.groupId === groupId)!;

describe("machinesOfGroup", () => {
  it("keeps only the group's machines, heaviest first, with their share of the group", () => {
    const rows = machinesOfGroup(model.machines, groupOf(model.groups, "Work"));

    expect(rows.map((row) => row.machineId)).toEqual(["win-1", "win-2", "win-3"]);
    expect(rows[0]!.groupShare).toBeCloseTo(0.6);
    expect(rows[1]!.groupShare).toBeCloseTo(0.4);
    // A machine that reported nothing this cycle is still one of the group's.
    expect(rows[2]!.groupShare).toBe(0);
    // Its share of the whole cycle is left as it was.
    expect(rows[0]!.share).toBeCloseTo(0.45);
  });

  it("gives a group's only machine the whole of it", () => {
    const rows = machinesOfGroup(model.machines, groupOf(model.groups, "Personal"));

    expect(rows.map((row) => row.machineId)).toEqual(["mac"]);
    expect(rows[0]!.groupShare).toBe(1);
  });

  it("keeps the measured proportions under an official reading, while the tokens follow it", () => {
    const view = applyGroundTruth(model, { percent: 16, atMs: null });
    const rows = machinesOfGroup(view.machines, groupOf(view.groups, "Work"));

    expect(rows[0]!.groupShare).toBeCloseTo(0.6);
    expect(rows[1]!.groupShare).toBeCloseTo(0.4);
    // 16% of 500k is 80k: twice the 40k measured.
    expect(rows[0]!.tokens).toBeCloseTo(36_000);
  });

  it("reads zero rather than dividing by a group without usage", () => {
    const idle = { ...groupOf(model.groups, "Work"), tokens: 0, share: 0 };
    const machines = model.machines.map((machine) => ({ ...machine, tokens: 0, share: 0 }));

    expect(machinesOfGroup(machines, idle).map((row) => row.groupShare)).toEqual([0, 0, 0]);
  });
});

describe("machineColors", () => {
  const [blue, orange, green, amber] = PRESET_COLORS;

  it("starts with the group's own colour, then the presets no group wears", () => {
    expect(machineColors(3, blue, [blue, orange])).toEqual([blue, green, amber]);
  });

  it("falls back on the other groups' colours only once the free ones are used up", () => {
    const colors = machineColors(PRESET_COLORS.length, blue, [blue, orange]);

    expect(new Set(colors).size).toBe(PRESET_COLORS.length);
    expect(colors[colors.length - 1]).toBe(orange);
  });

  it("keeps a custom group colour, compares colours whatever their case, and repeats past the palette", () => {
    const colors = machineColors(PRESET_COLORS.length + 2, "#ABCDEF", ["#ABCDEF", orange.toUpperCase()]);

    expect(colors[0]).toBe("#ABCDEF");
    expect(colors[1]).toBe(blue);
    expect(colors[PRESET_COLORS.length]).toBe(orange);
    expect(colors[PRESET_COLORS.length + 1]).toBe("#ABCDEF");
  });
});

describe("groupMachineChart", () => {
  const last = model.timeline.times.length - 1;

  it("charts each machine of the group as its share of the token limit, ending on its own figure", () => {
    const view = applyGroundTruth(model, null);
    const { basis, series } = groupMachineChart(model, view, groupOf(view.groups, "Work"));

    expect(basis).toBe("measured");
    expect(series.map((row) => row.machine.machineId)).toEqual(["win-1", "win-2", "win-3"]);
    for (const row of series) {
      expect(row.values).toHaveLength(model.timeline.times.length);
      expect(row.values[last]).toBeCloseTo(row.machine.limitShare!);
    }
    // win-1 reported 6k five hours in, and 12k more at thirty: 1.2%, then 3.6% of the 500k limit.
    expect(series[0]!.values[6]).toBeCloseTo(0.012);
    expect(series[0]!.values[31]).toBeCloseTo(0.036);
    // The machine that reported nothing lies on the axis.
    expect(new Set(series[2]!.values)).toEqual(new Set([0]));
    expect(new Set(series.map((row) => row.color)).size).toBe(3);
    expect(series[0]!.color).toBe(groupOf(view.groups, "Work").color);
  });

  it("splits an official reading among the machines by their measured tokens", () => {
    const view = applyGroundTruth(model, { percent: 16, atMs: null });
    const { basis, series } = groupMachineChart(model, view, groupOf(view.groups, "Work"));

    expect(basis).toBe("official");
    // 16% over the 40k measured: win-1's 18k is 7.2% of the budget, its first 6k 2.4%.
    expect(series[0]!.values[6]).toBeCloseTo(0.024);
    expect(series[0]!.values[last]).toBeCloseTo(0.072);
    expect(series[0]!.values[last]).toBeCloseTo(series[0]!.machine.limitShare!);
    // Every machine of every group together: the official figure itself.
    const all = view.groups.flatMap((group) => groupMachineChart(model, view, group).series);
    expect(all.reduce((sum, row) => sum + row.values[last]!, 0)).toBeCloseTo(0.16);
  });

  it("stays in tokens while neither a token limit nor an official reading tells the budget", () => {
    const unlimited = buildDashboard(
      NOW,
      { ...config, useTokenLimits: false },
      {
        events: [report("win-1", "Work", 18_000), report("win-2", "Work", 12_000)],
        groups: [],
        machines: [],
      },
    );
    const view = applyGroundTruth(unlimited, null);
    const { basis, series } = groupMachineChart(unlimited, view, groupOf(view.groups, "Work"));

    expect(basis).toBe("tokens");
    expect(series.map((row) => row.values[last])).toEqual([18_000, 12_000]);

    // An official reading alone is enough for percentages.
    const official = applyGroundTruth(unlimited, { percent: 30, atMs: null });
    const chart = groupMachineChart(unlimited, official, groupOf(official.groups, "Work"));
    expect(chart.basis).toBe("official");
    expect(chart.series[0]!.values[last]).toBeCloseTo(0.18);
  });
});

describe("groupMachineChart — after a keep reset", () => {
  it("scales a machine's stretch before the reset by that reset's before-figure", () => {
    const R = CYCLE_START + 38 * HOUR;
    const reset: ResetEvent = {
      id: "k",
      atMs: R,
      kind: "keep",
      cycleStartMs: CYCLE_START,
      before: 80,
      beforeAtMs: null,
      source: "manual",
      recordedAtMs: R,
    };
    const withReset = buildDashboard(NOW, config, {
      events: [
        report("win-1", "Work", 30_000, 10),
        report("mac", "Home", 20_000, 20),
        report("win-1", "Work", 12_000, 40),
      ],
      groups: [],
      machines: [],
      resets: [reset],
    });
    const view = applyGroundTruth(withReset, { percent: 6, atMs: null });
    const { series } = groupMachineChart(withReset, view, groupOf(view.groups, "Work"));
    const values = series.find((row) => row.machine.machineId === "win-1")!.values;
    // 30k of the 50k measured before the reset, at its 80%; then 12k of 12k at 6%.
    expect(values[withReset.timeline.times.indexOf(R - 1)]).toBeCloseTo(0.48);
    expect(values.at(-1)).toBeCloseTo(0.06);
  });
});

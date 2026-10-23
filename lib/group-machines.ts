import type { DashboardModel } from "@/lib/dashboard";
import { type DashboardView, timelineRates } from "@/lib/ground-truth";
import { PRESET_COLORS } from "@/lib/settings";

type Group = DashboardModel["groups"][number];
type Machine = DashboardModel["machines"][number];

/** A machine of one group, with its part of that group's usage. */
export type GroupMachine = Machine & {
  /** Fraction of the group's usage, 0–1. */
  groupShare: number;
};

/**
 * The machines of `group`, in the dashboard's own order (heaviest first, the
 * silent ones last), each with its fraction of the group's usage. Taken from
 * the shares rather than the tokens: an official reading restates the tokens
 * (lib/ground-truth.ts) but leaves the measured proportions alone.
 */
export function machinesOfGroup(machines: Machine[], group: Group): GroupMachine[] {
  return machines
    .filter((machine) => machine.groupId === group.groupId)
    .map((machine) => ({ ...machine, groupShare: group.share > 0 ? machine.share / group.share : 0 }));
}

/**
 * A colour for each of `count` machines charted together, in their order. All
 * of them belong to one group, so its colour alone cannot tell them apart:
 * the first keeps it, the next ones take the presets no group on the
 * dashboard wears (a line must not be taken for another group), then the
 * remaining presets; past those the colours repeat.
 */
export function machineColors(count: number, groupColor: string, groupColors: string[]): string[] {
  const own = groupColor.toLowerCase();
  const worn = new Set(groupColors.map((color) => color.toLowerCase()));
  const others = PRESET_COLORS.filter((color) => color !== own);
  const palette = [
    groupColor,
    ...others.filter((color) => !worn.has(color)),
    ...others.filter((color) => worn.has(color)),
  ];
  return Array.from({ length: count }, (_, index) => palette[index % palette.length]!);
}

/** One machine's line on its group's chart. */
export interface GroupMachineSeries {
  machine: GroupMachine;
  color: string;
  /**
   * Cumulative usage at each of `model.timeline.times`, in the chart's
   * `basis`: the last one is the machine's `limitShare`, or its `tokens`.
   */
  values: number[];
}

export interface GroupMachineChart {
  /**
   * What the lines count. Fractions of the budget whenever something tells
   * how much of it is gone: "official" by an official reading, "measured"
   * against the token limit. "tokens" while neither exists.
   */
  basis: "official" | "measured" | "tokens";
  series: GroupMachineSeries[];
}

/**
 * The machines of `group` over the cycle, for the chart that opens under its
 * row. Their measured tokens become a share of the budget at the rates the
 * usage chart uses (lib/ground-truth.ts `timelineRates`), so the machines of
 * all groups add up to the headline percentage, and every line ends on its
 * machine's share of the budget. A machine without usage this
 * cycle keeps its place, as a line on the axis.
 */
export function groupMachineChart(model: DashboardModel, view: DashboardView, group: Group): GroupMachineChart {
  const machines = machinesOfGroup(view.machines, group);
  const colors = machineColors(
    machines.length,
    group.color,
    model.groups.map((other) => other.color),
  );
  // Per measured token at each sample: a finished segment may go at its own before-figure (lib/ground-truth.ts).
  const rates = timelineRates(model, view);
  return {
    basis: rates === null ? "tokens" : view.calibrated ? "official" : "measured",
    series: machines.map((machine, index) => {
      const measured = model.timeline.machines.find(
        (series) => series.groupId === group.groupId && series.machineId === machine.machineId,
      );
      return {
        machine,
        color: colors[index]!,
        values: model.timeline.times.map((_, sample) => (measured?.values[sample] ?? 0) * (rates?.[sample] ?? 1)),
      };
    }),
  };
}

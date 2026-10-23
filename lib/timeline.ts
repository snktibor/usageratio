import { costOfSeriesUntil, groupIntoSeries, type UsageEvent, usageOfSeriesUntil } from "@/lib/aggregate";
import type { TokenMode } from "@/lib/config";
import { modelKey, modelLabel } from "@/lib/models";

/**
 * The cycle's usage over time, for the dashboard's charts: every group's
 * cumulative tokens, sampled on a regular grid from the start of the cycle
 * up to now. The last sample is the current total, exactly what the rest of
 * the dashboard shows. Pure.
 */

const HOUR = 3_600_000;

export interface GroupSeries {
  groupId: string;
  /** Cumulative tokens at each sample time. */
  values: number[];
}

/** One machine's own line within one group: the group's line is the sum of its machines'. */
export interface MachineSeries {
  machineId: string;
  groupId: string;
  /** Cumulative tokens at each sample time. */
  values: number[];
}

export interface ModelTimeline {
  /** The model's id without its snapshot date; see lib/models.ts. */
  modelId: string;
  label: string;
  /** Its tokens in the current segment (the cycle, without keep resets), over all groups. */
  tokens: number;
  groups: GroupSeries[];
  /** Its API-list-price cost estimate in the current segment, over all groups; undefined without a cost split naming it. */
  cost?: number;
}

export interface CycleTimeline {
  /**
   * Sample times, epoch ms: the cycle's start, then every full step, and last
   * the moment of the dashboard; around each keep reset, R − 1 and R as well
   * (`withResetSamples`).
   */
  times: number[];
  /** Cumulative tokens since the segment each sample falls in began: every line restarts from 0 at a keep reset. */
  groups: GroupSeries[];
  /** The machines of those groups with usage this cycle, each within its group; in no particular order. */
  machines: MachineSeries[];
  /** Only models with usage this cycle, the heaviest in the current segment first. */
  models: ModelTimeline[];
}

/**
 * The start, every whole hour after it, and `nowMs` itself as the last
 * sample. Hourly even over a month: the clients report hourly, and a chart
 * zoomed into a day or three shows every hour (lib/chart.ts thins the
 * samples out for a whole-cycle view).
 */
export function sampleTimes(startMs: number, endMs: number, nowMs: number): number[] {
  const stepMs = HOUR;
  const lastMs = Math.min(Math.max(nowMs, startMs), endMs);
  const times: number[] = [];
  for (let t = startMs; t < lastMs; t += stepMs) times.push(t);
  times.push(lastMs);
  return times;
}

/**
 * Where each sample's usage ends: a sample includes the reports made at its
 * very moment; the last one includes all reports up to the end of the cycle
 * (a machine's clock may run a little ahead), so it equals the totals of
 * lib/aggregate.ts.
 */
function sampleEnds(times: number[], window: { endMs: number }): number[] {
  return times.map((t, index) => (index === times.length - 1 ? window.endMs : t + 1));
}

/**
 * `times` with two samples for each keep reset inside them: the moment before
 * it, where a finished segment's lines end on its total, and the reset itself,
 * where they start again from 0. A reset at or before the first sample, or
 * after the last, adds none.
 */
export function withResetSamples(times: number[], resetsMs: number[]): number[] {
  const first = times[0];
  const last = times[times.length - 1];
  if (first === undefined || last === undefined) return times;
  const extra = resetsMs.filter((atMs) => atMs > first && atMs <= last).flatMap((atMs) => [atMs - 1, atMs]);
  return extra.length === 0 ? times : [...new Set([...times, ...extra])].sort((a, b) => a - b);
}

/**
 * One series' usage at each sample (`endsMs`: see `sampleEnds`), counted from
 * the last of `resetsMs` (ascending) at or before the sample: the same
 * difference `summarizeUsage` takes with `fromMs` (lib/aggregate.ts), so the
 * last sample ends on the current segment's figures.
 */
function seriesValues(
  series: UsageEvent[],
  times: number[],
  endsMs: number[],
  startMs: number,
  resetsMs: number[],
  mode: TokenMode,
): number[] {
  const usages = usageOfSeriesUntil(series, startMs, endsMs, mode);
  if (resetsMs.length === 0) return usages;
  const bases = usageOfSeriesUntil(series, startMs, resetsMs, mode);
  return usages.map((usage, index) => {
    const passed = resetsMs.filter((atMs) => atMs <= times[index]!).length;
    return passed === 0 ? usage : usage - bases[passed - 1]!;
  });
}

/** All of `events` together, cumulated at each of `times` exactly as the groups are. */
export function totalTimeline(
  events: UsageEvent[],
  times: number[],
  window: { startMs: number; endMs: number },
  mode: TokenMode,
  resetsMs: number[] = [],
): number[] {
  const endsMs = sampleEnds(times, window);
  const values = times.map(() => 0);
  for (const series of groupIntoSeries(events)) {
    seriesValues(series, times, endsMs, window.startMs, resetsMs, mode).forEach((usage, index) => {
      values[index]! += usage;
    });
  }
  return values;
}

/** Every group's cumulative usage at each of `times`; see `sampleEnds` and `seriesValues`. */
function groupTimelines(
  events: UsageEvent[],
  groupIds: string[],
  times: number[],
  window: { startMs: number; endMs: number },
  mode: TokenMode,
  resetsMs: number[],
): GroupSeries[] {
  const endsMs = sampleEnds(times, window);
  const byGroup = new Map(groupIds.map((groupId) => [groupId, times.map(() => 0)]));

  for (const series of groupIntoSeries(events)) {
    const values = byGroup.get(series[0]!.groupId);
    if (!values) continue;
    seriesValues(series, times, endsMs, window.startMs, resetsMs, mode).forEach((usage, index) => {
      values[index]! += usage;
    });
  }
  return groupIds.map((groupId) => ({ groupId, values: byGroup.get(groupId)! }));
}

/**
 * Every machine's cumulative usage at each of `times`, within each of `groupIds`
 * (a merged machine's carry-over counted into its line). A machine without
 * usage this cycle has no line: its line would lie on the axis. One that used
 * tokens only before a keep reset keeps its line.
 */
function machineTimelines(
  events: UsageEvent[],
  groupIds: string[],
  times: number[],
  window: { startMs: number; endMs: number },
  mode: TokenMode,
  resetsMs: number[],
): MachineSeries[] {
  const endsMs = sampleEnds(times, window);
  const byMachine = new Map<string, MachineSeries>();

  for (const series of groupIntoSeries(events)) {
    const { groupId, machineId } = series[0]!;
    if (!groupIds.includes(groupId)) continue;
    const key = JSON.stringify([groupId, machineId]);
    const machine = byMachine.get(key) ?? { machineId, groupId, values: times.map(() => 0) };
    byMachine.set(key, machine);
    seriesValues(series, times, endsMs, window.startMs, resetsMs, mode).forEach((usage, index) => {
      machine.values[index]! += usage;
    });
  }
  return [...byMachine.values()].filter((machine) => machine.values.some((value) => value > 0));
}

/**
 * A model's reports: every report that came with a split by model, carrying
 * this model's tokens (none, when the split does not list it). Reports without
 * a split say nothing about any model and are left out.
 */
function reportsOfModel(events: UsageEvent[], key: string): UsageEvent[] {
  return events.flatMap((event) => {
    if (!event.models) return [];
    let tokens = 0;
    for (const [modelId, amount] of Object.entries(event.models)) {
      if (modelKey(modelId) === key) tokens += amount;
    }
    return [{ ...event, tokens, models: undefined }];
  });
}

/**
 * A model's cost ($) since `fromMs` (the current segment's start), summed over
 * every machine that named it in a split; undefined when nothing did (no
 * client sent a cost, or none tied this particular model's cost down). Cost
 * is always cycle-to-date snapshot semantics (lib/aggregate.ts
 * `costOfSeriesUntil`), independent of the provider's own token mode.
 */
function modelCostTotal(
  events: UsageEvent[],
  key: string,
  window: { startMs: number; endMs: number },
  fromMs: number,
): number | undefined {
  let total: number | undefined;
  for (const series of groupIntoSeries(events)) {
    const costSeries = series.flatMap((event) => {
      if (!event.modelCosts) return [];
      let cost: number | undefined;
      for (const [modelId, amount] of Object.entries(event.modelCosts)) {
        if (modelKey(modelId) === key) cost = (cost ?? 0) + amount;
      }
      return cost === undefined ? [] : [{ ...event, costUsd: cost }];
    });
    if (costSeries.length === 0) continue;
    const [before, until] = costOfSeriesUntil(costSeries, window.startMs, [fromMs, window.endMs]);
    total = (total ?? 0) + until! - before!;
  }
  return total;
}

/**
 * `events` may reach back before the cycle (counter mode's baseline);
 * `groupIds` are the groups to chart, in the order to chart them. The models
 * come from `modelEvents`: the provider's reports as sent, while `events` may
 * have a separate sub-limit's tokens taken out (lib/sub-limits.ts).
 * `resetsMs` are the cycle's keep resets up to now, ascending (lib/resets.ts):
 * every line restarts from 0 at each, and a model's tokens and cost are the
 * current segment's.
 */
export function buildTimeline(
  events: UsageEvent[],
  groupIds: string[],
  window: { startMs: number; endMs: number },
  nowMs: number,
  mode: TokenMode,
  modelEvents: UsageEvent[] = events,
  resetsMs: number[] = [],
): CycleTimeline {
  const times = withResetSamples(sampleTimes(window.startMs, window.endMs, nowMs), resetsMs);
  const last = times.length - 1;
  const segmentStartMs = resetsMs.at(-1) ?? window.startMs;

  const keys = new Set<string>();
  for (const event of modelEvents) {
    for (const modelId of Object.keys(event.models ?? {})) keys.add(modelKey(modelId));
  }

  const models = [...keys]
    .map((key) => {
      const groups = groupTimelines(reportsOfModel(modelEvents, key), groupIds, times, window, mode, resetsMs);
      const tokens = groups.reduce((sum, group) => sum + group.values[last]!, 0);
      const cost = modelCostTotal(modelEvents, key, window, segmentStartMs);
      return { modelId: key, label: modelLabel(key), tokens, groups, ...(cost !== undefined && { cost }) };
    })
    // A model used only before a reset has none of the segment's tokens, but still a line to draw.
    .filter((model) => model.groups.some((group) => group.values.some((value) => value > 0)))
    .sort((a, b) => b.tokens - a.tokens || a.modelId.localeCompare(b.modelId));

  return {
    times,
    groups: groupTimelines(events, groupIds, times, window, mode, resetsMs),
    machines: machineTimelines(events, groupIds, times, window, mode, resetsMs),
    models,
  };
}

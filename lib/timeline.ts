import { groupIntoSeries, type UsageEvent, usageOfSeriesUntil } from "@/lib/aggregate";
import type { TokenMode } from "@/lib/config";
import { modelKey, modelLabel } from "@/lib/models";

/**
 * The cycle's usage over time, for the dashboard's charts: every group's
 * cumulative tokens, sampled on a regular grid from the start of the cycle
 * up to now. The last sample is the current total, exactly what the rest of
 * the dashboard shows. Pure.
 */

const HOUR = 3_600_000;

/** A chart gets at most about this many samples over a whole cycle (a week: hourly). */
const MAX_SAMPLES = 200;

export interface GroupSeries {
  groupId: string;
  /** Cumulative tokens at each sample time. */
  values: number[];
}

export interface ModelTimeline {
  /** The model's id without its snapshot date; see lib/models.ts. */
  modelId: string;
  label: string;
  /** Its tokens this cycle, over all groups. */
  tokens: number;
  groups: GroupSeries[];
}

export interface CycleTimeline {
  /** Sample times, epoch ms: the cycle's start, then every full step, and last the moment of the dashboard. */
  times: number[];
  groups: GroupSeries[];
  /** Only models with usage this cycle, the heaviest first. */
  models: ModelTimeline[];
}

/** The start, whole steps (of whole hours) after it, and `nowMs` itself as the last sample. */
export function sampleTimes(startMs: number, endMs: number, nowMs: number): number[] {
  const stepMs = HOUR * Math.max(1, Math.ceil((endMs - startMs) / HOUR / MAX_SAMPLES));
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

/** All of `events` together, cumulated at each of `times` exactly as the groups are. */
export function totalTimeline(
  events: UsageEvent[],
  times: number[],
  window: { startMs: number; endMs: number },
  mode: TokenMode,
): number[] {
  const endsMs = sampleEnds(times, window);
  const values = times.map(() => 0);
  for (const series of groupIntoSeries(events)) {
    usageOfSeriesUntil(series, window.startMs, endsMs, mode).forEach((usage, index) => {
      values[index]! += usage;
    });
  }
  return values;
}

/** Every group's cumulative usage at each of `times`; see `sampleEnds`. */
function groupTimelines(
  events: UsageEvent[],
  groupIds: string[],
  times: number[],
  window: { startMs: number; endMs: number },
  mode: TokenMode,
): GroupSeries[] {
  const endsMs = sampleEnds(times, window);
  const byGroup = new Map(groupIds.map((groupId) => [groupId, times.map(() => 0)]));

  for (const series of groupIntoSeries(events)) {
    const values = byGroup.get(series[0]!.groupId);
    if (!values) continue;
    usageOfSeriesUntil(series, window.startMs, endsMs, mode).forEach((usage, index) => {
      values[index]! += usage;
    });
  }
  return groupIds.map((groupId) => ({ groupId, values: byGroup.get(groupId)! }));
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
 * `events` may reach back before the cycle (counter mode's baseline);
 * `groupIds` are the groups to chart, in the order to chart them. The models
 * come from `modelEvents`: the provider's reports as sent, while `events` may
 * have a separate sub-limit's tokens taken out (lib/sub-limits.ts).
 */
export function buildTimeline(
  events: UsageEvent[],
  groupIds: string[],
  window: { startMs: number; endMs: number },
  nowMs: number,
  mode: TokenMode,
  modelEvents: UsageEvent[] = events,
): CycleTimeline {
  const times = sampleTimes(window.startMs, window.endMs, nowMs);
  const last = times.length - 1;

  const keys = new Set<string>();
  for (const event of modelEvents) {
    for (const modelId of Object.keys(event.models ?? {})) keys.add(modelKey(modelId));
  }

  const models = [...keys]
    .map((key) => {
      const groups = groupTimelines(reportsOfModel(modelEvents, key), groupIds, times, window, mode);
      const tokens = groups.reduce((sum, group) => sum + group.values[last]!, 0);
      return { modelId: key, label: modelLabel(key), tokens, groups };
    })
    .filter((model) => model.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || a.modelId.localeCompare(b.modelId));

  return { times, groups: groupTimelines(events, groupIds, times, window, mode), models };
}

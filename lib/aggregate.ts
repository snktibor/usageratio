import type { TokenMode } from "@/lib/config";

/** One stored report. */
export interface UsageEvent {
  machineId: string;
  groupId: string;
  tokens: number;
  /** Event time, epoch ms. */
  ts: number;
  /** `tokens` split by model id, when the client sent the split. */
  models?: Record<string, number>;
  /**
   * An API-list-price estimate of `tokens`, in USD, cycle-to-date, when the
   * client opted into cost (lib/setup.ts COST); absent otherwise, including
   * from every older client and from a checkpoint (lib/days.ts never splits
   * cost by day). Fictional for a subscription plan — never a real bill.
   */
  costUsd?: number;
  /** `costUsd` split by model id, when the client sent one. */
  modelCosts?: Record<string, number>;
  /**
   * Not a report of its own: the machine's running total at the end of a day,
   * from a later report's split by day (lib/days.ts). Only snapshot mode can
   * read a running total, the other modes skip these.
   */
  checkpoint?: boolean;
}

/** `startMs` inclusive, `endMs` exclusive. */
export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/** Usage of one machine within one group (a machine normally has exactly one). */
export interface SeriesUsage {
  machineId: string;
  groupId: string;
  tokens: number;
  /** Fraction of the overall usage, 0–1. */
  share: number;
  /** Reports received inside the window. */
  reports: number;
  lastReportAt: number | null;
}

export interface GroupUsage {
  groupId: string;
  tokens: number;
  /** Fraction of the overall usage, 0–1. */
  share: number;
  /** Machines that reported into this group inside the window. */
  machines: number;
}

export interface UsageSummary {
  total: number;
  groups: GroupUsage[];
  series: SeriesUsage[];
}

/**
 * Tokens one series used from `startMs` up to each of `endsMs` (ascending,
 * exclusive): entry i is the usage inside [startMs, endsMs[i]). `events` are
 * sorted by time and may start before `startMs`.
 */
export function usageOfSeriesUntil(events: UsageEvent[], startMs: number, endsMs: number[], mode: TokenMode): number[] {
  const usages: number[] = [];
  let usage = 0;
  // Counter mode: the last reading before the window is the baseline.
  let previous: number | null = null;

  for (const event of events) {
    while (usages.length < endsMs.length && event.ts >= endsMs[usages.length]!) usages.push(usage);
    if (usages.length === endsMs.length) break;
    if (event.checkpoint && mode !== "snapshot") continue;
    const inWindow = event.ts >= startMs;

    if (mode === "delta") {
      if (inWindow) usage += event.tokens;
    } else if (mode === "snapshot") {
      // A running total never falls within a cycle: a lower reading only means
      // the client lost logs it once counted (e.g. deleted session files).
      if (inWindow) usage = Math.max(usage, event.tokens);
    } else {
      if (inWindow && previous !== null) {
        // A reading below the previous one means the counter restarted from zero.
        usage += event.tokens >= previous ? event.tokens - previous : event.tokens;
      }
      previous = event.tokens;
    }
  }
  while (usages.length < endsMs.length) usages.push(usage);
  return usages;
}

/** Tokens one series used inside the window; `events` sorted by time, may start before the window. */
function usageOfSeries(events: UsageEvent[], window: TimeWindow, mode: TokenMode): number {
  return usageOfSeriesUntil(events, window.startMs, [window.endMs], mode)[0]!;
}

/**
 * Reports split into series: one per group and machine, each sorted by time.
 * Of two readings at the same moment the larger comes last, so snapshot mode
 * reads it: a day's checkpoint sent again after a late log write, or a
 * report made right at midnight next to that day's checkpoint.
 */
export function groupIntoSeries(events: UsageEvent[]): UsageEvent[][] {
  const bySeries = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const key = JSON.stringify([event.groupId, event.machineId]);
    const list = bySeries.get(key);
    if (list) list.push(event);
    else bySeries.set(key, [event]);
  }
  const series = [...bySeries.values()];
  for (const list of series) list.sort((a, b) => a.ts - b.ts || a.tokens - b.tokens);
  return series;
}

/**
 * Aggregates raw reports into per-group and per-machine usage for one window.
 * Pass events from before the window too when available: counter mode uses
 * them as the baseline.
 */
export function summarizeUsage(events: UsageEvent[], window: TimeWindow, mode: TokenMode): UsageSummary {
  const series: SeriesUsage[] = [];
  for (const list of groupIntoSeries(events)) {
    const inWindow = list.filter(
      (e) => e.ts >= window.startMs && e.ts < window.endMs && (!e.checkpoint || mode === "snapshot"),
    );
    const last = inWindow[inWindow.length - 1];
    if (!last) continue;
    const reports = inWindow.filter((e) => !e.checkpoint);
    series.push({
      machineId: last.machineId,
      groupId: last.groupId,
      tokens: usageOfSeries(list, window, mode),
      share: 0,
      reports: reports.length,
      lastReportAt: reports[reports.length - 1]?.ts ?? null,
    });
  }

  const total = series.reduce((sum, s) => sum + s.tokens, 0);

  const groupMap = new Map<string, { tokens: number; machines: Set<string> }>();
  for (const s of series) {
    const group = groupMap.get(s.groupId) ?? { tokens: 0, machines: new Set<string>() };
    group.tokens += s.tokens;
    group.machines.add(s.machineId);
    groupMap.set(s.groupId, group);
    s.share = total > 0 ? s.tokens / total : 0;
  }

  const groups: GroupUsage[] = [...groupMap.entries()].map(([groupId, g]) => ({
    groupId,
    tokens: g.tokens,
    share: total > 0 ? g.tokens / total : 0,
    machines: g.machines.size,
  }));

  groups.sort((a, b) => b.tokens - a.tokens || a.groupId.localeCompare(b.groupId));
  series.sort(
    (a, b) => b.tokens - a.tokens || a.machineId.localeCompare(b.machineId) || a.groupId.localeCompare(b.groupId),
  );

  return { total, groups, series };
}

// ── Cost (an opt-in, API-list-price estimate) ───────────────────────────────

export interface CostSummary {
  total: number;
  byGroup: Record<string, number>;
  byMachine: Record<string, number>;
  /** True when at least one event of the window carried a cost figure at all. */
  hasCost: boolean;
}

/**
 * Cost ($) one series accrued from `startMs` up to each of `endsMs` (ascending,
 * exclusive). Unlike `usageOfSeriesUntil`, this needs no token mode: ccusage's
 * own cost figure is already a cycle-to-date running total (like tokens in
 * "snapshot" mode always are), so a machine's highest in-window reading is
 * its cost, whatever the provider's configured token mode. Events without a
 * cost figure are skipped rather than treated as a reading of zero.
 */
export function costOfSeriesUntil(events: UsageEvent[], startMs: number, endsMs: number[]): number[] {
  const usages: number[] = [];
  let usage = 0;
  for (const event of events) {
    while (usages.length < endsMs.length && event.ts >= endsMs[usages.length]!) usages.push(usage);
    if (usages.length === endsMs.length) break;
    if (event.costUsd !== undefined && event.ts >= startMs) usage = Math.max(usage, event.costUsd);
  }
  while (usages.length < endsMs.length) usages.push(usage);
  return usages;
}

/**
 * The window's cost, by machine and by group, and in total; only over the
 * machines that reported a cost figure at all in the window (a machine that
 * never opted in is simply left out, rather than shown at $0). Mirrors
 * `summarizeUsage`, minus the token-mode/share/report bookkeeping cost has no use for.
 */
export function summarizeCost(events: UsageEvent[], window: TimeWindow): CostSummary {
  let total = 0;
  const byGroup: Record<string, number> = {};
  const byMachine: Record<string, number> = {};
  let hasCost = false;

  for (const series of groupIntoSeries(events)) {
    const inWindow = series.filter((e) => e.ts >= window.startMs && e.ts < window.endMs);
    if (!inWindow.some((e) => e.costUsd !== undefined)) continue;
    hasCost = true;
    const cost = costOfSeriesUntil(series, window.startMs, [window.endMs])[0]!;
    const { machineId, groupId } = series[0]!;
    byMachine[machineId] = (byMachine[machineId] ?? 0) + cost;
    byGroup[groupId] = (byGroup[groupId] ?? 0) + cost;
    total += cost;
  }

  return { total, byGroup, byMachine, hasCost };
}

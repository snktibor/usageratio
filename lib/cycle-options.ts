import type { AppConfig, BudgetPeriod, ResetConfig } from "@/lib/config";
import { type Cycle, getCycle } from "@/lib/cycle";
import { cycleBefore, type ResetEvent } from "@/lib/resets";
import { resetFor } from "@/lib/settings";

/**
 * Which cycles the dashboard can show, and which one a `?cycle=` asks for.
 * Pure.
 *
 * The current cycle, then every earlier one back to the raw reports'
 * retention (RETENTION_DAYS, lib/config.ts) that still has reports: those
 * open in the full dashboard ("detail"). Older cycles, and those from before
 * the first report still stored, are only known from their archived summary
 * (lib/history.ts) and open in a simpler view ("summary"); without one they
 * are not offered at all.
 *
 * The earlier cycles are worked out from today's reset settings. When those
 * changed since (weekly/monthly, the reset day or time, the time zone), the
 * cycles worked out that way no longer match the ones that really ran. An
 * archived cycle knows its own boundaries: where there is one, its `start`
 * and `end` are taken, and a worked-out cycle that overlaps it is dropped.
 *
 * A cycle a restart began (lib/resets.ts) is preceded by the one it cut
 * short, and the cycles before that are worked out from the reset that one ran
 * on.
 */

const DAY_MS = 86_400_000;

export type CycleKind = "current" | "detail" | "summary";

export interface CycleOption {
  startMs: number;
  endMs: number;
  kind: CycleKind;
  /** An archived summary exists for it (for some provider). */
  archived: boolean;
}

export interface CycleOptionsInput {
  now: Date;
  reset: ResetConfig;
  /** Every archived cycle's boundaries, of any provider, in any order; duplicates allowed. */
  archived: { start: number; end: number }[];
  retentionDays: number;
  /** When the oldest report still stored was made (lib/usage-store.ts `loadOldestReportTime`); null: none. */
  oldestReportMs: number | null;
  /** The shared reset: what a restart's cut-short cycle ran on when the provider had no own reset. Default: `reset`. */
  shared?: ResetConfig;
  /** The provider's reset events (lib/resets.ts): a cycle a restart began comes after the one it cut short. */
  resets?: ResetEvent[];
}

const overlaps = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) =>
  a.startMs < b.endMs && b.startMs < a.endMs;

/** Newest first: the current cycle, then the past ones (see the module comment). */
export function listCycleOptions({
  now,
  reset,
  archived,
  retentionDays,
  oldestReportMs,
  shared = reset,
  resets = [],
}: CycleOptionsInput): CycleOption[] {
  const nowMs = now.getTime();
  const cutoffMs = nowMs - retentionDays * DAY_MS;
  // Every report of it is still stored: it began inside the retention, and ended after the oldest report.
  const hasReports = (cycle: { startMs: number; endMs: number }) =>
    cycle.startMs >= cutoffMs && oldestReportMs !== null && cycle.endMs > oldestReportMs;
  const current = getCycle(now, reset);
  const currentStartMs = current.start.getTime();

  // One entry per archived start: providers archive the same cycle alike, the first one read wins.
  const archivedByStart = new Map<number, { startMs: number; endMs: number }>();
  for (const entry of archived) {
    if (entry.end <= entry.start || entry.start >= currentStartMs) continue;
    if (!archivedByStart.has(entry.start)) archivedByStart.set(entry.start, { startMs: entry.start, endMs: entry.end });
  }
  const archivedCycles = [...archivedByStart.values()];

  const computed: { startMs: number; endMs: number }[] = [];
  let cursor: Cycle = current;
  let cursorReset = reset;
  // A month back at most every step; the bound is only a safety net against a zero-length cycle.
  for (let step = 0; step < 400; step++) {
    const before = cycleBefore(cursor, cursorReset, shared, resets);
    const previous = before.cycle;
    if (previous.start.getTime() >= cursor.start.getTime() || previous.start.getTime() < cutoffMs) break;
    computed.push({ startMs: previous.start.getTime(), endMs: previous.end.getTime() });
    cursor = previous;
    cursorReset = before.reset;
  }

  const past = [
    ...archivedCycles.map((cycle) => ({ ...cycle, archived: true })),
    ...computed
      .filter((cycle) => hasReports(cycle) && !archivedCycles.some((entry) => overlaps(entry, cycle)))
      .map((cycle) => ({ ...cycle, archived: false })),
  ]
    .sort((a, b) => b.startMs - a.startMs)
    .map(
      (cycle): CycleOption => ({
        ...cycle,
        kind: hasReports(cycle) ? "detail" : "summary",
      }),
    );

  return [{ startMs: currentStartMs, endMs: current.end.getTime(), kind: "current", archived: false }, ...past];
}

/** A `?cycle=` value: a cycle's start as epoch milliseconds. Anything else reads as none. */
export function parseCycleParam(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !/^\d{1,15}$/.test(value)) return null;
  return Number(value);
}

export interface CycleSelection {
  selected: CycleOption;
  /** The option before it in time, if any: the comparison in the footer. */
  previous: CycleOption | null;
  /** A `?cycle=` was given but names no cycle on offer: the current one is shown instead. */
  unknown: boolean;
}

/** The option `requestedStartMs` names, or the current cycle. `options` as `listCycleOptions` returns them. */
export function selectCycle(options: CycleOption[], requestedStartMs: number | null): CycleSelection {
  const index = requestedStartMs === null ? 0 : options.findIndex((option) => option.startMs === requestedStartMs);
  const at = Math.max(0, index);
  return {
    selected: options[at]!,
    previous: options[at + 1] ?? null,
    unknown: requestedStartMs !== null && index < 0,
  };
}

/** The period a past cycle ran with, from its own length: the settings may have been switched since. */
export function periodOfCycle(cycle: { startMs: number; endMs: number }): BudgetPeriod {
  return cycle.endMs - cycle.startMs > 8 * DAY_MS ? "monthly" : "weekly";
}

/** The cycle the dashboard's `Cycle` type describes. */
export const asCycle = (option: { startMs: number; endMs: number }): Cycle => ({
  start: new Date(option.startMs),
  end: new Date(option.endMs),
});

/** One provider's cycles: its own reset, its own archive. The dashboard offers the selected provider's. */
export function providerCycleOptions({
  now,
  config,
  providerId,
  history,
  oldestReportMs,
  resets = [],
}: {
  now: Date;
  config: AppConfig;
  providerId: string;
  history: { start: number; end: number }[];
  oldestReportMs: number | null;
  resets?: ResetEvent[];
}): CycleOption[] {
  return listCycleOptions({
    now,
    reset: resetFor(config, providerId),
    archived: history,
    retentionDays: config.retentionDays,
    oldestReportMs,
    shared: config.reset,
    resets,
  });
}

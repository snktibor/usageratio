import { groupIntoSeries, summarizeCost, summarizeUsage, type UsageEvent, usageOfSeriesUntil } from "@/lib/aggregate";
import type { TokenMode } from "@/lib/config";
import { parseOfficialPercent } from "@/lib/ground-truth";
import { modelKey } from "@/lib/models";
import { currentOfficialEntries, officialUsageField } from "@/lib/official-usage";
import { type SubLimit, splitBySubLimits } from "@/lib/sub-limits";

/**
 * Archived cycles: once a cycle ends, its shape (total, groups, models,
 * sub-limits, the official percentage) is frozen into a small summary and
 * kept around for a while, so the dashboard can show more than the two
 * cycles Redis still holds raw events for (events are pruned after
 * RETENTION_DAYS; see lib/config.ts and lib/usage-store.ts `storeReport`).
 *
 * Archiving (lib/archive.ts `archiveDueCycles`) runs from two places: every
 * dashboard read (app/[locale]/(dashboard)/page.tsx) and the daily
 * housekeeping run (lib/housekeeping.ts, `history` step), whichever comes
 * first after a cycle ends. For every provider, if the newest archived cycle
 * is older than the previous cycle's start, and that previous cycle actually
 * has events (both callers read events from its start), the previous cycle
 * is summarized from data still in hand and written with `ZADD NX`, so two
 * callers racing each other still write it exactly once. Only the cycle
 * right before the current one can ever be archived this way: by the time a
 * *later* cycle would need to archive an older one, its events are already
 * gone from Redis. With the daily cron in place that no longer depends on
 * anyone opening the dashboard; a host that runs neither the cron nor the
 * dashboard for a whole cycle still loses that cycle's summary.
 *
 * Pure; the Redis side (`archiveCycle`, `loadHistory`, `loadNewestArchivedStarts`)
 * lives in lib/usage-store.ts.
 */

/** How many cycles are kept per provider. */
export const HISTORY_RETENTION = 24;
/** How many of a cycle's models are kept in its summary, the heaviest first. */
export const HISTORY_TOP_MODELS = 8;

export interface CycleSummary {
  v: 1;
  /** Epoch ms, inclusive. */
  start: number;
  /** Epoch ms, exclusive. */
  end: number;
  /** Measured tokens, the provider's own (a separate sub-limit's are not among them). */
  total: number;
  /**
   * The API-list-price cost estimate ($) for the whole cycle, present only
   * when at least one event of it carried one (an opt-in; lib/setup.ts COST).
   */
  cost?: number;
  /** The provider's token limit in that cycle; null while the token limits were off. */
  limit: number | null;
  /** The official percentage (0–100) entered for that cycle; null when none was. */
  official: number | null;
  /** groupId → measured tokens. */
  groups: Record<string, number>;
  /** Distinct machines that reported that cycle. */
  machines: number;
  /** modelKey → measured tokens; the heaviest HISTORY_TOP_MODELS only. */
  models: Record<string, number>;
  /** subLimitId → measured tokens. */
  subLimits: Record<string, number>;
  /**
   * When this summary was written. Callers should pass a value that only
   * depends on which cycle is being archived (its own end time is a good
   * choice), not the wall-clock time of the call: `archiveCycle`'s `ZADD NX`
   * dedupes by the member's exact bytes, so two renders racing to archive the
   * same cycle only write one entry when this field (like every other one) is
   * deterministic between them.
   */
  archivedAt: number;
}

export interface SummarizeCycleInput {
  /** The provider's reports as sent, before any sub-limit split (lib/usage-store.ts `loadEvents`). */
  events: UsageEvent[];
  window: { startMs: number; endMs: number };
  mode: TokenMode;
  limit: number | null;
  official: number | null;
  subLimits: SubLimit[];
  archivedAt: number;
}

/** Everything measured in `events` up to `window.endMs`, one number (lib/aggregate.ts, one sample). */
function totalOf(events: UsageEvent[], window: { startMs: number; endMs: number }, mode: TokenMode): number {
  let total = 0;
  for (const series of groupIntoSeries(events)) {
    total += usageOfSeriesUntil(series, window.startMs, [window.endMs], mode)[0]!;
  }
  return total;
}

/** A model's reports: only those with a split, filtered to its tokens (mirrors lib/timeline.ts `reportsOfModel`). */
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
 * The cycle's summary, measured the same way the live dashboard does
 * (lib/dashboard.ts `buildDashboard`, lib/timeline.ts). Pure.
 */
export function summarizeCycle(input: SummarizeCycleInput): CycleSummary {
  const { events, window, mode, limit, official, subLimits, archivedAt } = input;
  const split = splitBySubLimits(events, subLimits);
  const usage = summarizeUsage(split.main, window, mode);
  const cost = summarizeCost(split.main, window);

  // The model breakdown looks at every report as sent, same as the live model chart: a
  // separate sub-limit's models are still worth showing here, even though they are not in `total`.
  const modelKeys = new Set<string>();
  for (const event of events) for (const modelId of Object.keys(event.models ?? {})) modelKeys.add(modelKey(modelId));
  const models = [...modelKeys]
    .map((key): [string, number] => [key, totalOf(reportsOfModel(events, key), window, mode)])
    .filter(([, tokens]) => tokens > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, HISTORY_TOP_MODELS);

  const subLimitTotals = Object.fromEntries(
    subLimits.map((sub) => [sub.id, totalOf(split.bySubLimit.get(sub.id) ?? [], window, mode)]),
  );

  return {
    v: 1,
    start: window.startMs,
    end: window.endMs,
    total: usage.total,
    ...(cost.hasCost && { cost: cost.total }),
    limit,
    official,
    groups: Object.fromEntries(usage.groups.map((g) => [g.groupId, g.tokens])),
    machines: new Set(usage.series.map((s) => s.machineId)).size,
    models: Object.fromEntries(models),
    subLimits: subLimitTotals,
    archivedAt,
  };
}

/**
 * The official percentage (0–100) typed for `providerId` in the cycle that
 * starts at `cycleStartMs`; null when none was, or the stored text does not
 * parse. `usage:official` entries are tagged with the cycle they were typed
 * in (lib/official-usage.ts): an entry from a different cycle — including the
 * one that came right after — does not apply here, same as it stops applying
 * to the live dashboard once that cycle is no longer current.
 */
export function officialPercentForCycle(
  rawOfficialUsage: Record<string, string>,
  providerId: string,
  cycleStartMs: number,
): number | null {
  const entry = currentOfficialEntries(rawOfficialUsage, cycleStartMs).get(officialUsageField(providerId, null));
  return entry ? parseOfficialPercent(entry.raw).percent : null;
}

// ── (De)serialization ────────────────────────────────────────────────────────

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((amount) => isFiniteNumber(amount))
  );
}

export function serializeCycleSummary(summary: CycleSummary): string {
  return JSON.stringify(summary);
}

/** A stored member, read leniently: anything damaged (hand-edited Redis, a future format) reads back as null. */
export function parseCycleSummary(raw: string): CycleSummary | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { v, start, end, total, cost, limit, official, groups, machines, models, subLimits, archivedAt } =
    value as Record<string, unknown>;
  if (v !== 1) return null;
  if (!isFiniteNumber(start) || !isFiniteNumber(end) || !isFiniteNumber(total)) return null;
  if (cost !== undefined && !isFiniteNumber(cost)) return null;
  if (limit !== null && !isFiniteNumber(limit)) return null;
  if (official !== null && !isFiniteNumber(official)) return null;
  if (!isNumberRecord(groups) || !isNumberRecord(models) || !isNumberRecord(subLimits)) return null;
  if (!isFiniteNumber(machines) || !isFiniteNumber(archivedAt)) return null;
  return {
    v: 1,
    start,
    end,
    total,
    ...(cost !== undefined && { cost }),
    limit: limit as number | null,
    official: official as number | null,
    groups,
    machines,
    models,
    subLimits,
    archivedAt,
  };
}

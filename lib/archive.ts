import type { UsageEvent } from "@/lib/aggregate";
import { ledgerEntryOf } from "@/lib/all-time";
import { type AppConfig, getConfig } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import {
  type CycleSummary,
  officialPercentForCycle,
  parseCycleSummary,
  serializeCycleSummary,
  summarizeCycle,
  withRederivedTokens,
} from "@/lib/history";
import { log } from "@/lib/log";
import { earliestStartMs, providerCycle } from "@/lib/provider-cycles";
import {
  cycleBefore,
  keepResetsOf,
  type ProviderResets,
  type ResetEvent,
  resetEventsOf,
  restartStarting,
} from "@/lib/resets";
import { configForProvider, countsForProvider, resetFor, resolveConfig, subLimitsOf } from "@/lib/settings";
import type { TenantStore } from "@/lib/tenant";
import { archiveCycle, loadEvents, loadIndexes, loadNewestArchivedStarts, type StoreIndexes } from "@/lib/usage-store";

export interface ArchiveInput {
  providerIds: string[];
  config: AppConfig;
  now: Date;
  /** Must reach back to the earliest previous cycle (lib/provider-cycles.ts `earliestStartMs(…, "previous")`). */
  eventsByProvider: Record<string, UsageEvent[]>;
  /** The raw `usage:official` hash, for the previous cycle's typed-in percentage. */
  rawOfficialUsage: Record<string, string>;
  /** Every provider's resets (`loadIndexes(store).resets`): a restart's cut-short cycle, keep resets' segments. */
  resets: Record<string, ProviderResets>;
  /** Only report which providers are due; write nothing. */
  dryRun?: boolean;
}

/**
 * One provider's cycle `window`, summarized the way it is archived: only the
 * groups it counts, its token limit while the limits are on, the official
 * figure typed in its last segment (or the before-figure of the restart that
 * cut it short at `window.endMs`), its keep resets' segments. The dashboard
 * also runs it on the current cycle, for the all-time totals (lib/all-time.ts).
 */
export function summarizeProviderCycle({
  providerId,
  config,
  events,
  window,
  rawOfficialUsage,
  resetEvents,
  keepResets,
}: {
  providerId: string;
  config: AppConfig;
  /** The provider's reports, any group. */
  events: UsageEvent[];
  window: { startMs: number; endMs: number };
  rawOfficialUsage: Record<string, string>;
  resetEvents: ResetEvent[];
  /** The keep resets that split the window, when `resetEvents` no longer hold them (a pruned archived cycle's own, from its segments). */
  keepResets?: { atMs: number; before: number | null }[];
}): CycleSummary {
  const counts = (groupId: string) => countsForProvider(config.excludedProviders, groupId, providerId);
  const providerConfig = configForProvider(config, providerId);
  const keep = keepResets ?? keepResetsOf(window, resetEvents);
  // A cycle a restart cut short ended on the restart's before-figure; else its last segment's figure.
  const cut = restartStarting(resetEvents, window.endMs);
  const lastStartMs = keep.at(-1)?.atMs ?? window.startMs;
  return summarizeCycle({
    events: events.filter((event) => counts(event.groupId)),
    window,
    mode: config.tokenMode,
    limit: config.useTokenLimits ? providerConfig.limit : null,
    official: cut?.before ?? officialPercentForCycle(rawOfficialUsage, providerId, lastStartMs),
    subLimits: subLimitsOf(config, providerId),
    archivedAt: window.endMs,
    keepResets: keep.map(({ atMs, before }) => ({ atMs, before })),
    endedByReset: cut !== undefined,
  });
}

/**
 * Archives the cycle right before the current one, for every provider whose
 * newest archived cycle is older than it and that has events in it. Two
 * callers share this: the dashboard render (lazily, on the first visit after a
 * cycle ends) and the daily housekeeping run (`history` step), so a cycle is
 * archived even when nobody opens the dashboard for a whole cycle.
 *
 * `archivedAt` is the cycle's own end time, not the wall-clock time of the
 * run: two callers racing each other build the very same summary bytes, so
 * `ZADD NX` truly dedupes them into one entry rather than adding a second one
 * that only differs by when each happened to run. See lib/history.ts for why
 * only this one cycle can be archived this way, and for `summarizeCycle`.
 * Each provider's cycles are its own (lib/provider-cycles.ts): the shared
 * reset, or the provider's override. A cycle a restart cut short (lib/resets.ts)
 * is archived as `[S, R)`, marked `endedByReset`; a cycle with keep resets
 * carries its segments.
 *
 * Best-effort per provider: a failure is logged and skipped, never thrown, so
 * one bad provider neither breaks the dashboard nor the rest of the run.
 * Returns the ids of the providers that were due (and, unless `dryRun`, archived).
 */
export async function archiveDueCycles(
  store: TenantStore,
  { providerIds, config, now, eventsByProvider, rawOfficialUsage, resets, dryRun = false }: ArchiveInput,
): Promise<string[]> {
  if (providerIds.length === 0) return [];
  const newestStarts = await loadNewestArchivedStarts(store, providerIds);
  const windowOf = (providerId: string) => {
    const { cycle, previous } = providerCycle(now, config, providerId, resetEventsOf(resets, providerId));
    return { previousStartMs: previous.start.getTime(), cycleStartMs: cycle.start.getTime() };
  };

  const due = providerIds.filter((providerId) => {
    const { previousStartMs, cycleStartMs } = windowOf(providerId);
    const newest = newestStarts[providerId];
    if (newest !== null && newest !== undefined && newest >= previousStartMs) return false;
    return (eventsByProvider[providerId] ?? []).some((event) => event.ts >= previousStartMs && event.ts < cycleStartMs);
  });
  if (due.length === 0 || dryRun) return due;

  const archived = await Promise.all(
    due.map(async (providerId) => {
      try {
        const { previousStartMs, cycleStartMs } = windowOf(providerId);
        const summary = summarizeProviderCycle({
          providerId,
          config,
          events: eventsByProvider[providerId] ?? [],
          window: { startMs: previousStartMs, endMs: cycleStartMs },
          rawOfficialUsage,
          resetEvents: resetEventsOf(resets, providerId),
        });
        await archiveCycle(store, providerId, summary);
        return providerId;
      } catch (error) {
        log.error("history.archive_failed", { providerId, err: error });
        return null;
      }
    }),
  );
  return archived.filter((providerId): providerId is string => providerId !== null);
}

/**
 * Archives the just-ended cycle now, before a change that would leave its summary without part of
 * its data: a group or provider force-delete, a group merge, or a new restart (which makes the
 * cycle before the current one a different window, so the one that is archived-next today can
 * never be archived at all). Reads like the housekeeping step and is best effort per provider like
 * `archiveDueCycles`; a provider already archived, or without events in that cycle, is left alone.
 *
 * `providerIds` narrows it to the providers the change touches (default: every provider the store
 * knows); `indexes` reuses a read the caller already made. A read that fails throws, so a route
 * answers 503 before anything is changed. Returns the ids of the providers it archived.
 */
export async function archiveBeforeChange(
  store: TenantStore,
  now: Date,
  options: { providerIds?: string[]; indexes?: StoreIndexes } = {},
): Promise<string[]> {
  const indexes = options.indexes ?? (await loadIndexes(store));
  const allProviderIds = indexes.providers.map((provider) => provider.providerId);
  const wanted = options.providerIds;
  const providerIds = wanted ? allProviderIds.filter((providerId) => wanted.includes(providerId)) : allProviderIds;
  if (providerIds.length === 0) return [];

  const config = resolveConfig(getConfig(), indexes.settings, allProviderIds);
  const { eventsByProvider } = await loadEvents(
    store,
    providerIds,
    indexes.groups,
    earliestStartMs(now, config, providerIds, "previous"),
    indexes.resets,
  );
  return archiveDueCycles(store, {
    providerIds,
    config,
    now,
    eventsByProvider,
    rawOfficialUsage: indexes.officialUsage,
    resets: indexes.resets,
  });
}

/** How many windows `rederiveArchivedCycles` looks back for a cycle that was never archived: well past the ~5 a 30-day trash can span. */
const MAX_MISSING_WINDOWS = 12;

/**
 * After a restore from the trash: summarizes again the cycles archived while the restored data was
 * away, for each of `providerIds` the restore touched. `archiveCycle` is `ZADD NX` / `HSETNX`, so
 * a summary written without the deleted group's (or provider's) reports would stay without them
 * for good; every archived summary of a cycle that ended after `sinceMs` (the delete) is built
 * again from the reports stored now, and replaces the old one when its bytes differ
 * (`withRederivedTokens` keeps what cannot be worked out again: the official figures, the limit,
 * `archivedAt`). The all-time ledger entry goes with it, in the same transaction.
 *
 * With `archiveMissing` (a provider restore: while it was deleted nothing archived it) the cycles
 * that ended after `sinceMs` and have no summary but reports are archived too, worked out
 * backwards from the current cycle (`cycleBefore`, so a restart's cut-short cycle is right); their
 * official figure is the restored `usage:official` entry when it belongs to the window, else null.
 *
 * Best effort per provider, like `archiveDueCycles`: a failure is logged (`trash.rederive_failed`)
 * and skipped, never thrown, since the restore it follows has already committed. Returns how many
 * summaries it wrote.
 */
export async function rederiveArchivedCycles(
  store: TenantStore,
  providerIds: string[],
  sinceMs: number,
  now: Date,
  options: { archiveMissing?: boolean } = {},
): Promise<number> {
  if (providerIds.length === 0) return 0;
  let written = 0;
  try {
    const indexes = await loadIndexes(store);
    const config = resolveConfig(
      getConfig(),
      indexes.settings,
      indexes.providers.map((provider) => provider.providerId),
    );
    for (const providerId of providerIds) {
      try {
        written += await rederiveProvider(store, indexes, config, providerId, sinceMs, now, options.archiveMissing);
      } catch (error) {
        log.error("trash.rederive_failed", { providerId, err: error });
      }
    }
  } catch (error) {
    log.error("trash.rederive_failed", { err: error });
  }
  return written;
}

async function rederiveProvider(
  store: TenantStore,
  indexes: StoreIndexes,
  config: AppConfig,
  providerId: string,
  sinceMs: number,
  now: Date,
  archiveMissing = false,
): Promise<number> {
  const historyKey = store.keys.history(providerId);
  const stored = (await store.redis.zrange(historyKey, 0, -1))
    .map((member) => parseCycleSummary(String(member)))
    .filter((entry): entry is CycleSummary => entry !== null);
  const due = stored.filter((entry) => entry.end > sinceMs);

  const resetEvents = resetEventsOf(indexes.resets, providerId);
  const missing: { startMs: number; endMs: number }[] = [];
  if (archiveMissing) {
    const own = resetFor(config, providerId);
    let step = cycleBefore(getCycle(now, own), own, config.reset, resetEvents);
    for (let i = 0; i < MAX_MISSING_WINDOWS && step.cycle.end.getTime() > sinceMs; i += 1) {
      const window = { startMs: step.cycle.start.getTime(), endMs: step.cycle.end.getTime() };
      if (!stored.some((entry) => entry.start === window.startMs)) missing.push(window);
      step = cycleBefore(step.cycle, step.reset, config.reset, resetEvents);
    }
  }
  if (due.length === 0 && missing.length === 0) return 0;

  const { eventsByProvider } = await loadEvents(
    store,
    [providerId],
    indexes.groups,
    Math.min(...due.map((entry) => entry.start), ...missing.map((window) => window.startMs)),
    indexes.resets,
  );
  const events = eventsByProvider[providerId]!;

  const tx = store.redis.multi();
  let written = 0;
  for (const old of due) {
    const fresh = summarizeProviderCycle({
      providerId,
      config,
      events,
      window: { startMs: old.start, endMs: old.end },
      rawOfficialUsage: indexes.officialUsage,
      resetEvents,
      // The cycle's own keep resets are pruned once it is archived: its segments say where they were.
      keepResets: old.segments?.slice(0, -1).map((segment) => ({ atMs: segment.end, before: segment.official })),
    });
    const next = withRederivedTokens(old, fresh);
    if (serializeCycleSummary(next) === serializeCycleSummary(old)) continue;
    tx.zremrangebyscore(historyKey, old.start, old.start);
    tx.zadd(historyKey, { score: old.start, member: serializeCycleSummary(next) });
    tx.hset(store.keys.allTime(providerId), { [String(old.start)]: serializeCycleSummary(ledgerEntryOf(next)) });
    written += 1;
  }
  if (written > 0) {
    tx.sadd(store.keys.registry, historyKey, store.keys.allTime(providerId));
    await tx.exec();
  }

  for (const window of missing) {
    if (!events.some((event) => event.ts >= window.startMs && event.ts < window.endMs)) continue;
    const summary = summarizeProviderCycle({
      providerId,
      config,
      events,
      window,
      rawOfficialUsage: indexes.officialUsage,
      resetEvents,
    });
    written += Number(await archiveCycle(store, providerId, summary));
  }
  return written;
}

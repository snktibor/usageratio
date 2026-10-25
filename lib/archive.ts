import type { UsageEvent } from "@/lib/aggregate";
import type { AppConfig } from "@/lib/config";
import { type CycleSummary, officialPercentForCycle, summarizeCycle } from "@/lib/history";
import { log } from "@/lib/log";
import { providerCycle } from "@/lib/provider-cycles";
import { keepResetsOf, type ProviderResets, type ResetEvent, resetEventsOf, restartStarting } from "@/lib/resets";
import { configForProvider, countsForProvider, subLimitsOf } from "@/lib/settings";
import { archiveCycle, loadNewestArchivedStarts } from "@/lib/usage-store";

export interface ArchiveInput {
  providerIds: string[];
  config: AppConfig;
  now: Date;
  /** Must reach back to the earliest previous cycle (lib/provider-cycles.ts `earliestStartMs(…, "previous")`). */
  eventsByProvider: Record<string, UsageEvent[]>;
  /** The raw `usage:official` hash, for the previous cycle's typed-in percentage. */
  rawOfficialUsage: Record<string, string>;
  /** Every provider's resets (`loadIndexes().resets`): a restart's cut-short cycle, keep resets' segments. */
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
}: {
  providerId: string;
  config: AppConfig;
  /** The provider's reports, any group. */
  events: UsageEvent[];
  window: { startMs: number; endMs: number };
  rawOfficialUsage: Record<string, string>;
  resetEvents: ResetEvent[];
}): CycleSummary {
  const counts = (groupId: string) => countsForProvider(config.excludedProviders, groupId, providerId);
  const providerConfig = configForProvider(config, providerId);
  const keep = keepResetsOf(window, resetEvents);
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
export async function archiveDueCycles({
  providerIds,
  config,
  now,
  eventsByProvider,
  rawOfficialUsage,
  resets,
  dryRun = false,
}: ArchiveInput): Promise<string[]> {
  if (providerIds.length === 0) return [];
  const newestStarts = await loadNewestArchivedStarts(providerIds);
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
        await archiveCycle(providerId, summary);
        return providerId;
      } catch (error) {
        log.error("history.archive_failed", { providerId, err: error });
        return null;
      }
    }),
  );
  return archived.filter((providerId): providerId is string => providerId !== null);
}

import type { UsageEvent } from "@/lib/aggregate";
import type { AppConfig } from "@/lib/config";
import type { Cycle } from "@/lib/cycle";
import { officialPercentForCycle, summarizeCycle } from "@/lib/history";
import { log } from "@/lib/log";
import { configForProvider, countsForProvider, subLimitsOf } from "@/lib/settings";
import { archiveCycle, loadNewestArchivedStarts } from "@/lib/usage-store";

export interface ArchiveInput {
  providerIds: string[];
  config: AppConfig;
  cycle: Cycle;
  previousCycle: Cycle;
  /** Must reach back at least to `previousCycle.start` (`loadEvents(…, previousCycle.start)`). */
  eventsByProvider: Record<string, UsageEvent[]>;
  /** The raw `usage:official` hash, for the previous cycle's typed-in percentage. */
  rawOfficialUsage: Record<string, string>;
  /** Only report which providers are due; write nothing. */
  dryRun?: boolean;
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
 *
 * Best-effort per provider: a failure is logged and skipped, never thrown, so
 * one bad provider neither breaks the dashboard nor the rest of the run.
 * Returns the ids of the providers that were due (and, unless `dryRun`, archived).
 */
export async function archiveDueCycles({
  providerIds,
  config,
  cycle,
  previousCycle,
  eventsByProvider,
  rawOfficialUsage,
  dryRun = false,
}: ArchiveInput): Promise<string[]> {
  if (providerIds.length === 0) return [];
  const previousStartMs = previousCycle.start.getTime();
  const cycleStartMs = cycle.start.getTime();
  const newestStarts = await loadNewestArchivedStarts(providerIds);

  const due = providerIds.filter((providerId) => {
    const newest = newestStarts[providerId];
    if (newest !== null && newest !== undefined && newest >= previousStartMs) return false;
    return (eventsByProvider[providerId] ?? []).some((event) => event.ts >= previousStartMs && event.ts < cycleStartMs);
  });
  if (due.length === 0 || dryRun) return due;

  const archived = await Promise.all(
    due.map(async (providerId) => {
      try {
        const counts = (groupId: string) => countsForProvider(config.excludedProviders, groupId, providerId);
        const providerConfig = configForProvider(config, providerId);
        const summary = summarizeCycle({
          events: (eventsByProvider[providerId] ?? []).filter((event) => counts(event.groupId)),
          window: { startMs: previousStartMs, endMs: cycleStartMs },
          mode: config.tokenMode,
          limit: config.useTokenLimits ? providerConfig.limit : null,
          official: officialPercentForCycle(rawOfficialUsage, providerId, previousStartMs),
          subLimits: subLimitsOf(config, providerId),
          archivedAt: cycleStartMs,
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

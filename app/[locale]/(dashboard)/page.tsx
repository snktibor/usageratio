import { cookies } from "next/headers";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Dashboard } from "@/components/dashboard";
import { PinGate } from "@/components/pin-gate";
import { StorageProblem } from "@/components/storage-problem";
import { routing } from "@/i18n/routing";
import type { UsageEvent } from "@/lib/aggregate";
import { isAuthenticated } from "@/lib/auth";
import { currentTime } from "@/lib/clock";
import { type AppConfig, getConfig } from "@/lib/config";
import { type Cycle, getCycle, getPreviousCycle } from "@/lib/cycle";
import { buildProviderDashboards, type ProviderDashboardModel } from "@/lib/dashboard";
import { ensureDemoData } from "@/lib/demo/seed";
import { type CycleSummary, officialPercentForCycle, summarizeCycle } from "@/lib/history";
import { log } from "@/lib/log";
import { modelKeysIn } from "@/lib/models";
import { currentOfficialEntries } from "@/lib/official-usage";
import { PROVIDER_COOKIE } from "@/lib/preferences";
import { mergeProviderIds } from "@/lib/providers";
import { StorageNotConfiguredError } from "@/lib/redis";
import {
  buildSettingsView,
  configForProvider,
  countsForProvider,
  resolveConfig,
  type SettingsView,
  storedProviderIds,
  subLimitsOf,
} from "@/lib/settings";
import { archiveCycle, loadEvents, loadHistory, loadIndexes, loadNewestArchivedStarts } from "@/lib/usage-store";

// Rendered per request: the page depends on the session cookie and on live data.
export const dynamic = "force-dynamic";

interface DashboardData {
  providers: ProviderDashboardModel[];
  settings: SettingsView;
  historyByProvider: Record<string, CycleSummary[]>;
}

/**
 * Lazy archiving of the cycle right before the current one: on a dashboard
 * read, once it is no longer the newest archived cycle for a provider (and it
 * actually has events — it does here, since `loadEvents` above already reads
 * from its start), it is summarized and written with `ZADD NX`. `archivedAt`
 * is the cycle's own end time, not the wall-clock time of this render: two
 * renders racing each other build the very same summary bytes, so `ZADD NX`
 * truly dedupes them into one entry rather than adding a second one that only
 * differs by when each happened to run. See lib/history.ts for why only this
 * one cycle can be archived this way, and for `summarizeCycle`. Best-effort: a
 * failure here is logged, never turned into a broken dashboard.
 */
async function archivePreviousCycle(
  providerIds: string[],
  config: AppConfig,
  cycle: Cycle,
  previousCycle: Cycle,
  eventsByProvider: Record<string, UsageEvent[]>,
  rawOfficialUsage: Record<string, string>,
): Promise<void> {
  if (providerIds.length === 0) return;
  const previousStartMs = previousCycle.start.getTime();
  const newestStarts = await loadNewestArchivedStarts(providerIds);

  const due = providerIds.filter((providerId) => {
    const newest = newestStarts[providerId];
    if (newest !== null && newest !== undefined && newest >= previousStartMs) return false;
    return (eventsByProvider[providerId] ?? []).some(
      (event) => event.ts >= previousStartMs && event.ts < cycle.start.getTime(),
    );
  });
  if (due.length === 0) return;

  await Promise.all(
    due.map(async (providerId) => {
      try {
        const counts = (groupId: string) => countsForProvider(config.excludedProviders, groupId, providerId);
        const providerConfig = configForProvider(config, providerId);
        const official = officialPercentForCycle(rawOfficialUsage, providerId, previousStartMs);
        const summary = summarizeCycle({
          events: (eventsByProvider[providerId] ?? []).filter((event) => counts(event.groupId)),
          window: { startMs: previousStartMs, endMs: cycle.start.getTime() },
          mode: config.tokenMode,
          limit: config.useTokenLimits ? providerConfig.limit : null,
          official,
          subLimits: subLimitsOf(config, providerId),
          archivedAt: cycle.start.getTime(),
        });
        await archiveCycle(providerId, summary);
      } catch (error) {
        log.error("dashboard.archive_failed", { providerId, err: error });
      }
    }),
  );
}

/** Two round trips: the saved settings decide the cycle, the cycle decides which reports to read. */
async function loadDashboard(): Promise<DashboardData> {
  const now = currentTime();
  // Demo mode only: reseeds the synthetic data once it has gone stale.
  await ensureDemoData(now);
  const indexes = await loadIndexes();
  const providerIds = mergeProviderIds(
    indexes.providers.map((provider) => provider.providerId),
    storedProviderIds(indexes.settings),
  );
  const config = resolveConfig(getConfig(), indexes.settings, providerIds);

  const cycle = getCycle(now, config.reset);
  const previousCycle = getPreviousCycle(cycle, config.reset);
  // The previous cycle rides along: it is the footer's comparison and counter mode's baseline.
  const since = previousCycle.start.getTime();
  const { eventsByProvider, groups } = await loadEvents(providerIds, indexes.groups, since);
  // The reset is shared by every provider, so one cycle start also tells which stored ground-truth figures still apply.
  const officialUsage = currentOfficialEntries(indexes.officialUsage, cycle.start.getTime());

  await archivePreviousCycle(providerIds, config, cycle, previousCycle, eventsByProvider, indexes.officialUsage);
  const historyByProvider = await loadHistory(providerIds);

  return {
    providers: buildProviderDashboards(
      now,
      config,
      providerIds,
      { eventsByProvider, groups, machines: indexes.machines },
      officialUsage,
    ),
    // The models seen lately, for picking a sub-limit's on the settings panel.
    settings: buildSettingsView(
      config,
      groups,
      providerIds,
      Object.fromEntries(
        Object.entries(eventsByProvider).map(([providerId, events]) => [providerId, modelKeysIn(events)]),
      ),
    ),
    historyByProvider,
  };
}

/**
 * The cookie's provider first, so the dashboard renders the last-selected one
 * from the very first paint (see components/dashboard-view.tsx: it reads the
 * order, not the cookie, so the client and the server always agree).
 */
function withSelectedProviderFirst(
  providers: ProviderDashboardModel[],
  selectedId: string | undefined,
): ProviderDashboardModel[] {
  const index = selectedId ? providers.findIndex((provider) => provider.id === selectedId) : -1;
  if (index <= 0) return providers;
  return [providers[index]!, ...providers.slice(0, index), ...providers.slice(index + 1)];
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);

  let data: DashboardData | null = null;
  let storageError: unknown = null;

  try {
    // Usage data and settings are only ever read after the session check passed.
    if (await isAuthenticated()) data = await loadDashboard();
  } catch (error) {
    storageError = error;
    log.error("dashboard.load_failed", { err: error });
  }

  if (storageError) {
    return <StorageProblem notConfigured={storageError instanceof StorageNotConfiguredError} />;
  }
  if (!data) return <PinGate />;

  const selectedProviderId = (await cookies()).get(PROVIDER_COOKIE)?.value;
  return (
    <Dashboard
      providers={withSelectedProviderFirst(data.providers, selectedProviderId)}
      settings={data.settings}
      historyByProvider={data.historyByProvider}
    />
  );
}

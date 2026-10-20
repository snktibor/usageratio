import { cookies } from "next/headers";
import { hasLocale } from "next-intl";
import { setRequestLocale } from "next-intl/server";
import { Dashboard, type PastSummary } from "@/components/dashboard";
import { PinGate } from "@/components/pin-gate";
import { StorageProblem } from "@/components/storage-problem";
import { routing } from "@/i18n/routing";
import { archiveDueCycles } from "@/lib/archive";
import { isAuthenticated } from "@/lib/auth";
import { currentTime } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { getCycle, getPreviousCycle } from "@/lib/cycle";
import {
  asCycle,
  type CycleOption,
  type CycleSelection,
  listCycleOptions,
  parseCycleParam,
  periodOfCycle,
  providerCycleOptions,
  selectCycle,
} from "@/lib/cycle-options";
import { buildProviderDashboards, type ProviderDashboardModel } from "@/lib/dashboard";
import { ensureDemoData } from "@/lib/demo/seed";
import { archivedOfficialEntries, type CycleSummary } from "@/lib/history";
import { log } from "@/lib/log";
import { currentOfficialEntries } from "@/lib/official-usage";
import { PROVIDER_COOKIE } from "@/lib/preferences";
import { earliestStartMs, providerCycle } from "@/lib/provider-cycles";
import { mergeProviderIds, providerLabel } from "@/lib/providers";
import { StorageNotConfiguredError } from "@/lib/redis";
import {
  NEUTRAL_COLOR,
  resetFor,
  resolveConfig,
  resolveGroupColors,
  storedProviderIds,
  visibleProviderIds,
} from "@/lib/settings";
import { loadEvents, loadHistory, loadIndexes, loadOldestReportTime } from "@/lib/usage-store";

// Rendered per request: the page depends on the session cookie and on live data.
export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

interface DashboardData {
  /** Empty for a cycle only known from its archived summaries: `summaries` has those. */
  providers: ProviderDashboardModel[];
  summaries: PastSummary[];
  timeZone: string;
  generatedAt: number;
  historyByProvider: Record<string, CycleSummary[]>;
  options: CycleOption[];
  selection: CycleSelection;
  /** What the export menu can download for the cycle on screen (app/api/export/route.ts); null: nothing. */
  exportCycle: "current" | "previous" | null;
  /** groupId → colour, for the archived summaries. */
  groupColors: Record<string, string>;
  /** The settings' cost estimate (lib/resources.ts), for the archived summaries. */
  costEstimate: boolean;
}

/**
 * The saved settings decide the cycle, the cycle decides which reports to
 * read. A past cycle (`?cycle=`) reads everything still kept, since it may
 * lie anywhere inside the retention.
 */
async function loadDashboard(
  requestedStartMs: number | null,
  cookieProviderId: string | undefined,
): Promise<DashboardData> {
  const now = currentTime();
  // Demo mode only: reseeds the synthetic data once it has gone stale.
  await ensureDemoData(now);
  const indexes = await loadIndexes();
  const providerIds = mergeProviderIds(
    indexes.providers.map((provider) => provider.providerId),
    storedProviderIds(indexes.settings),
  );
  const config = resolveConfig(getConfig(), indexes.settings, providerIds);

  // The past cycles on offer are the selected provider's: its own reset, its own archive.
  const visible = visibleProviderIds(config, providerIds);
  const selectedId = cookieProviderId && visible.includes(cookieProviderId) ? cookieProviderId : visible[0];
  const own = selectedId ? providerCycle(now, config, selectedId) : null;
  const previousCycle = own?.previous ?? getPreviousCycle(getCycle(now, config.reset), config.reset);
  // The previous cycle rides along: it is the footer's comparison and counter mode's baseline.
  const earliestPrevious = earliestStartMs(now, config, providerIds, "previous");
  const since =
    requestedStartMs === null
      ? earliestPrevious
      : Math.min(earliestPrevious, now.getTime() - config.retentionDays * DAY_MS);
  const { eventsByProvider, groups } = await loadEvents(providerIds, indexes.groups, since);
  // Each provider's stored ground-truth figure applies while its own cycle runs.
  const officialUsage = currentOfficialEntries(indexes.officialUsage, (providerId) =>
    providerCycle(now, config, providerId).cycle.start.getTime(),
  );

  // Lazy archiving of the cycle that just ended (the daily housekeeping run does the same; see lib/archive.ts).
  await archiveDueCycles({
    providerIds,
    config,
    now,
    eventsByProvider,
    rawOfficialUsage: indexes.officialUsage,
  });
  const [historyByProvider, oldestReportMs] = await Promise.all([
    loadHistory(providerIds),
    loadOldestReportTime(providerIds, indexes.groups),
  ]);

  const options = selectedId
    ? providerCycleOptions({
        now,
        config,
        providerId: selectedId,
        history: historyByProvider[selectedId] ?? [],
        oldestReportMs,
      })
    : listCycleOptions({
        now,
        reset: config.reset,
        archived: Object.values(historyByProvider).flat(),
        retentionDays: config.retentionDays,
        oldestReportMs,
      });
  const selection = selectCycle(options, requestedStartMs);
  const { selected } = selection;
  const isPrevious =
    selected.startMs === previousCycle.start.getTime() && selected.endMs === previousCycle.end.getTime();
  const store = { eventsByProvider, groups, machines: indexes.machines };
  const colors = resolveGroupColors(groups);

  let providers: ProviderDashboardModel[] = [];
  let summaries: PastSummary[] = [];
  if (selected.kind === "current") {
    providers = buildProviderDashboards(now, config, providerIds, store, officialUsage);
  } else if (selected.kind === "detail") {
    const window = {
      cycle: asCycle(selected),
      previous: selection.previous
        ? asCycle(selection.previous)
        : getPreviousCycle(asCycle(selected), selectedId ? resetFor(config, selectedId) : config.reset),
    };
    providers = buildProviderDashboards(
      now,
      // The cycle's own length decides how its days are labelled, whatever the settings say today.
      { ...config, reset: { ...config.reset, period: periodOfCycle(selected) } },
      providerIds,
      // Only the machines that reported in it: which ones have gone quiet since is today's story.
      { ...store, machines: [] },
      archivedOfficialEntries(historyByProvider, selected),
      window,
    );
  } else {
    summaries = visibleProviderIds(config, providerIds).map((providerId) => ({
      id: providerId,
      label: providerLabel(providerId),
      summary: (historyByProvider[providerId] ?? []).find((entry) => entry.start === selected.startMs) ?? null,
    }));
  }

  return {
    providers,
    summaries,
    timeZone: config.reset.timeZone,
    generatedAt: now.getTime(),
    historyByProvider,
    options,
    selection,
    exportCycle: selected.kind === "current" ? "current" : isPrevious ? "previous" : null,
    groupColors: Object.fromEntries(groups.map((group) => [group.groupId, colors.get(group.groupId) ?? NEUTRAL_COLOR])),
    costEstimate: config.costEstimate,
  };
}

/**
 * The cookie's provider first, so the dashboard renders the last-selected one
 * from the very first paint (see components/dashboard-view.tsx: it reads the
 * order, not the cookie, so the client and the server always agree).
 */
function withSelectedProviderFirst<T extends { id: string }>(providers: T[], selectedId: string | undefined): T[] {
  const index = selectedId ? providers.findIndex((provider) => provider.id === selectedId) : -1;
  if (index <= 0) return providers;
  return [providers[index]!, ...providers.slice(0, index), ...providers.slice(index + 1)];
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);

  const selectedProviderId = (await cookies()).get(PROVIDER_COOKIE)?.value;
  let data: DashboardData | null = null;
  let storageError: unknown = null;

  try {
    // Usage data and settings are only ever read after the session check passed.
    if (await isAuthenticated())
      data = await loadDashboard(parseCycleParam((await searchParams).cycle), selectedProviderId);
  } catch (error) {
    storageError = error;
    log.error("dashboard.load_failed", { err: error });
  }

  if (storageError) {
    return <StorageProblem notConfigured={storageError instanceof StorageNotConfiguredError} />;
  }
  if (!data) return <PinGate />;

  return (
    <Dashboard
      providers={withSelectedProviderFirst(data.providers, selectedProviderId)}
      summaries={withSelectedProviderFirst(data.summaries, selectedProviderId)}
      timeZone={data.timeZone}
      generatedAt={data.generatedAt}
      historyByProvider={data.historyByProvider}
      options={data.options}
      selection={data.selection}
      exportCycle={data.exportCycle}
      groupColors={data.groupColors}
      costEstimate={data.costEstimate}
    />
  );
}

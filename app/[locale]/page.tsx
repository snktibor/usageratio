import { cookies } from "next/headers";
import { Dashboard } from "@/components/dashboard";
import { PROVIDER_COOKIE } from "@/components/dashboard-view";
import { PinGate } from "@/components/pin-gate";
import { StorageProblem } from "@/components/storage-problem";
import { isAuthenticated } from "@/lib/auth";
import { currentTime } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { getCycle, getPreviousCycle } from "@/lib/cycle";
import { buildProviderDashboards, type ProviderDashboardModel } from "@/lib/dashboard";
import { ensureDemoData } from "@/lib/demo/seed";
import { log } from "@/lib/log";
import { modelKeysIn } from "@/lib/models";
import { currentOfficialEntries } from "@/lib/official-usage";
import { mergeProviderIds } from "@/lib/providers";
import { StorageNotConfiguredError } from "@/lib/redis";
import { buildSettingsView, resolveConfig, type SettingsView, storedProviderIds } from "@/lib/settings";
import { loadEvents, loadIndexes } from "@/lib/usage-store";

// Rendered per request: the page depends on the session cookie and on live data.
export const dynamic = "force-dynamic";

interface DashboardData {
  providers: ProviderDashboardModel[];
  settings: SettingsView;
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
  // The previous cycle rides along: it is the footer's comparison and counter mode's baseline.
  const since = getPreviousCycle(cycle, config.reset).start.getTime();
  const { eventsByProvider, groups } = await loadEvents(providerIds, indexes.groups, since);
  // The reset is shared by every provider, so one cycle start also tells which stored ground-truth figures still apply.
  const officialUsage = currentOfficialEntries(indexes.officialUsage, cycle.start.getTime());

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

export default async function Page() {
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
    <Dashboard providers={withSelectedProviderFirst(data.providers, selectedProviderId)} settings={data.settings} />
  );
}

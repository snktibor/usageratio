import { Dashboard } from "@/components/dashboard";
import { PinGate } from "@/components/pin-gate";
import { StorageProblem } from "@/components/storage-problem";
import { isAuthenticated } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { getCycle, getPreviousCycle } from "@/lib/cycle";
import { buildDashboard, type DashboardModel } from "@/lib/dashboard";
import { StorageNotConfiguredError } from "@/lib/redis";
import { buildSettingsView, resolveConfig, type SettingsView } from "@/lib/settings";
import { loadEvents, loadIndexes } from "@/lib/usage-store";

// Rendered per request: the page depends on the session cookie and on live data.
export const dynamic = "force-dynamic";

interface DashboardData {
  model: DashboardModel;
  settings: SettingsView;
}

/** Two round trips: the saved settings decide the cycle, the cycle decides which reports to read. */
async function loadDashboard(): Promise<DashboardData> {
  const now = new Date();
  const indexes = await loadIndexes();
  const config = resolveConfig(getConfig(), indexes.settings);

  const cycle = getCycle(now, config.reset);
  // The previous cycle rides along: it is the footer's comparison and counter mode's baseline.
  const since = getPreviousCycle(cycle, config.reset).start.getTime();
  const { events, groups } = await loadEvents(indexes.groups, since);

  return {
    model: buildDashboard(now, config, { events, groups, machines: indexes.machines }),
    settings: buildSettingsView(config, groups),
  };
}

export default async function Page() {
  let data: DashboardData | null = null;
  let storageError: unknown = null;

  try {
    // Usage data and settings are only ever read after the session check passed.
    if (await isAuthenticated()) data = await loadDashboard();
  } catch (error) {
    storageError = error;
    console.error("[usageratio] Dashboard could not load:", error);
  }

  if (storageError) {
    return <StorageProblem notConfigured={storageError instanceof StorageNotConfiguredError} />;
  }
  return data ? <Dashboard model={data.model} settings={data.settings} /> : <PinGate />;
}

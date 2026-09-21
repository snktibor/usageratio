import { Dashboard } from "@/components/dashboard";
import { PinGate } from "@/components/pin-gate";
import { StorageProblem } from "@/components/storage-problem";
import { isAuthenticated } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { getCycle, getPreviousCycle } from "@/lib/cycle";
import { buildDashboard, type DashboardModel } from "@/lib/dashboard";
import { StorageNotConfiguredError } from "@/lib/redis";
import { loadSnapshot } from "@/lib/usage-store";

// Rendered per request: the page depends on the session cookie and on live data.
export const dynamic = "force-dynamic";

async function loadDashboard(): Promise<DashboardModel> {
  const config = getConfig();
  const now = new Date();
  const cycle = getCycle(now, config.reset);
  // The previous cycle rides along: it is the footer's comparison and counter mode's baseline.
  const since = getPreviousCycle(cycle, config.reset).start.getTime();
  return buildDashboard(now, config, await loadSnapshot(since));
}

export default async function Page() {
  let model: DashboardModel | null = null;
  let storageError: unknown = null;

  try {
    // Usage data is only ever read after the session check passed.
    if (await isAuthenticated()) model = await loadDashboard();
  } catch (error) {
    storageError = error;
    console.error("[usageratio] Dashboard could not load:", error);
  }

  if (storageError) {
    return <StorageProblem notConfigured={storageError instanceof StorageNotConfiguredError} />;
  }
  return model ? <Dashboard model={model} /> : <PinGate />;
}

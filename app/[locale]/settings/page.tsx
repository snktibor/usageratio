import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { PinGate } from "@/components/pin-gate";
import { SettingsPage } from "@/components/settings/settings-page";
import { StorageProblem } from "@/components/storage-problem";
import { routing } from "@/i18n/routing";
import { isAuthenticated } from "@/lib/auth";
import { currentTime } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { getCycle, getPreviousCycle } from "@/lib/cycle";
import { ensureDemoData } from "@/lib/demo/seed";
import { log } from "@/lib/log";
import { modelKeysIn } from "@/lib/models";
import { mergeProviderIds } from "@/lib/providers";
import { StorageNotConfiguredError } from "@/lib/redis";
import { buildSettingsView, resolveConfig, type SettingsView, storedProviderIds } from "@/lib/settings";
import { loadEvents, loadIndexes } from "@/lib/usage-store";

// Rendered per request: the page depends on the session cookie and on the stored settings.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const requested = (await params).locale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const t = await getTranslations({ locale, namespace: "Settings" });
  return { title: `${t("settings_title")} · usageratio` };
}

/**
 * The same settings view the dashboard used to hand its dialog: the saved
 * settings, the known groups, and the models seen since the previous cycle
 * began (for picking a sub-limit's).
 */
async function loadSettingsView(): Promise<SettingsView> {
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
  const since = getPreviousCycle(cycle, config.reset).start.getTime();
  const { eventsByProvider, groups } = await loadEvents(providerIds, indexes.groups, since);
  return buildSettingsView(
    config,
    groups,
    providerIds,
    Object.fromEntries(
      Object.entries(eventsByProvider).map(([providerId, events]) => [providerId, modelKeysIn(events)]),
    ),
  );
}

export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);

  let view: SettingsView | null = null;
  let storageError: unknown = null;

  try {
    // Like the dashboard: nothing stored is read before the session check passed.
    if (await isAuthenticated()) view = await loadSettingsView();
  } catch (error) {
    storageError = error;
    log.error("settings_page.load_failed", { err: error });
  }

  if (storageError) {
    return <StorageProblem notConfigured={storageError instanceof StorageNotConfiguredError} />;
  }
  if (!view) return <PinGate next="/settings" />;

  return <SettingsPage view={view} />;
}

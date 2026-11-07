import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SignInGate } from "@/components/auth/sign-in-gate";
import { SettingsPage } from "@/components/settings/settings-page";
import { StorageProblem } from "@/components/storage-problem";
import { TenantGuard } from "@/components/tenant-guard";
import { routing } from "@/i18n/routing";
import { currentTime } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { ensureDemoData } from "@/lib/demo/seed";
import { log } from "@/lib/log";
import { modelKeysIn } from "@/lib/models";
import { earliestStartMs } from "@/lib/provider-cycles";
import { mergeProviderIds } from "@/lib/providers";
import { StorageNotConfiguredError } from "@/lib/redis";
import { isMultiTenant } from "@/lib/registration";
import { buildSettingsView, resolveConfig, type SettingsView, storedProviderIds } from "@/lib/settings";
import type { TenantStore } from "@/lib/tenant";
import { currentTenant } from "@/lib/tenant-context";
import { loadEvents, loadIndexes } from "@/lib/usage-store";
import type { Role } from "@/lib/users";

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
async function loadSettingsView(store: TenantStore, role: Role): Promise<SettingsView> {
  const now = currentTime();
  // Demo mode only: reseeds the synthetic data once it has gone stale.
  await ensureDemoData(store, now);
  const indexes = await loadIndexes(store);
  const providerIds = mergeProviderIds(
    indexes.providers.map((provider) => provider.providerId),
    storedProviderIds(indexes.settings),
  );
  const config = resolveConfig(getConfig(), indexes.settings, providerIds);
  const since = earliestStartMs(now, config, providerIds, "previous");
  const { eventsByProvider, groups } = await loadEvents(store, providerIds, indexes.groups, since);
  // Multi-tenant mode: the alert webhook URL reaches no browser, the owner's included.
  return buildSettingsView(
    config,
    groups,
    { multiTenant: isMultiTenant(), owner: role === "owner" },
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
  let tenantId: string | null = null;
  let storageError: unknown = null;

  try {
    // Like the dashboard: nothing stored is read before the session check passed.
    const tenant = await currentTenant();
    if (tenant) {
      tenantId = tenant.store.tenantId;
      view = await loadSettingsView(tenant.store, tenant.role);
    }
  } catch (error) {
    storageError = error;
    log.error("settings_page.load_failed", { err: error });
  }

  if (storageError) {
    return <StorageProblem notConfigured={storageError instanceof StorageNotConfiguredError} />;
  }
  if (!view) return <SignInGate next="/settings" />;

  return (
    <>
      {isMultiTenant() && tenantId && <TenantGuard tenantId={tenantId} />}
      <SettingsPage view={view} />
    </>
  );
}

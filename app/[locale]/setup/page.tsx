import { headers } from "next/headers";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SignInGate } from "@/components/auth/sign-in-gate";
import { type SetupGroup, SetupView } from "@/components/setup/setup-view";
import { StorageProblem } from "@/components/storage-problem";
import { TenantGuard } from "@/components/tenant-guard";
import { routing } from "@/i18n/routing";
import type { ApiTokenStatus } from "@/lib/api-token";
import { log } from "@/lib/log";
import { StorageNotConfiguredError } from "@/lib/redis";
import { isMultiTenant } from "@/lib/registration";
import { NEUTRAL_COLOR, resolveGroupColors } from "@/lib/settings";
import { detectOs, parseMode, parseOs, parseRoute } from "@/lib/setup";
import { loadClientSources, oneShotBlobs, usageEndpoint } from "@/lib/setup-package";
import type { TenantStore } from "@/lib/tenant";
import { currentTenant } from "@/lib/tenant-context";
import { loadApiTokenStatus } from "@/lib/token-vault";
import { loadIndexes } from "@/lib/usage-store";

// Rendered per request: the page depends on the session cookie and on the stored groups.
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const requested = (await params).locale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;
  const t = await getTranslations({ locale, namespace: "Setup" });
  return { title: `${t("title")} · usageratio` };
}

/** The known groups in order of first appearance, with the colours the dashboard shows them in. */
async function loadGroups(store: TenantStore): Promise<SetupGroup[]> {
  const { groups } = await loadIndexes(store);
  const colors = resolveGroupColors(groups);
  return [...groups]
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.groupId.localeCompare(b.groupId))
    .map((group) => ({ id: group.groupId, color: colors.get(group.groupId) ?? NEUTRAL_COLOR }));
}

export default async function SetupPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);

  let groups: SetupGroup[] | null = null;
  let tokenStatus: ApiTokenStatus = { state: "empty" };
  let tenantId: string | null = null;
  let storageError: unknown = null;

  try {
    // Like the dashboard: the stored groups are only read after the session check passed.
    const tenant = await currentTenant();
    if (tenant) {
      tenantId = tenant.store.tenantId;
      // Multi-tenant mode has no shared token to offer (the vault answers 404 there).
      [groups, tokenStatus] = await Promise.all([
        loadGroups(tenant.store),
        isMultiTenant() ? Promise.resolve<ApiTokenStatus>({ state: "empty" }) : loadApiTokenStatus(tenant.store),
      ]);
    }
  } catch (error) {
    storageError = error;
    log.error("setup_page.load_failed", { err: error });
  }

  if (storageError) {
    return <StorageProblem notConfigured={storageError instanceof StorageNotConfiguredError} />;
  }
  if (!groups) return <SignInGate next="/setup" />;

  const [query, requestHeaders, sources] = await Promise.all([searchParams, headers(), loadClientSources()]);
  return (
    <>
      {isMultiTenant() && tenantId && <TenantGuard tenantId={tenantId} />}
      <SetupView
        initialOs={
          parseOs(query.os) ?? detectOs(requestHeaders.get("user-agent"), requestHeaders.get("sec-ch-ua-platform"))
        }
        initialMode={parseMode(query.mode) ?? "auto"}
        initialRoute={parseRoute(query.route) ?? "zip"}
        apiUrl={usageEndpoint(requestHeaders)}
        groups={groups}
        sources={sources}
        oneShot={oneShotBlobs(sources)}
        tokenStatus={tokenStatus}
        multiTenant={isMultiTenant()}
      />
    </>
  );
}

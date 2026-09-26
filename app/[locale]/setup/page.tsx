import { headers } from "next/headers";
import { PinGate } from "@/components/pin-gate";
import { type SetupGroup, SetupView } from "@/components/setup-view";
import { StorageProblem } from "@/components/storage-problem";
import type { ApiTokenStatus } from "@/lib/api-token";
import { isAuthenticated } from "@/lib/auth";
import { StorageNotConfiguredError } from "@/lib/redis";
import { NEUTRAL_COLOR, resolveGroupColors } from "@/lib/settings";
import { detectOs, parseMode, parseOs, parseRoute } from "@/lib/setup";
import { loadClientSources, oneShotBlobs, usageEndpoint } from "@/lib/setup-package";
import { loadApiTokenStatus } from "@/lib/token-vault";
import { loadIndexes } from "@/lib/usage-store";

// Rendered per request: the page depends on the session cookie and on the stored groups.
export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const locale = (await params).locale;
  const t = await getTranslations({ locale, namespace: "Setup" });
  return { title: `${t("title")} · usageratio` };
}

/** The known groups in order of first appearance, with the colours the dashboard shows them in. */
async function loadGroups(): Promise<SetupGroup[]> {
  const { groups } = await loadIndexes();
  const colors = resolveGroupColors(groups);
  return [...groups]
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.groupId.localeCompare(b.groupId))
    .map((group) => ({ id: group.groupId, color: colors.get(group.groupId) ?? NEUTRAL_COLOR }));
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let groups: SetupGroup[] | null = null;
  let tokenStatus: ApiTokenStatus = { state: "empty" };
  let storageError: unknown = null;

  try {
    // Like the dashboard: the stored groups are only read after the session check passed.
    if (await isAuthenticated()) [groups, tokenStatus] = await Promise.all([loadGroups(), loadApiTokenStatus()]);
  } catch (error) {
    storageError = error;
    console.error("[usageratio] The setup page could not load:", error);
  }

  if (storageError) {
    return <StorageProblem notConfigured={storageError instanceof StorageNotConfiguredError} />;
  }
  if (!groups) return <PinGate next="/setup" />;

  const [params, requestHeaders, sources] = await Promise.all([searchParams, headers(), loadClientSources()]);
  return (
    <SetupView
      initialOs={
        parseOs(params.os) ?? detectOs(requestHeaders.get("user-agent"), requestHeaders.get("sec-ch-ua-platform"))
      }
      initialMode={parseMode(params.mode) ?? "auto"}
      initialRoute={parseRoute(params.route) ?? "zip"}
      apiUrl={usageEndpoint(requestHeaders)}
      groups={groups}
      sources={sources}
      oneShot={oneShotBlobs(sources)}
      tokenStatus={tokenStatus}
    />
  );
}

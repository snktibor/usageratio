import { hasLocale, type Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { apiError, readJsonBody, requireSameOrigin, requireTenantSession, withApiHandler } from "@/lib/api";
import { isMultiTenant } from "@/lib/registration";
import { requestLocale } from "@/lib/request-locale";
import {
  checkMachineSettings,
  type MachineSettings,
  parseMode,
  parseOs,
  type SetupMode,
  type SetupOs,
} from "@/lib/setup";
import { buildSetupZip, loadClientSources, usageEndpoint } from "@/lib/setup-package";
import { currentTenant } from "@/lib/tenant-context";
import { liveTokenRecord } from "@/lib/tokens";

/**
 * GET /api/setup?os=macos|linux|windows&mode=auto|manual&group=Work&machine=win-desktop[&locale=hu]
 *
 * The setup page's ZIP download. It sits behind the dashboard's PIN session like
 * the page itself: without a session the browser is sent to /setup, which asks
 * for the PIN. A package carries no secret (the installer asks for the API
 * token), but the group names are data. `machine` may be empty.
 *
 * `/api/*` is excluded from the next-intl middleware matcher, so there is no
 * request-scoped locale here (see i18n/request.ts); lib/request-locale.ts
 * works out which one the README.txt inside the ZIP, and a bounced-back
 * request, should use.
 *
 * 200 application/zip · 303 no session · 400 bad parameters · 404 multi-tenant mode (see POST) ·
 * 503 Redis down
 *
 * POST /api/setup — the same package in multi-tenant mode, with a secret inside: the machine's
 * own token, written into the package's config, so the installer asks for nothing. The page
 * issues that token first (POST /api/tokens: sudo, the audit trail, one per machine and visit)
 * and sends it here; only the workspace's live ingest token bound to this very machine is taken.
 * A POST because the body carries a secret. The README says the ZIP holds one.
 *
 *   { "os": "macos", "mode": "auto", "group": "Work", "machine": "studio", "token": "ur_live_…",
 *     "locale"?: "hu" }  → 200 application/zip
 *
 * 400 bad parameters, no machine name, or invalid_token (not this workspace's live ingest token
 * for this machine) · 401 no session · 403 foreign origin · 404 single-user instance (see GET) ·
 * 412 tenant_changed · 503 Redis down
 */

function zipResponse(fileName: string, bytes: Uint8Array<ArrayBuffer>): Response {
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

async function packageFor(
  os: SetupOs,
  mode: SetupMode,
  settings: MachineSettings,
  locale: Locale,
): Promise<{ fileName: string; bytes: Uint8Array<ArrayBuffer> }> {
  const [translate, sources] = await Promise.all([
    getTranslations({ locale, namespace: "Setup" }),
    loadClientSources(),
  ]);
  return buildSetupZip(os, mode, settings, sources, translate);
}

export const GET = withApiHandler("api/setup", async ({ request }) => {
  if (isMultiTenant()) return apiError("not_found", 404);
  const locale = await requestLocale(request);

  if (!(await currentTenant())) {
    return Response.redirect(new URL(`/${locale}/setup`, request.url), 303);
  }

  const params = new URL(request.url).searchParams;
  const os = parseOs(params.get("os"));
  const mode = parseMode(params.get("mode"));
  const check = checkMachineSettings(params.get("group") ?? "", params.get("machine") ?? "");
  if (!os || !mode || !check.ok) {
    return apiError("invalid_payload", 400);
  }

  const settings = {
    apiUrl: usageEndpoint(request.headers),
    groupId: check.groupId,
    machineId: check.machineId,
  };
  const { fileName, bytes } = await packageFor(os, mode, settings, locale);
  return zipResponse(fileName, bytes);
});

export const POST = withApiHandler("api/setup", async ({ request }) => {
  if (!isMultiTenant()) return apiError("not_found", 404);
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;

  const body = await readJsonBody(request, { maxBytes: 1024 });
  if (!body.ok) return body.response;
  const value = (typeof body.value === "object" && body.value !== null ? body.value : {}) as Record<string, unknown>;
  const os = parseOs(value.os);
  const mode = parseMode(value.mode);
  const check = checkMachineSettings(String(value.group ?? ""), String(value.machine ?? ""));
  if (!os || !mode || !check.ok || check.machineId === "" || typeof value.token !== "string") {
    return apiError("invalid_payload", 400, { details: ["os, mode, group, machine and token are required"] });
  }
  // Only the workspace's own live ingest token for this very machine goes into its package.
  const token = await liveTokenRecord(tenant.store, value.token);
  if (token?.scope !== "ingest" || token.machineId !== check.machineId) {
    return apiError("invalid_token", 400);
  }
  const locale = hasLocale(routing.locales, value.locale) ? value.locale : await requestLocale(request);
  const settings = {
    apiUrl: usageEndpoint(request.headers),
    groupId: check.groupId,
    machineId: check.machineId,
    token: value.token,
  };
  const { fileName, bytes } = await packageFor(os, mode, settings, locale);
  return zipResponse(fileName, bytes);
});

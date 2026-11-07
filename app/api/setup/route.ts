import { hasLocale, type Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { apiError, readJsonBody, requireSameOrigin, requireTenantSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
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
import { tokenAudit } from "@/lib/token-audit";
import { createToken, MAX_LABEL_LENGTH, MAX_TOKENS } from "@/lib/tokens";

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
 * POST /api/setup — the same package in multi-tenant mode, with a secret inside: a fresh ingest
 * token bound to the named machine (lib/tokens.ts, on the audit trail), written into the
 * package's config, so the installer asks for nothing. A POST because it creates something; it
 * needs sudo, like creating a token in the settings panel. The README says the ZIP holds a secret.
 *
 *   { "os": "macos", "mode": "auto", "group": "Work", "machine": "studio", "locale"?: "hu" }
 *     → 200 application/zip
 *
 * 400 bad parameters, or no machine name (the token is bound to it) · 401 no session · 403 foreign
 * origin / sudo_required · 404 single-user instance (see GET) · 412 tenant_changed ·
 * 422 too_many_tokens · 503 Redis down
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
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  if (!(await hasSudo())) return apiError("sudo_required", 403);

  const body = await readJsonBody(request, { maxBytes: 1024 });
  if (!body.ok) return body.response;
  const value = (typeof body.value === "object" && body.value !== null ? body.value : {}) as Record<string, unknown>;
  const os = parseOs(value.os);
  const mode = parseMode(value.mode);
  const check = checkMachineSettings(String(value.group ?? ""), String(value.machine ?? ""));
  if (!os || !mode || !check.ok || check.machineId === "") {
    return apiError("invalid_payload", 400, { details: ["os, mode, group and machine are required"] });
  }
  const locale = hasLocale(routing.locales, value.locale) ? value.locale : await requestLocale(request);

  const now = new Date();
  const label = `${check.machineId} (setup)`.slice(0, MAX_LABEL_LENGTH);
  const created = await createToken(
    tenant.store,
    label,
    check.machineId,
    now,
    "ingest",
    tenant.userId,
    tokenAudit("token_created", tenant, now),
  );
  if (!created.ok) return apiError("too_many_tokens", 422, { limit: MAX_TOKENS });

  const settings = { apiUrl: usageEndpoint(request.headers), groupId: check.groupId, machineId: check.machineId };
  const { fileName, bytes } = await packageFor(os, mode, { ...settings, token: created.token }, locale);
  return zipResponse(fileName, bytes);
});

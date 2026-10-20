import { getTranslations } from "next-intl/server";
import { apiError, withApiHandler } from "@/lib/api";
import { isAuthenticated } from "@/lib/auth";
import { requestLocale } from "@/lib/request-locale";
import { checkMachineSettings, parseMode, parseOs } from "@/lib/setup";
import { buildSetupZip, loadClientSources, usageEndpoint } from "@/lib/setup-package";

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
 * 200 application/zip · 303 no session · 400 bad parameters · 503 Redis down
 */

export const GET = withApiHandler("api/setup", async ({ request }) => {
  const locale = await requestLocale(request);

  if (!(await isAuthenticated())) {
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
  const [translate, sources] = await Promise.all([
    getTranslations({ locale, namespace: "Setup" }),
    loadClientSources(),
  ]);
  const { fileName, bytes } = buildSetupZip(os, mode, settings, sources, translate);
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
});

import { cookies } from "next/headers";
import { isAuthenticated } from "@/lib/auth";
import { StorageNotConfiguredError } from "@/lib/redis";
import { checkMachineSettings, parseMode, parseOs } from "@/lib/setup";
import { buildSetupZip, loadClientSources, usageEndpoint } from "@/lib/setup-package";
import { routing } from "@/i18n/routing";

/**
 * GET /api/setup?os=macos|linux|windows&mode=auto|manual&group=Work&machine=win-desktop
 *
 * The setup page's ZIP download. It sits behind the dashboard's PIN session like
 * the page itself: without a session the browser is sent to /setup, which asks
 * for the PIN. A package carries no secret (the installer asks for the API
 * token), but the group names are data. `machine` may be empty.
 *
 * 200 application/zip · 303 no session · 400 bad parameters · 503 Redis down
 */

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/**
 * `/api/*` is excluded from the next-intl middleware matcher, so there is no
 * request-scoped locale here. The middleware does leave its default
 * `NEXT_LOCALE` cookie behind on every page visit (see i18n/routing.ts, which
 * does not override it), so that's what tells us which prefix (`/hu/setup`
 * or `/en/setup`) to bounce an unauthenticated request back to.
 */
async function localePrefixedSetupPath(): Promise<string> {
  const cookieValue = (await cookies()).get("NEXT_LOCALE")?.value ?? "";
  const locale = (routing.locales as readonly string[]).includes(cookieValue)
    ? (cookieValue as (typeof routing.locales)[number])
    : routing.defaultLocale;
  return `/${locale}/setup`;
}

export async function GET(request: Request): Promise<Response> {
  try {
    if (!(await isAuthenticated())) {
      return Response.redirect(new URL(await localePrefixedSetupPath(), request.url), 303);
    }
  } catch (error) {
    if (error instanceof StorageNotConfiguredError) console.error(`[usageratio] ${error.message}`);
    else console.error("[usageratio] The setup download could not check the session:", error);
    return text("Az adattár most nem érhető el, ezért a letöltés sem. Próbáld újra kicsit később.", 503);
  }

  const params = new URL(request.url).searchParams;
  const os = parseOs(params.get("os"));
  const mode = parseMode(params.get("mode"));
  const check = checkMachineSettings(params.get("group") ?? "", params.get("machine") ?? "");
  if (!os || !mode || !check.ok) {
    return text("Hibás letöltési kérés. Nyisd meg újra a Telepítés oldalt, és onnan töltsd le a csomagot.", 400);
  }

  const settings = { apiUrl: usageEndpoint(request.headers), groupId: check.groupId, machineId: check.machineId };
  const { fileName, bytes } = buildSetupZip(os, mode, settings, await loadClientSources());
  return new Response(bytes, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}

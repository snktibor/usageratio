import { gzipSync } from "node:zlib";
import { acceptsGzip, accountExportFilename, buildAccountExport } from "@/lib/account-export";
import { apiError, rateLimited, requireUserSession, withApiHandler } from "@/lib/api";
import { currentTime } from "@/lib/clock";
import { clientIp } from "@/lib/request-context";
import { accountExportRules } from "@/lib/route-limits";

/**
 * GET /api/account/export — everything stored about the signed-in user, as one JSON file to
 * download (lib/account-export.ts): the account, every workspace it belongs to, and the complete
 * data of each workspace it owns. Multi-tenant mode only; a read, so no sudo and no origin check.
 *
 * The body is gzip-encoded when the client accepts it (a browser always does): a large
 * workspace's raw reports would otherwise come close to the hosting's response size limit.
 *
 * 200 ok (`Content-Disposition: attachment`, usageratio-export-<login>-<YYYY-MM-DD>.json) ·
 * 401 no session · 404 single-user instance · 429 rate limited (10/hour per user, 120/hour per
 * client address) · 503 Redis down
 */

export const GET = withApiHandler("api/account/export", async ({ request }) => {
  const session = await requireUserSession();
  if (session instanceof Response) return session;
  const limited = await rateLimited(accountExportRules({ userId: session.userId, ip: await clientIp() }));
  if (limited) return limited;

  const now = currentTime();
  const document = await buildAccountExport(session.userId, now);
  if (!document) return apiError("unauthorized", 401);

  const filename = accountExportFilename(document.account.login, now);
  const text = JSON.stringify(document, null, 2);
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
  };
  if (acceptsGzip(request.headers.get("accept-encoding"))) {
    return new Response(gzipSync(text), { status: 200, headers: { ...headers, "Content-Encoding": "gzip" } });
  }
  return new Response(text, { status: 200, headers });
});

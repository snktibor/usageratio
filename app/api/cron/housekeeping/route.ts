import { apiError, json, withApiHandler } from "@/lib/api";
import { demoReadOnly } from "@/lib/demo/mode";
import { runHousekeeping } from "@/lib/housekeeping";
import { log } from "@/lib/log";
import { safeEqual } from "@/lib/security";

/**
 * GET /api/cron/housekeeping — Vercel Cron calls this daily (see the `crons`
 * entry in vercel.json), with `Authorization: Bearer $CRON_SECRET`. Prunes the
 * index hashes (providers, groups, machines, official usage) and the audit
 * trail of entries nothing still points to; never touches the raw event
 * history, which already self-prunes on write (see lib/usage-store.ts).
 *
 *   ?dryRun=1 → the same report, nothing is deleted
 *
 *   → { "report": HousekeepingReport }
 *
 * 200 ok · 401 missing/wrong bearer · 500 server_misconfigured (CRON_SECRET
 * missing or under 16 characters: refuses to run unauthenticated rather than
 * accepting every request)
 */

const MIN_CRON_SECRET_LENGTH = 16;

export const dynamic = "force-dynamic";

export const GET = withApiHandler("api/cron/housekeeping", async ({ request, url }) => {
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < MIN_CRON_SECRET_LENGTH) {
    log.error("housekeeping.cron_misconfigured", { minLength: MIN_CRON_SECRET_LENGTH });
    return apiError("server_misconfigured", 500);
  }
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!bearer?.[1] || !safeEqual(bearer[1], secret)) {
    return apiError("unauthorized", 401, { scheme: "bearer" });
  }

  const dryRun = url.searchParams.get("dryRun") === "1";
  const report = await runHousekeeping(new Date(), { dryRun });
  return json({ report }, 200);
});

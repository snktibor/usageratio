import { apiError, json, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { runHousekeeping } from "@/lib/housekeeping";

/**
 * POST /api/housekeeping — the settings panel's manual "run housekeeping now"
 * trigger, behind the dashboard's PIN session. Runs the same pruning as the
 * daily cron (see app/api/cron/housekeeping/route.ts and lib/housekeeping.ts).
 *
 * A real run deletes (only index entries nothing points to any more), so it
 * needs a fresh PIN confirmation (sudo, POST /api/auth/sudo); a dry run only
 * reports and needs the session alone.
 *
 *   ?dryRun=1 → the same report, nothing is deleted
 *
 *   → { "report": HousekeepingReport }
 *
 * 200 ok · 401 no session · 403 foreign origin, demo_read_only or sudo_required
 */

export const dynamic = "force-dynamic";

export const POST = withApiHandler("api/housekeeping", async ({ request, url }) => {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;
  const sessionError = await requireSession();
  if (sessionError) return sessionError;

  const dryRun = url.searchParams.get("dryRun") === "1";
  if (!dryRun && !(await hasSudo())) return apiError("sudo_required", 403);
  const report = await runHousekeeping(new Date(), { dryRun });
  return json({ report }, 200);
});

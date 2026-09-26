import { json, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { demoReadOnly } from "@/lib/demo/mode";
import { runHousekeeping } from "@/lib/housekeeping";

/**
 * POST /api/housekeeping — the settings panel's manual "run housekeeping now"
 * trigger, behind the dashboard's PIN session. Runs the same pruning as the
 * daily cron (see app/api/cron/housekeeping/route.ts and lib/housekeeping.ts).
 *
 * TODO(auth): once the sudo flow lands, require it here too — this only
 * deletes index entries nothing still points to, but it is still a mutating
 * admin action and should sit behind the same gate as the other sudo routes.
 *
 *   ?dryRun=1 → the same report, nothing is deleted
 *
 *   → { "report": HousekeepingReport }
 *
 * 200 ok · 401 no session · 403 foreign origin or demo_read_only
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
  const report = await runHousekeeping(new Date(), { dryRun });
  return json({ report }, 200);
});

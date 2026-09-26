import { apiError, json, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { INACTIVE_MACHINE_DAYS } from "@/lib/config";
import { demoReadOnly } from "@/lib/demo/mode";
import { pruneMachines } from "@/lib/manage-store";

/**
 * POST /api/machines/prune — drops the index entry (not the stored reports)
 * of every machine silent for more than INACTIVE_MACHINE_DAYS: the same rule
 * lib/housekeeping.ts already applies once a day, triggered here on demand
 * from the settings panel's "remove N silent machines" button. Needs a fresh
 * sudo grant, like every other bulk removal.
 *
 *   → { "ok": true, "affected": { "events": 0, "machines": <removed>, "groups": 0 } }
 *
 * 200 ok · 401 no session · 403 foreign origin, demo mode, or no sudo grant · 503 Redis down
 */
export const POST = withApiHandler("api/machines/prune", async ({ request }) => {
  const origin = requireSameOrigin(request);
  if (origin) return origin;
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;
  if (!(await hasSudo())) return apiError("sudo_required", 403);

  const { removedIds } = await pruneMachines(new Date(), INACTIVE_MACHINE_DAYS);
  return json({ ok: true, affected: { events: 0, machines: removedIds.length, groups: 0 } }, 200);
});

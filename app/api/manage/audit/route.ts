import { json, requireOwner, requireTenantSession, withApiHandler } from "@/lib/api";
import { sessionTag } from "@/lib/auth";
import { loadManageAudit } from "@/lib/manage-audit";

/**
 * GET /api/manage/audit — the workspace's destructive-actions trail, newest first: groups,
 * providers and machines deleted or merged, restarts recorded, changed or deleted (and, with the
 * trash, restores and permanent deletes), by which browser and address, and in multi-tenant mode
 * by whom. The owner's only, like the token history: it carries other people's network details.
 *
 *   → { "entries": [{ "at", "action", "subject": { "kind", "id", "providerId"?, "target"? },
 *                     "affected": { events, machines, groups } | null, "trashId": string | null,
 *                     "browser", "os", "userAgent", "ip", "session", "by" }],
 *       "currentSession": "1a2b3c4d" }
 *
 * 200 ok · 401 no session · 403 owner_only · 503 Redis down
 */
export const GET = withApiHandler("api/manage/audit", async () => {
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  const notOwner = requireOwner(tenant);
  if (notOwner) return notOwner;
  return json({ entries: await loadManageAudit(tenant.store), currentSession: await sessionTag() }, 200);
});

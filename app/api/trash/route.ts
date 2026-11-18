import { json, requireTenantSession, withApiHandler } from "@/lib/api";
import { listTrash, TRASH_RETENTION_DAYS } from "@/lib/trash";

/**
 * GET /api/trash — the recently deleted groups and providers (lib/trash.ts), newest first, for the
 * Danger zone. Behind the dashboard's session; any member may list them (anyone who can delete
 * can see what was deleted).
 *
 *   → { "entries": [{ "id", "kind": "group" | "provider", "name", "deletedAt": ms, "expiresAt": ms,
 *                     "by": "login" | null, "affected": { events, machines, groups } }],
 *       "retentionDays": 30 }
 *
 * 200 ok · 401 no session · 503 Redis down
 */
export const GET = withApiHandler("api/trash", async () => {
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  return json({ entries: await listTrash(tenant.store), retentionDays: TRASH_RETENTION_DAYS }, 200);
});

import { json, requireTenantSession, withApiHandler } from "@/lib/api";
import { sessionTag } from "@/lib/auth";
import { loadAuditTrail } from "@/lib/token-vault";

/**
 * GET /api/tokens/audit — the workspace's token audit trail, newest first: per-machine tokens
 * created, revoked and rotated (and, on a single-user instance, the shared token's own entries,
 * which /api/api-token/audit shows as well). Behind the dashboard's session, in every mode.
 *
 *   → { "entries": [{ "at", "action", "browser", "os", "userAgent", "ip", "session",
 *                     "token": { "id", "label" } | null, "by": "login" | null }],
 *       "currentSession": "1a2b3c4d" }
 *
 * 200 ok · 401 no session · 503 Redis down
 */
export const GET = withApiHandler("api/tokens/audit", async () => {
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  return json({ entries: await loadAuditTrail(tenant.store), currentSession: await sessionTag() }, 200);
});

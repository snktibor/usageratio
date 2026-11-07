import { json, requireOwner, requireTenantSession, withApiHandler } from "@/lib/api";
import { sessionTag } from "@/lib/auth";
import { loadAuditTrail } from "@/lib/token-vault";

/**
 * GET /api/tokens/audit — the workspace's per-machine token audit trail, newest first: tokens
 * created, revoked and rotated, by which browser and address, and in multi-tenant mode by whom.
 * The owner's only (a single-user instance's PIN always is): it carries other people's network
 * details.
 *
 *   → { "entries": [{ "at", "action": "token_created" | "token_revoked" | "token_rotated",
 *                     "browser", "os", "userAgent", "ip", "session",
 *                     "token": { "id", "label", "replacement"? }, "by": "login" | null }],
 *       "currentSession": "1a2b3c4d" }
 *
 * 200 ok · 401 no session · 403 owner_only · 503 Redis down
 */
export const GET = withApiHandler("api/tokens/audit", async () => {
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  const notOwner = requireOwner(tenant);
  if (notOwner) return notOwner;
  return json({ entries: await loadAuditTrail(tenant.store, "tokensAudit"), currentSession: await sessionTag() }, 200);
});

import { json, requireMultiTenant, requireTenantSession, withApiHandler } from "@/lib/api";
import { loadWorkspaceView } from "@/lib/workspace";

/**
 * GET /api/workspace — the signed-in user's current workspace and its people (multi-tenant mode;
 * 404 on a single-user instance).
 *
 *   → { "workspace": { "tenantId", "name", "role", "you": userId,
 *         "members": [{ userId, login, role, joinedAt, invitedBy }],
 *         "invites": [{ id, createdAt, expiresAt, createdBy, login }] } }
 *
 * Every member sees who belongs; only the owner sees the pending invites (an empty list otherwise).
 *
 * 401 no session or no workspace · 404 single-user instance · 503 Redis down
 */

export const GET = withApiHandler("api/workspace", async () => {
  const closed = requireMultiTenant();
  if (closed) return closed;
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  return json({ workspace: await loadWorkspaceView(tenant, new Date()) }, 200);
});

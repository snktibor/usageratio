import { apiError, json, requireMultiTenant, requireSameOrigin, requireTenantSession, withApiHandler } from "@/lib/api";
import { leaveWorkspace } from "@/lib/members";
import { firstActiveTenant } from "@/lib/sign-in";
import { currentUserSession, setSessionTenant } from "@/lib/user-session";

/**
 * POST /api/workspace/leave — a member leaves the current workspace. The machine tokens they
 * created stay with it. The session moves on to the user's next workspace, if they have one.
 *
 *   → 200 { "ok": true, "tenantId": next | null }
 *
 * 401 no session · 403 foreign origin · 404 single-user instance · 409 owner_cannot_leave (hand
 * the workspace over first) / members_busy · 412 tenant_changed · 503 Redis down
 */

export const POST = withApiHandler("api/workspace/leave", async ({ request }) => {
  const closed = requireMultiTenant();
  if (closed) return closed;
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  const session = await currentUserSession();
  if (!session || !tenant.userId) return apiError("unauthorized", 401);

  const result = await leaveWorkspace(tenant.store.tenantId, tenant.userId);
  if (!result.ok) {
    if (result.reason === "not_found") return apiError("unauthorized", 401);
    return apiError(result.reason === "owner_cannot_leave" ? "owner_cannot_leave" : "members_busy", 409);
  }
  const next = await firstActiveTenant(tenant.userId);
  await setSessionTenant(session.hash, next);
  return json({ ok: true, tenantId: next }, 200);
});

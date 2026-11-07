import {
  apiError,
  json,
  requireMultiTenant,
  requireOwner,
  requireSameOrigin,
  requireTenantSession,
  withApiHandler,
} from "@/lib/api";
import { removeMember } from "@/lib/members";
import { isUserId } from "@/lib/users";

/**
 * DELETE /api/workspace/members/[userId]?revokeTokens=1 — the owner removes a member from the
 * current workspace. They lose it on their next request; with `revokeTokens=1` the machine tokens
 * they created are revoked as well.
 *
 *   → 200 { "ok": true, "tokensRevoked": 2 }
 *
 * 401 no session · 403 foreign origin / owner_only · 404 single-user instance, or not a member ·
 * 409 cannot_remove_owner (hand the workspace over instead) / members_busy (another change is
 * running; try again) / tenant_changed · 503 Redis down
 */

type Params = { userId: string };

export async function DELETE(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { userId } = await context.params;
  return withApiHandler("api/workspace/members/[userId]", async ({ url }) => {
    const closed = requireMultiTenant();
    if (closed) return closed;
    const foreign = requireSameOrigin(request);
    if (foreign) return foreign;
    const tenant = await requireTenantSession();
    if (tenant instanceof Response) return tenant;
    const notOwner = requireOwner(tenant);
    if (notOwner) return notOwner;
    if (!isUserId(userId)) return apiError("not_found", 404);

    const result = await removeMember(
      tenant.store,
      userId,
      { revokeTokens: url.searchParams.get("revokeTokens") === "1" },
      new Date(),
    );
    if (!result.ok) {
      if (result.reason === "not_found") return apiError("not_found", 404);
      return apiError(result.reason === "is_owner" ? "cannot_remove_owner" : "members_busy", 409);
    }
    return json({ ok: true, tokensRevoked: result.tokensRevoked }, 200);
  })(request);
}

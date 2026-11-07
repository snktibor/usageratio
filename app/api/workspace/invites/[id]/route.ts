import {
  apiError,
  json,
  requireMultiTenant,
  requireOwner,
  requireSameOrigin,
  requireTenantSession,
  withApiHandler,
} from "@/lib/api";
import { isInviteId, revokeInvite } from "@/lib/invites";

/**
 * DELETE /api/workspace/invites/[id] — the owner revokes a pending invite of the current workspace.
 * 200 · 401 no session · 403 foreign origin / owner_only · 404 single-user instance, or no such
 * invite in this workspace · 412 tenant_changed · 503 Redis down
 */

type Params = { id: string };

export async function DELETE(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { id } = await context.params;
  return withApiHandler("api/workspace/invites/[id]", async () => {
    const closed = requireMultiTenant();
    if (closed) return closed;
    const foreign = requireSameOrigin(request);
    if (foreign) return foreign;
    const tenant = await requireTenantSession();
    if (tenant instanceof Response) return tenant;
    const notOwner = requireOwner(tenant);
    if (notOwner) return notOwner;
    if (!isInviteId(id) || !(await revokeInvite(tenant.store.tenantId, id))) return apiError("not_found", 404);
    return json({ ok: true }, 200);
  })(request);
}

import { apiError, json, requireOwner, requireSameOrigin, requireTenantSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { manageAudit } from "@/lib/manage-audit";
import { purgeTrash, TRASH_ID_PATTERN } from "@/lib/trash";

/**
 * DELETE /api/trash/[id] — deletes a recently deleted entry for good, before its 30 days run out.
 * The owner's only (a single-user instance's PIN always is), with a fresh sudo grant; on the
 * manage audit trail (GET /api/manage/audit).
 *
 *   DELETE → { "ok": true, "affected": { events, machines, groups } }
 *
 * 200 ok · 400 invalid id · 401 no session · 403 foreign origin, demo mode, owner_only, or no sudo
 * grant · 404 not_found · 412 tenant_changed · 503 Redis down
 */

type Params = { id: string };

export async function DELETE(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { id } = await context.params;
  return withApiHandler("api/trash/[id]", async () => {
    const origin = requireSameOrigin(request);
    if (origin) return origin;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;
    const tenant = await requireTenantSession();
    if (tenant instanceof Response) return tenant;
    const notOwner = requireOwner(tenant);
    if (notOwner) return notOwner;
    if (!(await hasSudo())) return apiError("sudo_required", 403);
    if (!TRASH_ID_PATTERN.test(id)) return apiError("invalid_payload", 400, { details: ["invalid trash id"] });

    const now = new Date();
    const result = await purgeTrash(tenant.store, id, { audit: manageAudit(tenant, now) });
    if (!result.ok) return apiError("not_found", 404);
    return json({ ok: true, affected: result.affected }, 200);
  })(request);
}

import { requireAdmin } from "@/lib/admin-guard";
import { apiError, json, readJsonBody, requireSameOrigin, withApiHandler } from "@/lib/api";
import { DEFAULT_TENANT, isTenantId } from "@/lib/tenant-id";
import { setTenantStatus } from "@/lib/tenants";

/**
 * PATCH /api/admin/tenants/[id] { "status": "active" | "disabled" } — disables a tenant (its
 * data is kept; its members and machines are refused, `tenant_disabled` for a token) or enables it
 * again. The default tenant, a single-user instance's own data, cannot be disabled here.
 *
 * 200 · 400 bad body · 403 foreign origin · 404 not an admin, or no such tenant
 */

type Params = { id: string };

export async function PATCH(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { id } = await context.params;
  return withApiHandler("api/admin/tenants/[id]", async () => {
    const foreign = requireSameOrigin(request);
    if (foreign) return foreign;
    const admin = await requireAdmin();
    if (admin instanceof Response) return admin;
    if (!isTenantId(id) || id === DEFAULT_TENANT) return apiError("not_found", 404);

    const body = await readJsonBody(request, { maxBytes: 256 });
    if (!body.ok) return body.response;
    const status = (body.value as { status?: unknown } | null)?.status;
    if (status !== "active" && status !== "disabled") return apiError("invalid_payload", 400);
    // No record, or one being deleted (its deletion is finished, never undone): nothing to switch.
    if (!(await setTenantStatus(id, status, new Date()))) return apiError("not_found", 404);
    return json({ ok: true, status }, 200);
  })(request);
}

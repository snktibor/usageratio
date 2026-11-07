import {
  apiError,
  json,
  readJsonBody,
  requireMultiTenant,
  requireOwner,
  requireSameOrigin,
  requireTenantSession,
  withApiHandler,
} from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { transferOwnership } from "@/lib/members";
import { isUserId } from "@/lib/users";

/**
 * POST /api/workspace/transfer — the owner hands the current workspace to one of its members, who
 * becomes the owner; the old owner stays on as a member. Needs sudo (a GitHub sign-in in the last
 * 5 minutes).
 *
 *   { "userId": "u_…" }  → 200 { "ok": true }
 *
 * 400 bad body · 401 no session · 403 foreign origin / owner_only / sudo_required · 404
 * single-user instance, or not a member · 409 members_busy · 412 tenant_changed · 503 Redis down
 */

export const POST = withApiHandler("api/workspace/transfer", async ({ request }) => {
  const closed = requireMultiTenant();
  if (closed) return closed;
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  const notOwner = requireOwner(tenant);
  if (notOwner) return notOwner;
  if (!(await hasSudo())) return apiError("sudo_required", 403);

  const body = await readJsonBody(request, { maxBytes: 512 });
  if (!body.ok) return body.response;
  const target = (body.value as { userId?: unknown } | null)?.userId;
  if (typeof target !== "string" || !isUserId(target)) return apiError("invalid_payload", 400);

  const result = await transferOwnership(tenant.store.tenantId, tenant.userId ?? "", target);
  if (!result.ok) {
    if (result.reason === "busy") return apiError("members_busy", 409);
    if (result.reason === "not_owner") return apiError("owner_only", 403);
    return apiError("not_found", 404);
  }
  return json({ ok: true }, 200);
});

import { apiError, json, readJsonBody, requireSameOrigin, requireUserSession, withApiHandler } from "@/lib/api";
import { isTenantId } from "@/lib/tenant-id";
import { loadTenantRecord, tenantIsActive } from "@/lib/tenants";
import { setSessionTenant } from "@/lib/user-session";
import { membershipRole } from "@/lib/users";

/**
 * POST /api/session/tenant — switches this browser's session to another of the user's workspaces
 * (multi-tenant mode). Every open tab follows; a form still open for the old workspace is then
 * refused with 412 tenant_changed rather than saved into the new one.
 *
 *   { "tenantId": "…" }  → 200 { "ok": true }
 *
 * 400 bad body · 401 no session · 403 foreign origin · 404 single-user instance, or not a
 * workspace this user belongs to (or one that is switched off) · 503 Redis down
 */

export const POST = withApiHandler("api/session/tenant", async ({ request }) => {
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const session = await requireUserSession();
  if (session instanceof Response) return session;

  const body = await readJsonBody(request, { maxBytes: 512 });
  if (!body.ok) return body.response;
  const tenantId = (body.value as { tenantId?: unknown } | null)?.tenantId;
  if (typeof tenantId !== "string" || !isTenantId(tenantId)) return apiError("invalid_payload", 400);
  // The same answer for "no such workspace" and "not yours": nothing to learn about other tenants.
  if (!(await membershipRole(tenantId, session.userId))) return apiError("not_found", 404);
  if (!tenantIsActive(tenantId, await loadTenantRecord(tenantId))) return apiError("not_found", 404);
  await setSessionTenant(session.hash, tenantId);
  return json({ ok: true }, 200);
});

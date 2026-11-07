import { apiError, json, requireSameOrigin, requireTenantSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { tokenAudit } from "@/lib/token-audit";
import { revokeToken } from "@/lib/tokens";

/**
 * DELETE /api/tokens/[id] — revokes one per-machine API token (lib/tokens.ts):
 * sets `revokedAt`, never deletes the entry outright (lib/housekeeping.ts
 * forgets it 90 days later). Behind the dashboard's session and a fresh sudo
 * grant, like the other destructive "manage" actions. The revocation goes on
 * the workspace's audit trail (GET /api/tokens/audit).
 *
 *   → { "ok": true }
 *
 * 200 ok (idempotent: revoking an already-revoked token still answers ok) ·
 * 401 no session · 403 foreign origin, demo mode, or no sudo grant ·
 * 404 no token with this id · 409 tokens_busy (a rotation is running; try again) · 503 Redis down
 */

type Params = { id: string };

export async function DELETE(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { id } = await context.params;
  return withApiHandler("api/tokens/[id]", async ({ request }) => {
    const origin = requireSameOrigin(request);
    if (origin) return origin;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;
    const tenant = await requireTenantSession();
    if (tenant instanceof Response) return tenant;
    const { store } = tenant;
    if (!(await hasSudo())) return apiError("sudo_required", 403);

    const now = new Date();
    const result = await revokeToken(store, id, now, tokenAudit("token_revoked", tenant, now));
    if (!result.ok) return result.reason === "busy" ? apiError("tokens_busy", 409) : apiError("not_found", 404);
    return json({ ok: true }, 200);
  })(request);
}

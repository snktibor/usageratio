import { apiError, json, requireSameOrigin, requireTenantSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { tokenAudit } from "@/lib/token-audit";
import { MAX_TOKEN_ENTRIES, rotateToken } from "@/lib/tokens";

/**
 * POST /api/tokens/[id]/rotate — replaces a live per-machine token with a fresh one (lib/tokens.ts
 * `rotateToken`): same label, machine and scope, a new secret; the old one is revoked in the same
 * step. The new plaintext is in the answer, once. Needs sudo, like creating one; on the audit trail.
 *
 *   → 200 { "id": "tk_…", "token": "ur_live_…" }
 *
 * 401 no session · 403 foreign origin, demo mode, or no sudo grant · 404 no token with this id ·
 * 409 token_revoked (already revoked) / tokens_busy (another revoke or rotate is running; try
 * again) · 412 tenant_changed · 422 too_many_tokens (the workspace keeps too many revoked tokens
 * still; they are forgotten 90 days after revocation) · 503 Redis down
 */

type Params = { id: string };

export async function POST(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { id } = await context.params;
  return withApiHandler("api/tokens/[id]/rotate", async () => {
    const origin = requireSameOrigin(request);
    if (origin) return origin;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;
    const tenant = await requireTenantSession();
    if (tenant instanceof Response) return tenant;
    if (!(await hasSudo())) return apiError("sudo_required", 403);

    const now = new Date();
    const result = await rotateToken(tenant.store, id, now, tokenAudit("token_rotated", tenant, now));
    if (!result.ok) {
      if (result.reason === "not_found") return apiError("not_found", 404);
      if (result.reason === "too_many") return apiError("too_many_tokens", 422, { limit: MAX_TOKEN_ENTRIES });
      return apiError(result.reason === "revoked" ? "token_revoked" : "tokens_busy", 409);
    }
    return json({ id: result.id, token: result.token }, 200);
  })(request);
}

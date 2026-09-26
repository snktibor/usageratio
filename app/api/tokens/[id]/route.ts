import { apiError, json, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { revokeToken } from "@/lib/tokens";

/**
 * DELETE /api/tokens/[id] — revokes one per-machine API token (lib/tokens.ts):
 * sets `revokedAt`, never deletes the entry outright (lib/housekeeping.ts
 * forgets it 90 days later). Behind the dashboard's session and a fresh sudo
 * grant, like the other destructive "manage" actions.
 *
 *   → { "ok": true }
 *
 * 200 ok (idempotent: revoking an already-revoked token still answers ok) ·
 * 401 no session · 403 foreign origin, demo mode, or no sudo grant ·
 * 404 no token with this id · 503 Redis down
 */

type Params = { id: string };

export async function DELETE(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { id } = await context.params;
  return withApiHandler("api/tokens/[id]", async ({ request }) => {
    const origin = requireSameOrigin(request);
    if (origin) return origin;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;
    const unauthorized = await requireSession();
    if (unauthorized) return unauthorized;
    if (!(await hasSudo())) return apiError("sudo_required", 403);

    const result = await revokeToken(id, new Date());
    if (!result.ok) return apiError("not_found", 404);
    return json({ ok: true }, 200);
  })(request);
}

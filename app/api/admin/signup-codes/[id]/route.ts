import { requireAdmin } from "@/lib/admin-guard";
import { apiError, json, requireSameOrigin, withApiHandler } from "@/lib/api";
import { revokeSignupCode } from "@/lib/signup-codes";

/**
 * DELETE /api/admin/signup-codes/[id] — revokes a sign-up code that has not been used.
 * 200 · 403 foreign origin · 404 not an admin, or no such unused code
 */

type Params = { id: string };

export async function DELETE(request: Request, context: { params: Promise<Params> }): Promise<Response> {
  const { id } = await context.params;
  return withApiHandler("api/admin/signup-codes/[id]", async () => {
    const foreign = requireSameOrigin(request);
    if (foreign) return foreign;
    const admin = await requireAdmin();
    if (admin instanceof Response) return admin;
    if (!/^sc_[A-Za-z0-9_-]{8}$/.test(id) || !(await revokeSignupCode(id))) return apiError("not_found", 404);
    return json({ ok: true }, 200);
  })(request);
}

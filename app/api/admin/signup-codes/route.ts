import { requireAdmin } from "@/lib/admin-guard";
import { json, requireSameOrigin, withApiHandler } from "@/lib/api";
import { publicOrigin } from "@/lib/github";
import { createSignupCode } from "@/lib/signup-codes";

/**
 * POST /api/admin/signup-codes — issues a sign-up code (lib/signup-codes.ts). The link carries the
 * code in its fragment, `/signup#code`, and is shown once: only the code's hash is kept.
 *
 *   → 201 { "id", "url": "https://…/signup#…", "entry": SignupCodeEntry }
 *
 * 403 foreign origin · 404 not an admin
 */

export const POST = withApiHandler("api/admin/signup-codes", async ({ request, url }) => {
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const { id, code, entry } = await createSignupCode(admin.userId, new Date());
  return json({ id, url: `${publicOrigin(url)}/signup#${code}`, entry }, 201);
});

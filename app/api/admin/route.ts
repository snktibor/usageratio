import { adminOverview } from "@/lib/admin";
import { requireAdmin } from "@/lib/admin-guard";
import { json, withApiHandler } from "@/lib/api";
import { listSignupCodes } from "@/lib/signup-codes";

/**
 * GET /api/admin — the instance admin's overview: counts per tenant and the sign-up codes. Never a
 * tenant's data (lib/admin.ts). 404 for everyone but an admin listed in ADMIN_GITHUB_IDS.
 */

export const GET = withApiHandler("api/admin", async () => {
  const admin = await requireAdmin();
  if (admin instanceof Response) return admin;
  const [overview, signupCodes] = await Promise.all([adminOverview(), listSignupCodes()]);
  return json({ overview, signupCodes }, 200);
});

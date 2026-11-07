import { isInstanceAdmin } from "@/lib/admin";
import { apiError, requireUserSession } from "@/lib/api";
import type { UserSession } from "@/lib/user-session";

/**
 * The admin routes' guard: a signed-in instance admin, or 404, the same answer a single-user
 * instance and a stranger get, so the admin pages do not even reveal that they exist.
 */
export async function requireAdmin(): Promise<Response | UserSession> {
  const session = await requireUserSession();
  if (session instanceof Response) return session.status === 401 ? apiError("not_found", 404) : session;
  return (await isInstanceAdmin(session.userId)) ? session : apiError("not_found", 404);
}

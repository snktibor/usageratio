import { json, requireSameOrigin, requireUserSession, withApiHandler } from "@/lib/api";
import { clearCookie } from "@/lib/cookies";
import { isHttpsRequest } from "@/lib/request-context";
import { endAllUserSessions, sessionCookieName } from "@/lib/user-session";

/**
 * DELETE /api/account/sessions — signs the user out everywhere: every session of theirs, on
 * every device, this one included (its cookie is cleared). Multi-tenant mode only.
 *
 * 200 { "ended": n } · 401 no session · 403 foreign origin · 404 single-user instance
 */

export const DELETE = withApiHandler("api/account/sessions", async ({ request }) => {
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const session = await requireUserSession();
  if (session instanceof Response) return session;
  const ended = await endAllUserSessions(session.userId);
  return json({ ended }, 200, { "Set-Cookie": clearCookie(await sessionCookieName(), await isHttpsRequest()) });
});

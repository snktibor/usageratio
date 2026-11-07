import { deleteAccount, loadAccount } from "@/lib/account";
import { apiError, json, requireSameOrigin, requireUserSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { clearCookie } from "@/lib/cookies";
import { isHttpsRequest } from "@/lib/request-context";
import { sessionCookieName } from "@/lib/user-session";

/**
 * /api/account — the signed-in user's own account (multi-tenant mode; 404 on a single-user instance).
 *
 *   GET    → { "account": { login, createdAt, workspaces: [{ tenantId, name, role, members, current }],
 *              sessions: [{ tag, label, createdAt, seenAt, current }] } }
 *   DELETE → { "ok": true, "workspacesDeleted", "workspacesLeft" } and the session cookie cleared.
 *            Needs sudo. 409 owns_shared_workspace (with `tenantIds`): hand those over first;
 *            409 owns_default_workspace: the instance's original data is never deleted this way;
 *            409 members_busy: a shared workspace's members are changing right now, try again.
 *
 * 401 no session · 403 foreign origin / sudo_required · 404 single-user instance · 503 Redis down
 */

export const GET = withApiHandler("api/account", async () => {
  const session = await requireUserSession();
  if (session instanceof Response) return session;
  const account = await loadAccount(session.userId, { sessionHash: session.hash, tenantId: session.tenantId });
  if (!account) return apiError("unauthorized", 401);
  return json({ account }, 200);
});

export const DELETE = withApiHandler("api/account", async ({ request }) => {
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const session = await requireUserSession();
  if (session instanceof Response) return session;
  if (!(await hasSudo())) return apiError("sudo_required", 403);

  const result = await deleteAccount(session.userId, new Date());
  if (!result.ok) {
    if (result.reason === "not_found") return apiError("unauthorized", 401);
    if (result.reason === "members_busy") return apiError("members_busy", 409);
    return apiError(result.reason, 409, { tenantIds: result.tenantIds });
  }
  const cookie = clearCookie(await sessionCookieName(), await isHttpsRequest());
  return json({ ok: true, workspacesDeleted: result.workspacesDeleted, workspacesLeft: result.workspacesLeft }, 200, {
    "Set-Cookie": cookie,
  });
});

import {
  apiError,
  json,
  readJsonBody,
  requireMultiTenant,
  requireOwner,
  requireSameOrigin,
  requireTenantSession,
  withApiHandler,
} from "@/lib/api";
import { githubConfig } from "@/lib/github";
import { createInvite, MAX_PENDING_INVITES, normalizeLogin } from "@/lib/invites";

/**
 * POST /api/workspace/invites — the owner invites someone into the current workspace
 * (lib/invites.ts). The link carries the code in its fragment, `/join#code`, and is shown once:
 * only the code's hash is kept. It lets one person in, as a member, within 7 days.
 *
 *   { "login"?: "octocat" | null }     only this GitHub account may accept it
 *   → 201 { "url": "https://…/join#…", "entry": InviteEntry }
 *
 * 400 bad body or login · 401 no session · 403 foreign origin / owner_only · 404 single-user
 * instance · 409 tenant_changed · 422 too_many_invites (10 pending) · 503 Redis down
 */

export const POST = withApiHandler("api/workspace/invites", async ({ request, url }) => {
  const closed = requireMultiTenant();
  if (closed) return closed;
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  const notOwner = requireOwner(tenant);
  if (notOwner) return notOwner;

  const body = await readJsonBody(request, { maxBytes: 1024 });
  if (!body.ok) return body.response;
  const raw = (body.value as { login?: unknown } | null)?.login;
  let login: string | null = null;
  if (raw !== undefined && raw !== null && raw !== "") {
    login = typeof raw === "string" ? normalizeLogin(raw) : null;
    if (!login) return apiError("invalid_payload", 400, { details: ["login must be a GitHub login"] });
  }

  const result = await createInvite(tenant.store.tenantId, tenant.userId ?? "", login, new Date());
  if (!result.ok) return apiError("too_many_invites", 422, { limit: MAX_PENDING_INVITES });
  const origin = githubConfig() ? new URL(githubConfig()!.redirectUri).origin : url.origin;
  return json({ url: `${origin}/join#${result.code}`, entry: result.entry }, 201);
});

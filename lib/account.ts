import { leaveWorkspace } from "@/lib/members";
import { getRedis, toStringRecord } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { deleteTenant } from "@/lib/tenant-deletion";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";
import { loadTenantRecord } from "@/lib/tenants";
import { endAllUserSessions, listLiveSessions } from "@/lib/user-session";
import { loadUser, type Role, userTenants } from "@/lib/users";

/**
 * A signed-in user's own account (multi-tenant mode): what the account page
 * shows, and deleting the account. Deletion follows the rules in the design:
 * a user who owns a workspace other people belong to has to hand it over
 * first; a workspace only they belong to goes with them; from the others they
 * simply leave. The default tenant (a single-user instance's data) is never
 * deleted this way.
 */

export interface AccountSession {
  /** A short, non-secret tag of the session (the first characters of its hash). */
  tag: string;
  label: string;
  createdAt: number;
  seenAt: number;
  current: boolean;
}

export interface AccountView {
  login: string;
  createdAt: number;
  workspaces: { tenantId: TenantId; name: string; role: Role; members: number; current: boolean }[];
  sessions: AccountSession[];
}

export async function loadAccount(
  userId: string,
  current: { sessionHash: string; tenantId: TenantId | null },
): Promise<AccountView | null> {
  const user = await loadUser(userId);
  if (!user) return null;
  const redis = getRedis();

  const memberships = await userTenants(userId);
  const workspaces = await Promise.all(
    memberships.map(async ({ tenantId, role }) => ({
      tenantId,
      name: (await loadTenantRecord(tenantId))?.name ?? tenantId,
      role,
      members: Number(await redis.hlen(GLOBAL_KEYS.tenantMembers(tenantId))),
      current: tenantId === current.tenantId,
    })),
  );

  const sessions: AccountSession[] = (await listLiveSessions(userId)).map((session) => ({
    tag: session.hash.slice(0, 8),
    label: session.label,
    createdAt: session.createdAt,
    seenAt: session.seenAt,
    current: session.hash === current.sessionHash,
  }));
  return { login: user.login, createdAt: user.createdAt, workspaces, sessions };
}

export type DeleteAccountResult =
  | { ok: true; workspacesDeleted: number; workspacesLeft: number }
  | { ok: false; reason: "owns_shared_workspace" | "owns_default_workspace"; tenantIds: TenantId[] }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "members_busy" };

export async function deleteAccount(userId: string, now: Date): Promise<DeleteAccountResult> {
  const redis = getRedis();
  if (!(await loadUser(userId))) return { ok: false, reason: "not_found" };
  const memberships = await userTenants(userId);

  const owned = memberships.filter((entry) => entry.role === "owner").map((entry) => entry.tenantId);
  if (owned.includes(DEFAULT_TENANT))
    return { ok: false, reason: "owns_default_workspace", tenantIds: [DEFAULT_TENANT] };
  const shared: TenantId[] = [];
  for (const tenantId of owned) {
    if (Number(await redis.hlen(GLOBAL_KEYS.tenantMembers(tenantId))) > 1) shared.push(tenantId);
  }
  if (shared.length > 0) return { ok: false, reason: "owns_shared_workspace", tenantIds: shared };

  // The shared workspaces first, each under its members lock: an owner handing a workspace to this
  // user at the same moment must not make a deleted user its owner. A lock held elsewhere stops
  // the deletion before anything is deleted; it can simply be tried again.
  let workspacesLeft = 0;
  for (const { tenantId, role } of memberships) {
    if (role === "owner") continue;
    const left = await leaveWorkspace(tenantId, userId);
    if (!left.ok && left.reason === "busy") return { ok: false, reason: "members_busy" };
    // "owner_cannot_leave": handed this user the workspace a moment ago; it is shared, so stop.
    if (!left.ok && left.reason === "owner_cannot_leave") {
      return { ok: false, reason: "owns_shared_workspace", tenantIds: [tenantId] };
    }
    workspacesLeft += 1;
  }
  let workspacesDeleted = 0;
  for (const tenantId of owned) {
    if ((await deleteTenant(tenantId, now)).ok) workspacesDeleted += 1;
  }

  await endAllUserSessions(userId);
  const identities = ((await redis.smembers(GLOBAL_KEYS.userIdentities(userId))) as unknown[]).map(String);
  const tx = redis.multi();
  for (const identity of identities) {
    const githubId = Number(identity.startsWith("github:") ? identity.slice("github:".length) : Number.NaN);
    if (Number.isSafeInteger(githubId)) tx.del(GLOBAL_KEYS.githubIdentity(githubId));
  }
  tx.del(GLOBAL_KEYS.userIdentities(userId));
  tx.del(GLOBAL_KEYS.userTenants(userId));
  tx.del(GLOBAL_KEYS.userSessions(userId));
  tx.del(GLOBAL_KEYS.user(userId));
  await tx.exec();
  return { ok: true, workspacesDeleted, workspacesLeft };
}

/** The user ids of a tenant's members (for tests and the admin's counts). */
export async function tenantMemberIds(tenantId: TenantId): Promise<string[]> {
  return Object.keys(toStringRecord(await getRedis().hgetall(GLOBAL_KEYS.tenantMembers(tenantId))));
}

import { randomBytes } from "node:crypto";
import type { GithubUser } from "@/lib/github";
import { getRedis, toStringRecord } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { isTenantId, type TenantId } from "@/lib/tenant-id";
import { serializeTenantRecord } from "@/lib/tenants";

/**
 * People and their workspaces (multi-tenant mode). A **user** is a person; an
 * **identity** is one way they sign in (only GitHub for now, by its numeric
 * id, so a renamed or recycled login can never take over an account); a
 * **membership** is their role in one tenant. A user may belong to several
 * tenants, and a tenant may have several members. See lib/redis-keys.ts for
 * the keys. Nothing here trusts a client: every id comes from GitHub's own
 * answer or from the server's records.
 */

export type Role = "owner" | "member";

export interface UserRecord {
  v: 1;
  /** The GitHub login at the last sign-in: display only, never a key. */
  login: string;
  createdAt: number;
  lastLoginAt: number;
}

const USER_ID_PATTERN = /^u_[A-Za-z0-9_-]{22}$/;

export function isUserId(value: string): boolean {
  return USER_ID_PATTERN.test(value);
}

function newUserId(): string {
  return `u_${randomBytes(16).toString("base64url")}`;
}

/** A new tenant id: 128 random bits, base64url (22 characters). */
export function newTenantId(): TenantId {
  return randomBytes(16).toString("base64url") as TenantId;
}

function parseUser(raw: unknown): UserRecord | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<UserRecord>;
    if (value?.v !== 1 || typeof value.login !== "string" || typeof value.createdAt !== "number") return null;
    return { v: 1, login: value.login, createdAt: value.createdAt, lastLoginAt: Number(value.lastLoginAt) || 0 };
  } catch {
    return null;
  }
}

export async function loadUser(userId: string): Promise<UserRecord | null> {
  if (!isUserId(userId)) return null;
  return parseUser(await getRedis().get(GLOBAL_KEYS.user(userId)));
}

/** The user a GitHub account signs in as; null for an account the instance has never seen. */
export async function userForGithub(githubId: number): Promise<string | null> {
  const raw = await getRedis().get<string>(GLOBAL_KEYS.githubIdentity(githubId));
  const userId = raw === null || raw === undefined ? null : String(raw);
  return userId !== null && isUserId(userId) ? userId : null;
}

/**
 * The user for this GitHub account, created if there is none yet. Two
 * callbacks racing for the same new account agree on one user: the identity
 * is claimed with SET NX, and the loser reads the winner's id.
 */
export async function findOrCreateGithubUser(
  github: GithubUser,
  now: Date,
): Promise<{ userId: string; created: boolean }> {
  const existing = await userForGithub(github.id);
  if (existing) {
    await touchUser(existing, github.login, now);
    return { userId: existing, created: false };
  }
  const redis = getRedis();
  const userId = newUserId();
  const claimed = await redis.set(GLOBAL_KEYS.githubIdentity(github.id), userId, { nx: true });
  if (claimed !== "OK") {
    const winner = await userForGithub(github.id);
    if (!winner) throw new Error("identity claimed but unreadable");
    await touchUser(winner, github.login, now);
    return { userId: winner, created: false };
  }
  const record: UserRecord = { v: 1, login: github.login, createdAt: now.getTime(), lastLoginAt: now.getTime() };
  const tx = redis.multi();
  tx.set(GLOBAL_KEYS.user(userId), JSON.stringify(record));
  tx.sadd(GLOBAL_KEYS.userIdentities(userId), `github:${github.id}`);
  await tx.exec();
  return { userId, created: true };
}

/** Keeps the login current (GitHub logins can be renamed) and stamps the sign-in. */
async function touchUser(userId: string, login: string, now: Date): Promise<void> {
  const current = await loadUser(userId);
  const record: UserRecord = {
    v: 1,
    login,
    createdAt: current?.createdAt ?? now.getTime(),
    lastLoginAt: now.getTime(),
  };
  await getRedis().set(GLOBAL_KEYS.user(userId), JSON.stringify(record));
}

/** Whether `userId` signs in with this GitHub account. */
export async function hasGithubIdentity(userId: string, githubId: number): Promise<boolean> {
  return Number(await getRedis().sismember(GLOBAL_KEYS.userIdentities(userId), `github:${githubId}`)) === 1;
}

/** A new workspace owned by `userId`. */
export async function createTenantFor(userId: string, name: string, now: Date): Promise<TenantId> {
  const tenantId = newTenantId();
  const tx = getRedis().multi();
  tx.set(
    GLOBAL_KEYS.tenantRecord(tenantId),
    serializeTenantRecord({ v: 1, name, createdAt: now.getTime(), status: "active" }),
  );
  tx.zadd(GLOBAL_KEYS.tenants, { score: now.getTime(), member: tenantId });
  tx.hset(GLOBAL_KEYS.tenantMembers(tenantId), {
    [userId]: JSON.stringify({ role: "owner", joinedAt: now.getTime() }),
  });
  tx.hset(GLOBAL_KEYS.userTenants(userId), { [tenantId]: "owner" });
  await tx.exec();
  return tenantId;
}

/** Makes `userId` the owner of `tenantId` (the default tenant's owner, set by migrate:tenant). Idempotent. */
export async function addOwner(tenantId: TenantId, userId: string, now: Date): Promise<void> {
  const tx = getRedis().multi();
  tx.hsetnx(GLOBAL_KEYS.tenantMembers(tenantId), userId, JSON.stringify({ role: "owner", joinedAt: now.getTime() }));
  tx.hsetnx(GLOBAL_KEYS.userTenants(userId), tenantId, "owner");
  await tx.exec();
}

function roleOf(raw: unknown): Role | null {
  if (typeof raw !== "string") return null;
  try {
    const role = (JSON.parse(raw) as { role?: unknown }).role;
    return role === "owner" || role === "member" ? role : null;
  } catch {
    return null;
  }
}

/** `userId`'s role in `tenantId`, read from the tenant's own members hash; null when not a member. */
export async function membershipRole(tenantId: TenantId, userId: string): Promise<Role | null> {
  return roleOf(await getRedis().hget(GLOBAL_KEYS.tenantMembers(tenantId), userId));
}

/** The tenants `userId` belongs to, as the user's own index lists them, owned ones first. */
export async function userTenants(userId: string): Promise<{ tenantId: TenantId; role: Role }[]> {
  const raw = toStringRecord(await getRedis().hgetall(GLOBAL_KEYS.userTenants(userId)));
  return Object.entries(raw)
    .flatMap(([tenantId, role]) =>
      isTenantId(tenantId) && (role === "owner" || role === "member") ? [{ tenantId, role: role as Role }] : [],
    )
    .sort((a, b) => (a.role === b.role ? a.tenantId.localeCompare(b.tenantId) : a.role === "owner" ? -1 : 1));
}

import { randomBytes } from "node:crypto";
import { getRedis, toStringRecord } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import type { TenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { revokeTokensCreatedBy } from "@/lib/tokens";
import { isUserId, type Role } from "@/lib/users";

/**
 * A workspace's people (multi-tenant mode): who belongs to it, and the changes
 * an owner or a member can make to that. A workspace has exactly one owner;
 * everyone else is a member. Each membership is written twice, in the
 * tenant's members hash (the one every request checks) and in the user's own
 * tenants hash (for their list of workspaces), always in one transaction.
 *
 * Removing a member, leaving and handing ownership over each read the members
 * first and then write, so they hold the tenant's lock while they do: two of
 * them at once (an owner handing over to someone who is leaving that moment)
 * could otherwise leave the workspace without its owner.
 */

export interface Member {
  userId: string;
  login: string;
  role: Role;
  joinedAt: number;
  /** The userId of the owner whose invite brought them in; null for the owner who created the workspace. */
  invitedBy: string | null;
}

interface MembershipValue {
  role: Role;
  joinedAt: number;
  invitedBy?: string;
}

function parseMembership(raw: unknown): MembershipValue | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.role !== "owner" && value.role !== "member") return null;
    return {
      role: value.role,
      joinedAt: Number(value.joinedAt) || 0,
      ...(typeof value.invitedBy === "string" && { invitedBy: value.invitedBy }),
    };
  } catch {
    return null;
  }
}

/** The workspace's people: the owner first, then the members in the order they joined. */
export async function listMembers(tenantId: TenantId): Promise<Member[]> {
  const raw = toStringRecord(await getRedis().hgetall(GLOBAL_KEYS.tenantMembers(tenantId)));
  const entries = Object.entries(raw).flatMap(([userId, value]) => {
    const membership = parseMembership(value);
    return membership && isUserId(userId) ? [{ userId, membership }] : [];
  });
  if (entries.length === 0) return [];
  const users = (await getRedis().mget(...entries.map(({ userId }) => GLOBAL_KEYS.user(userId)))) as unknown[];
  return entries
    .map(({ userId, membership }, index) => ({
      userId,
      login: loginOf(users[index]),
      role: membership.role,
      joinedAt: membership.joinedAt,
      invitedBy: membership.invitedBy ?? null,
    }))
    .sort((a, b) => (a.role === b.role ? a.joinedAt - b.joinedAt : a.role === "owner" ? -1 : 1));
}

function loginOf(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  try {
    const value = (typeof raw === "string" ? JSON.parse(raw) : raw) as { login?: unknown };
    return typeof value.login === "string" ? value.login : "";
  } catch {
    return "";
  }
}

/**
 * Makes `userId` a member of `tenantId` (an accepted invite). Someone who
 * already belongs keeps their membership as it is (HSETNX): an invite can
 * never turn an owner into a member.
 */
export async function addMember(
  tenantId: TenantId,
  userId: string,
  invitedBy: string,
  now: Date,
): Promise<"added" | "already"> {
  const value: MembershipValue = { role: "member", joinedAt: now.getTime(), invitedBy };
  const added = Number(await getRedis().hsetnx(GLOBAL_KEYS.tenantMembers(tenantId), userId, JSON.stringify(value)));
  if (added !== 1) return "already";
  await getRedis().hset(GLOBAL_KEYS.userTenants(userId), { [tenantId]: "member" });
  return "added";
}

const LOCK_SECONDS = 10;

/** Runs `fn` holding the tenant's members lock; "busy" when another change holds it. */
async function withTenantLock<T>(tenantId: TenantId, fn: () => Promise<T>): Promise<T | "busy"> {
  const key = GLOBAL_KEYS.tenantLock(tenantId);
  const holder = randomBytes(9).toString("base64url");
  if ((await getRedis().set(key, holder, { nx: true, ex: LOCK_SECONDS })) !== "OK") return "busy";
  try {
    return await fn();
  } finally {
    // Only our own lock: one that ran past its expiry may be someone else's by now.
    if ((await getRedis().get(key)) === holder) await getRedis().del(key);
  }
}

async function membership(tenantId: TenantId, userId: string): Promise<MembershipValue | null> {
  return parseMembership(await getRedis().hget(GLOBAL_KEYS.tenantMembers(tenantId), userId));
}

async function dropMembership(tenantId: TenantId, userId: string): Promise<void> {
  const tx = getRedis().multi();
  tx.hdel(GLOBAL_KEYS.tenantMembers(tenantId), userId);
  tx.hdel(GLOBAL_KEYS.userTenants(userId), tenantId);
  await tx.exec();
}

export type RemoveMemberResult =
  | { ok: true; tokensRevoked: number }
  | { ok: false; reason: "not_found" | "is_owner" | "busy" };

/**
 * The owner removes a member. Their sessions lose the workspace on their next
 * request (every request re-reads the members hash). With `revokeTokens`, the
 * machine tokens they created are revoked too; without, the machines keep
 * reporting.
 */
export async function removeMember(
  store: TenantStore,
  userId: string,
  options: { revokeTokens: boolean },
  now: Date,
): Promise<RemoveMemberResult> {
  const { tenantId } = store;
  const result = await withTenantLock(tenantId, async (): Promise<RemoveMemberResult> => {
    const current = await membership(tenantId, userId);
    if (!current) return { ok: false, reason: "not_found" };
    if (current.role === "owner") return { ok: false, reason: "is_owner" };
    await dropMembership(tenantId, userId);
    const tokensRevoked = options.revokeTokens ? await revokeTokensCreatedBy(store, userId, now) : 0;
    return { ok: true, tokensRevoked };
  });
  return result === "busy" ? { ok: false, reason: "busy" } : result;
}

export type LeaveResult = { ok: true } | { ok: false; reason: "not_found" | "owner_cannot_leave" | "busy" };

/** A member leaves. The tokens they created stay: the workspace keeps its machines. The owner hands over first. */
export async function leaveWorkspace(tenantId: TenantId, userId: string): Promise<LeaveResult> {
  const result = await withTenantLock(tenantId, async (): Promise<LeaveResult> => {
    const current = await membership(tenantId, userId);
    if (!current) return { ok: false, reason: "not_found" };
    if (current.role === "owner") return { ok: false, reason: "owner_cannot_leave" };
    await dropMembership(tenantId, userId);
    return { ok: true };
  });
  return result === "busy" ? { ok: false, reason: "busy" } : result;
}

export type TransferResult = { ok: true } | { ok: false; reason: "not_owner" | "not_member" | "busy" };

/**
 * The owner hands the workspace to one of its members: they become the owner
 * and the old owner a member, in one transaction, so the workspace never has
 * two owners or none.
 */
export async function transferOwnership(
  tenantId: TenantId,
  fromUserId: string,
  toUserId: string,
): Promise<TransferResult> {
  const result = await withTenantLock(tenantId, async (): Promise<TransferResult> => {
    const from = await membership(tenantId, fromUserId);
    if (from?.role !== "owner") return { ok: false, reason: "not_owner" };
    const to = fromUserId === toUserId ? null : await membership(tenantId, toUserId);
    if (to?.role !== "member") return { ok: false, reason: "not_member" };
    const tx = getRedis().multi();
    tx.hset(GLOBAL_KEYS.tenantMembers(tenantId), {
      [toUserId]: JSON.stringify({ ...to, role: "owner" }),
      [fromUserId]: JSON.stringify({ ...from, role: "member" }),
    });
    tx.hset(GLOBAL_KEYS.userTenants(toUserId), { [tenantId]: "owner" });
    tx.hset(GLOBAL_KEYS.userTenants(fromUserId), { [tenantId]: "member" });
    await tx.exec();
    return { ok: true };
  });
  return result === "busy" ? { ok: false, reason: "busy" } : result;
}

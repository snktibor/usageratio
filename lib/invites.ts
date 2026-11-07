import { randomBytes } from "node:crypto";
import { LOGIN_PATTERN } from "@/lib/github";
import { getRedis, toStringRecord } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { sha256Hex } from "@/lib/security";
import { isTenantId, type TenantId } from "@/lib/tenant-id";

/**
 * Workspace invites (multi-tenant mode): an owner's single-use link that lets
 * one more person into the workspace, as a member, never as its owner. The
 * code is 256 random bits; only its hash is stored, under
 * `usage:invite:{sha256(code)}` with the expiry as its TTL, plus a listing
 * entry in the tenant's invites hash for the members page. The link carries
 * the code in the URL fragment (`/join#code`), which a browser never sends to
 * a server. Accepting takes the code with GETDEL, so it works exactly once.
 *
 * An invite may name a GitHub login: then only the account with that login
 * (at the moment it accepts) can use it. GitHub logins are case-insensitive.
 */

export const INVITE_DAYS = 7;
/** Pending invites a workspace may have at once (the design's quota table). */
export const MAX_PENDING_INVITES = 10;
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVITE_ID_PATTERN = /^iv_[A-Za-z0-9_-]{8}$/;

export interface InviteEntry {
  id: string;
  createdAt: number;
  expiresAt: number;
  /** The userId of the owner who created it. */
  createdBy: string;
  /** The only GitHub login that may accept it; null for anyone with the link. */
  login: string | null;
}

/** What the invite key itself holds: enough to accept it without reading the listing. */
export interface InviteTarget {
  tenantId: TenantId;
  inviteId: string;
  login: string | null;
  /** The owner who created it: the new member's `invitedBy`. */
  createdBy: string;
}

export function isInviteCodeShape(code: string): boolean {
  return CODE_PATTERN.test(code);
}

export function isInviteId(id: string): boolean {
  return INVITE_ID_PATTERN.test(id);
}

export function inviteHash(code: string): string {
  return sha256Hex(code);
}

/** A login as an invite stores it: trimmed, an optional leading @ dropped, lowercase; null when it is not a login. */
export function normalizeLogin(raw: string): string | null {
  const login = raw.trim().replace(/^@/, "");
  return LOGIN_PATTERN.test(login) ? login.toLowerCase() : null;
}

function parseEntry(id: string, raw: string): (InviteEntry & { hash: string }) | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.hash !== "string") return null;
    return {
      id,
      hash: value.hash,
      createdAt: Number(value.createdAt) || 0,
      expiresAt: Number(value.expiresAt) || 0,
      createdBy: String(value.createdBy ?? ""),
      login: typeof value.login === "string" ? value.login : null,
    };
  } catch {
    return null;
  }
}

async function listedEntries(tenantId: TenantId): Promise<(InviteEntry & { hash: string })[]> {
  const raw = toStringRecord(await getRedis().hgetall(GLOBAL_KEYS.tenantInvites(tenantId)));
  return Object.entries(raw).flatMap(([id, value]) => {
    const entry = parseEntry(id, value);
    return entry ? [entry] : [];
  });
}

/** The tenant's invites that can still be accepted, newest first, without their hashes. */
export async function listInvites(tenantId: TenantId, now: Date): Promise<InviteEntry[]> {
  return (await listedEntries(tenantId))
    .filter((entry) => entry.expiresAt > now.getTime())
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(({ hash: _, ...entry }) => entry);
}

export type CreateInviteResult =
  | { ok: true; code: string; entry: InviteEntry }
  | { ok: false; reason: "too_many_invites" };

/** Issues an invite into `tenantId`; the plaintext code is returned once and never stored. */
export async function createInvite(
  tenantId: TenantId,
  createdBy: string,
  login: string | null,
  now: Date,
): Promise<CreateInviteResult> {
  if ((await listInvites(tenantId, now)).length >= MAX_PENDING_INVITES)
    return { ok: false, reason: "too_many_invites" };
  const code = randomBytes(32).toString("base64url");
  const id = `iv_${randomBytes(6).toString("base64url")}`;
  const hash = inviteHash(code);
  const expiresAt = now.getTime() + INVITE_DAYS * 86_400_000;
  const target = { tenantId, inviteId: id, createdBy, ...(login && { login }) };
  const tx = getRedis().multi();
  tx.set(GLOBAL_KEYS.invite(hash), JSON.stringify(target), { ex: INVITE_DAYS * 86_400 });
  tx.hset(GLOBAL_KEYS.tenantInvites(tenantId), {
    [id]: JSON.stringify({ hash, createdAt: now.getTime(), expiresAt, createdBy, ...(login && { login }) }),
  });
  await tx.exec();
  return { ok: true, code, entry: { id, createdAt: now.getTime(), expiresAt, createdBy, login } };
}

function parseTarget(raw: unknown): InviteTarget | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(String(raw)) as Record<string, unknown>;
    if (typeof value.tenantId !== "string" || !isTenantId(value.tenantId)) return null;
    if (typeof value.inviteId !== "string") return null;
    return {
      tenantId: value.tenantId,
      inviteId: value.inviteId,
      login: typeof value.login === "string" ? value.login : null,
      createdBy: typeof value.createdBy === "string" ? value.createdBy : "",
    };
  } catch {
    return null;
  }
}

/** The invite with this hash, while it can still be accepted; null otherwise. Reads only. */
export async function peekInvite(hash: string): Promise<InviteTarget | null> {
  return parseTarget(await getRedis().get(GLOBAL_KEYS.invite(hash)));
}

/**
 * Takes the invite with this hash out of the store, with its listing entry;
 * what it pointed to when it was live, null when it was not (used, revoked,
 * expired), so two callbacks racing for one invite get it once between them.
 */
export async function consumeInvite(hash: string): Promise<InviteTarget | null> {
  const target = parseTarget(await getRedis().getdel(GLOBAL_KEYS.invite(hash)));
  if (target) await getRedis().hdel(GLOBAL_KEYS.tenantInvites(target.tenantId), target.inviteId);
  return target;
}

/** Revokes one of the tenant's invites; true when there was one to revoke. */
export async function revokeInvite(tenantId: TenantId, inviteId: string): Promise<boolean> {
  const listed = await getRedis().hget<string>(GLOBAL_KEYS.tenantInvites(tenantId), inviteId);
  if (listed === null || listed === undefined) return false;
  const entry = parseEntry(inviteId, String(listed));
  const tx = getRedis().multi();
  if (entry) tx.del(GLOBAL_KEYS.invite(entry.hash));
  tx.hdel(GLOBAL_KEYS.tenantInvites(tenantId), inviteId);
  await tx.exec();
  return true;
}

/** Housekeeping: drops listing entries whose invite has expired (the invite key itself is gone by its TTL). */
export async function pruneExpiredInvites(tenantId: TenantId, now: Date, dryRun = false): Promise<number> {
  const expired = (await listedEntries(tenantId)).filter((entry) => entry.expiresAt <= now.getTime());
  if (!dryRun && expired.length > 0) {
    await getRedis().hdel(
      GLOBAL_KEYS.tenantInvites(tenantId),
      ...(expired.map((entry) => entry.id) as [string, ...string[]]),
    );
  }
  return expired.length;
}

/** Every invite key of the tenant, listed or not yet expired: tenant deletion removes them all. */
export async function deleteTenantInvites(tenantId: TenantId): Promise<void> {
  const entries = await listedEntries(tenantId);
  const tx = getRedis().multi();
  for (const entry of entries) tx.del(GLOBAL_KEYS.invite(entry.hash));
  tx.del(GLOBAL_KEYS.tenantInvites(tenantId));
  await tx.exec();
}

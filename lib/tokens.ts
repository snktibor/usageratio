import { randomBytes } from "node:crypto";
import { AUDIT_LIMIT, type AuditToken } from "@/lib/api-token";
import { getRedis, toStringRecord } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { defer } from "@/lib/request-context";
import { sha256Hex } from "@/lib/security";
import type { TenantStore } from "@/lib/tenant";
import { isTenantId, type TenantId } from "@/lib/tenant-id";

/**
 * Per-machine API tokens: an alternative to the one shared `USAGE_API_TOKEN`
 * that can be individually revoked. Stored in the `usage:tokens` HASH
 * (lib/redis-keys.ts): field = `sha256Hex(token)`, value = this module's JSON.
 * The plaintext is generated once, returned to the caller of `createToken`,
 * and never stored — only its hash is kept, the same way a password would be.
 *
 * Which tenant a token belongs to is the global `usage:tokenindex` hash
 * (`tokenTenant`), written in the same transaction as the token itself; the
 * request guard (lib/api.ts `requireBearer`) then reads the record in that
 * tenant's own hash. A token from before the index existed is not in it: the
 * guard looks for it in the default tenant and indexes it (`indexToken`).
 *
 * Looking a bearer token up is `HGET usage:tokens sha256(token)`: a hash-table
 * lookup keyed by the hash of a 256-bit random secret, not a string compare
 * walked byte by byte, so there is nothing for a timing attack to learn from
 * how long it takes — unlike the master token, which is checked with
 * `safeEqual` (lib/security.ts) for exactly that reason.
 */

/**
 * The prefix on every newly issued token: a leaked one is easy to grep for, and secret scanners can
 * flag it. Tokens issued before it existed start with a bare `ur_` and keep working: a token is
 * looked up by its hash, never by its prefix.
 */
export const TOKEN_PREFIX = "ur_live_";
/** The prefix on every token's public id (never secret, safe to show and log). */
export const ID_PREFIX = "tk_";
/** Random bytes making up the plaintext token, before base64url-encoding. */
const TOKEN_BYTES = 32;
/** Base32 characters in a token's public id. */
const ID_CHARS = 8;

export const MIN_LABEL_LENGTH = 1;
export const MAX_LABEL_LENGTH = 64;
/** Live tokens a workspace may have: a deployment cap, the same spirit as MAX_GROUPS / MAX_PROVIDERS / MAX_MACHINES. */
export const MAX_TOKENS = 100;
/**
 * Entries the tokens hash may hold, revoked ones included (they stay 90 days, see
 * REVOKED_RETENTION_DAYS): what bounds the hash when tokens are rotated again and again.
 */
export const MAX_TOKEN_ENTRIES = 2 * MAX_TOKENS;

/** `lastUsedAt` is refreshed at most this often, to spare Redis a write on every ingest. */
export const LAST_USED_REFRESH_MS = 60 * 60 * 1000;
/** Housekeeping (lib/housekeeping.ts): a token revoked longer ago than this is forgotten entirely. */
export const REVOKED_RETENTION_DAYS = 90;

/**
 * "ingest" reports usage; "read" only reads (the menu bar app's status), and may
 * not report; "official" is the menu bar app's one token for everything: it reads,
 * reports the machine's usage like an ingest token, and uploads a provider's own
 * usage percentage (POST /api/official-usage/report).
 */
export type TokenScope = "ingest" | "read" | "official";
export const TOKEN_SCOPES: readonly TokenScope[] = ["ingest", "read", "official"];

export interface MachineToken {
  /** Public, stable across the token's life: `tk_` + 8 base32 characters. Never secret. */
  id: string;
  label: string;
  /** Bound machine (POST /api/usage's `machineId`), or null for a token any machine may use. Always null for "read", which reports nothing. */
  machineId: string | null;
  /** Absent in entries stored before scopes existed: those read as "ingest", which is what they could do. */
  scope: TokenScope;
  createdAt: number;
  /** Last authenticated request, refreshed at most once an hour; null before the token is ever used. */
  lastUsedAt: number | null;
  /** Set by DELETE /api/tokens/[id]; null while the token is live. */
  revokedAt: number | null;
  /** The userId who created it (multi-tenant mode); null on a single-user instance and for older tokens. */
  createdBy: string | null;
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** `chars` random base32 characters (5 bits each), from just enough random bytes. */
function randomBase32(chars: number): string {
  const bytes = randomBytes(Math.ceil((chars * 5) / 8));
  let bitBuffer = 0;
  let bitCount = 0;
  let output = "";
  for (const byte of bytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && output.length < chars) {
      output += BASE32_ALPHABET[(bitBuffer >>> (bitCount - 5)) & 0x1f];
      bitCount -= 5;
    }
  }
  return output;
}

/** A fresh plaintext token: `ur_live_` + 32 random bytes, base64url. 256 bits of entropy. */
export function generatePlainToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/** A fresh public id: `tk_` + 8 random base32 characters (40 bits — plenty to avoid collisions among at most MAX_TOKENS). */
export function generateTokenId(): string {
  return `${ID_PREFIX}${randomBase32(ID_CHARS)}`;
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

function serialize(token: MachineToken): string {
  return JSON.stringify(token);
}

/** One `usage:tokens` field's value; null when it does not parse (edited by hand into something unreadable). */
function parseStored(raw: string): MachineToken | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || typeof entry.label !== "string" || typeof entry.createdAt !== "number") {
    return null;
  }
  return {
    id: entry.id,
    label: entry.label,
    machineId: typeof entry.machineId === "string" ? entry.machineId : null,
    scope: entry.scope === "read" || entry.scope === "official" ? entry.scope : "ingest",
    createdAt: entry.createdAt,
    lastUsedAt: typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : null,
    revokedAt: typeof entry.revokedAt === "number" ? entry.revokedAt : null,
    createdBy: typeof entry.createdBy === "string" ? entry.createdBy : null,
  };
}

/** Why `value` (already trimmed) cannot be saved as a token's label; null when it can. */
export function labelProblem(value: string): "empty" | "too_long" | null {
  if (value.length < MIN_LABEL_LENGTH) return "empty";
  if (value.length > MAX_LABEL_LENGTH) return "too_long";
  return null;
}

/** The later of the record's own `lastUsedAt` (older tokens) and the separate last-used hash's. */
function lastUsed(token: MachineToken, separate: unknown): number | null {
  const ms = Number(separate);
  const fromHash = separate !== null && separate !== undefined && Number.isFinite(ms) ? ms : null;
  if (fromHash === null) return token.lastUsedAt;
  return token.lastUsedAt === null ? fromHash : Math.max(token.lastUsedAt, fromHash);
}

/** Every stored token, newest first. An entry that does not parse is left out rather than crashing the list. */
export async function listTokens(store: TenantStore): Promise<MachineToken[]> {
  const reads = store.redis.pipeline();
  reads.hgetall(store.keys.tokens);
  reads.hgetall(store.keys.tokensLastUsed);
  const [records, used] = (await reads.exec()) as [unknown, unknown];
  const raw = toStringRecord(records as Record<string, unknown> | null);
  const usedAt = toStringRecord(used as Record<string, unknown> | null);
  return Object.entries(raw)
    .flatMap(([hash, value]) => {
      const token = parseStored(value);
      return token ? [{ ...token, lastUsedAt: lastUsed(token, usedAt[hash]) }] : [];
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export type CreateTokenResult = { ok: true; id: string; token: string } | { ok: false; reason: "too_many" };

/**
 * The audit entry for a change to one token (lib/token-vault.ts `auditRecord`, bound to the
 * request and its action), written in the same transaction as the change: a change that is not
 * on the trail does not happen.
 */
export type TokenAudit = (token: AuditToken) => Promise<string>;

type Transaction = ReturnType<TenantStore["redis"]["multi"]>;

async function queueAudit(tx: Transaction, store: TenantStore, audit: TokenAudit | undefined, token: AuditToken) {
  if (!audit) return;
  tx.lpush(store.keys.tokensAudit, await audit(token));
  tx.ltrim(store.keys.tokensAudit, 0, AUDIT_LIMIT - 1);
}

const LOCK_SECONDS = 10;

/**
 * Runs `fn` holding the workspace's token lock: a revocation and a rotation each read a token and
 * then write it, so two of them at once (a rotation clicked in two tabs, a revocation landing
 * mid-rotation) could otherwise leave two live replacements, or a live one after a revocation.
 */
async function withTokenLock<T>(store: TenantStore, fn: () => Promise<T>): Promise<T | "busy"> {
  const holder = randomBytes(9).toString("base64url");
  if ((await store.redis.set(store.keys.tokensLock, holder, { nx: true, ex: LOCK_SECONDS })) !== "OK") return "busy";
  try {
    return await fn();
  } finally {
    // Only our own lock: one that ran past its expiry may be someone else's by now.
    if ((await store.redis.get(store.keys.tokensLock)) === holder) await store.redis.del(store.keys.tokensLock);
  }
}

function newRecord(
  label: string,
  machineId: string | null,
  scope: TokenScope,
  now: Date,
  createdBy: string | null,
): { token: string; hash: string; record: MachineToken } {
  const token = generatePlainToken();
  const record: MachineToken = {
    id: generateTokenId(),
    label,
    machineId: scope === "read" ? null : machineId,
    scope,
    createdAt: now.getTime(),
    lastUsedAt: null,
    revokedAt: null,
    createdBy,
  };
  return { token, hash: hashToken(token), record };
}

/** Issues a fresh token and stores its hash; the plaintext is returned once and never stored. */
export async function createToken(
  store: TenantStore,
  label: string,
  machineId: string | null,
  now: Date,
  scope: TokenScope = "ingest",
  createdBy: string | null = null,
  audit?: TokenAudit,
): Promise<CreateTokenResult> {
  const redis = store.redis;
  const existing = toStringRecord(await redis.hgetall(store.keys.tokens));
  const live = Object.values(existing).filter((value) => parseStored(value)?.revokedAt === null).length;
  if (live >= MAX_TOKENS || Object.keys(existing).length >= MAX_TOKEN_ENTRIES) return { ok: false, reason: "too_many" };

  const { token, hash, record } = newRecord(label, machineId, scope, now, createdBy);
  const tx = redis.multi();
  tx.hset(store.keys.tokens, { [hash]: serialize(record) });
  tx.hset(GLOBAL_KEYS.tokenIndex, { [hash]: store.tenantId });
  await queueAudit(tx, store, audit, { id: record.id, label });
  await tx.exec();
  return { ok: true, id: record.id, token };
}

export type RevokeTokenResult = { ok: true } | { ok: false; reason: "not_found" | "busy" };

async function findToken(store: TenantStore, id: string): Promise<{ hash: string; token: MachineToken } | null> {
  const raw = toStringRecord(await store.redis.hgetall(store.keys.tokens));
  for (const [hash, value] of Object.entries(raw)) {
    const token = parseStored(value);
    if (token?.id === id) return { hash, token };
  }
  return null;
}

/**
 * Sets `revokedAt` on the token with this public id; idempotent — revoking an already-revoked
 * token still answers ok, and is not audited again.
 */
export async function revokeToken(
  store: TenantStore,
  id: string,
  now: Date,
  audit?: TokenAudit,
): Promise<RevokeTokenResult> {
  const result = await withTokenLock(store, async (): Promise<RevokeTokenResult> => {
    const found = await findToken(store, id);
    if (!found) return { ok: false, reason: "not_found" };
    const { hash, token } = found;
    if (token.revokedAt === null) {
      const tx = store.redis.multi();
      tx.hset(store.keys.tokens, { [hash]: serialize({ ...token, revokedAt: now.getTime() }) });
      await queueAudit(tx, store, audit, { id: token.id, label: token.label });
      await tx.exec();
    }
    return { ok: true };
  });
  return result === "busy" ? { ok: false, reason: "busy" } : result;
}

export type RotateTokenResult =
  | { ok: true; id: string; token: string }
  | { ok: false; reason: "not_found" | "revoked" | "busy" | "too_many" };

/**
 * Replaces a live token with a fresh one in one step: same label, machine and scope, a new secret
 * and id; the old one is revoked in the same transaction, so there is never a moment with both or
 * neither. The replacement keeps the old token's `createdBy`: it stands for the same machine, and
 * removing that member with their tokens still finds it. Held to MAX_TOKEN_ENTRIES only (the live
 * count stays the same).
 */
export async function rotateToken(
  store: TenantStore,
  id: string,
  now: Date,
  audit?: TokenAudit,
): Promise<RotateTokenResult> {
  const result = await withTokenLock(store, async (): Promise<RotateTokenResult> => {
    const all = toStringRecord(await store.redis.hgetall(store.keys.tokens));
    const entry = Object.entries(all).find(([, value]) => parseStored(value)?.id === id);
    if (!entry) return { ok: false, reason: "not_found" };
    const [oldHash, oldValue] = entry;
    const old = parseStored(oldValue)!;
    if (old.revokedAt !== null) return { ok: false, reason: "revoked" };
    if (Object.keys(all).length >= MAX_TOKEN_ENTRIES) return { ok: false, reason: "too_many" };

    const { token, hash, record } = newRecord(old.label, old.machineId, old.scope, now, old.createdBy);
    const tx = store.redis.multi();
    tx.hset(store.keys.tokens, {
      [oldHash]: serialize({ ...old, revokedAt: now.getTime() }),
      [hash]: serialize(record),
    });
    tx.hset(GLOBAL_KEYS.tokenIndex, { [hash]: store.tenantId });
    await queueAudit(tx, store, audit, { id: old.id, label: old.label, replacement: record.id });
    await tx.exec();
    return { ok: true, id: record.id, token };
  });
  return result === "busy" ? { ok: false, reason: "busy" } : result;
}

/** Revokes every live token `userId` created (a member removed with their tokens); how many it revoked. */
export async function revokeTokensCreatedBy(
  store: TenantStore,
  userId: string,
  now: Date,
  audit?: TokenAudit,
): Promise<number> {
  const result = await withTokenLock(store, () => revokeAllCreatedBy(store, userId, now, audit));
  // A token change was running at that moment: try once more after it, rather than leave the tokens live.
  if (result !== "busy") return result;
  await new Promise((resolve) => setTimeout(resolve, 250));
  const retried = await withTokenLock(store, () => revokeAllCreatedBy(store, userId, now, audit));
  if (retried === "busy") throw new Error("token lock busy");
  return retried;
}

async function revokeAllCreatedBy(store: TenantStore, userId: string, now: Date, audit?: TokenAudit): Promise<number> {
  const raw = toStringRecord(await store.redis.hgetall(store.keys.tokens));
  const changes: Record<string, string> = {};
  const revoked: AuditToken[] = [];
  for (const [hash, value] of Object.entries(raw)) {
    const token = parseStored(value);
    if (token && token.createdBy === userId && token.revokedAt === null) {
      changes[hash] = serialize({ ...token, revokedAt: now.getTime() });
      revoked.push({ id: token.id, label: token.label });
    }
  }
  if (revoked.length === 0) return 0;
  const tx = store.redis.multi();
  tx.hset(store.keys.tokens, changes);
  for (const token of revoked) await queueAudit(tx, store, audit, token);
  await tx.exec();
  return revoked.length;
}

/** The tenant `bearer` was issued for, from the token index; null for a token the index does not know. */
export async function tokenTenant(bearer: string): Promise<TenantId | null> {
  const raw = await getRedis().hget<string>(GLOBAL_KEYS.tokenIndex, hashToken(bearer));
  const tenantId = raw === null || raw === undefined ? null : String(raw);
  return tenantId !== null && isTenantId(tenantId) ? tenantId : null;
}

/** Records in the token index that `bearer` belongs to `store`'s tenant (a token issued before the index existed). */
export async function indexToken(store: TenantStore, bearer: string): Promise<void> {
  await store.redis.hsetnx(GLOBAL_KEYS.tokenIndex, hashToken(bearer), store.tenantId);
}

export type TokenAuthResult =
  | { ok: true; tokenId: string; machineId: string | null; scope: TokenScope }
  | { ok: false; reason: "not_found" | "revoked" };

/**
 * Authenticates a bearer token against the stored hashes (not the master
 * token — see `requireBearer` in lib/api.ts, which tries that one first). A
 * fresh match refreshes `lastUsedAt` in the background (`defer`, at most once
 * an hour) so the settings panel can show it without slowing the request down.
 */
export async function authenticateToken(store: TenantStore, bearer: string, now: Date): Promise<TokenAuthResult> {
  const redis = store.redis;
  const hash = hashToken(bearer);
  const reads = redis.pipeline();
  reads.hget(store.keys.tokens, hash);
  reads.hget(store.keys.tokensLastUsed, hash);
  const [raw, used] = (await reads.exec()) as [unknown, unknown];
  if (raw === null || raw === undefined) return { ok: false, reason: "not_found" };

  const token = parseStored(String(raw));
  if (!token) return { ok: false, reason: "not_found" };
  if (token.revokedAt !== null) return { ok: false, reason: "revoked" };

  const last = lastUsed(token, used);
  if (last === null || now.getTime() - last >= LAST_USED_REFRESH_MS) {
    const nowMs = now.getTime();
    // Its own hash, never the record: a revocation landing meanwhile is never written over.
    defer(async () => {
      await store.redis.hset(store.keys.tokensLastUsed, { [hash]: String(nowMs) });
    });
  }

  return { ok: true, tokenId: token.id, machineId: token.machineId, scope: token.scope };
}

/**
 * Housekeeping (lib/housekeeping.ts): tokens revoked more than `retentionDays`
 * ago are dropped from the hash entirely. `dryRun` reports what would be
 * removed without deleting anything, matching `runHousekeeping`'s own option.
 */
export async function pruneRevokedTokens(
  store: TenantStore,
  now: Date,
  options: { retentionDays?: number; dryRun?: boolean } = {},
): Promise<{ removed: number; ids: string[] }> {
  const { retentionDays = REVOKED_RETENTION_DAYS, dryRun = false } = options;
  const redis = store.redis;
  const raw = toStringRecord(await redis.hgetall(store.keys.tokens));
  const cutoffMs = now.getTime() - retentionDays * 86_400_000;

  const staleHashes: string[] = [];
  const staleIds: string[] = [];
  for (const [hash, value] of Object.entries(raw)) {
    const token = parseStored(value);
    if (token?.revokedAt !== null && token !== null && token.revokedAt < cutoffMs) {
      staleHashes.push(hash);
      staleIds.push(token.id);
    }
  }
  if (!dryRun && staleHashes.length > 0) {
    const tx = redis.multi();
    tx.hdel(store.keys.tokens, ...staleHashes);
    tx.hdel(store.keys.tokensLastUsed, ...staleHashes);
    tx.hdel(GLOBAL_KEYS.tokenIndex, ...staleHashes);
    await tx.exec();
  }
  return { removed: staleHashes.length, ids: staleIds };
}

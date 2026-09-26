import { randomBytes } from "node:crypto";
import { getRedis, toStringRecord } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { defer } from "@/lib/request-context";
import { sha256Hex } from "@/lib/security";

/**
 * Per-machine API tokens: an alternative to the one shared `USAGE_API_TOKEN`
 * that can be individually revoked. Stored in the `usage:tokens` HASH
 * (lib/redis-keys.ts): field = `sha256Hex(token)`, value = this module's JSON.
 * The plaintext is generated once, returned to the caller of `createToken`,
 * and never stored — only its hash is kept, the same way a password would be.
 *
 * Looking a bearer token up is `HGET usage:tokens sha256(token)`: a hash-table
 * lookup keyed by the hash of a 256-bit random secret, not a string compare
 * walked byte by byte, so there is nothing for a timing attack to learn from
 * how long it takes — unlike the master token, which is checked with
 * `safeEqual` (lib/security.ts) for exactly that reason.
 */

/** The prefix on every issued token: helps secret scanners flag a leaked one. */
export const TOKEN_PREFIX = "ur_";
/** The prefix on every token's public id (never secret, safe to show and log). */
export const ID_PREFIX = "tk_";
/** Random bytes making up the plaintext token, before base64url-encoding. */
const TOKEN_BYTES = 32;
/** Base32 characters in a token's public id. */
const ID_CHARS = 8;

export const MIN_LABEL_LENGTH = 1;
export const MAX_LABEL_LENGTH = 64;
/** A deployment cap, the same spirit as MAX_GROUPS / MAX_PROVIDERS / MAX_MACHINES. */
export const MAX_TOKENS = 100;

/** `lastUsedAt` is refreshed at most this often, to spare Redis a write on every ingest. */
export const LAST_USED_REFRESH_MS = 60 * 60 * 1000;
/** Housekeeping (lib/housekeeping.ts): a token revoked longer ago than this is forgotten entirely. */
export const REVOKED_RETENTION_DAYS = 90;

export interface MachineToken {
  /** Public, stable across the token's life: `tk_` + 8 base32 characters. Never secret. */
  id: string;
  label: string;
  /** Bound machine (POST /api/usage's `machineId`), or null for a token any machine may use. */
  machineId: string | null;
  createdAt: number;
  /** Last authenticated request, refreshed at most once an hour; null before the token is ever used. */
  lastUsedAt: number | null;
  /** Set by DELETE /api/tokens/[id]; null while the token is live. */
  revokedAt: number | null;
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

/** A fresh plaintext token: `ur_` + 32 random bytes, base64url. 256 bits of entropy. */
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
    createdAt: entry.createdAt,
    lastUsedAt: typeof entry.lastUsedAt === "number" ? entry.lastUsedAt : null,
    revokedAt: typeof entry.revokedAt === "number" ? entry.revokedAt : null,
  };
}

/** Why `value` (already trimmed) cannot be saved as a token's label; null when it can. */
export function labelProblem(value: string): "empty" | "too_long" | null {
  if (value.length < MIN_LABEL_LENGTH) return "empty";
  if (value.length > MAX_LABEL_LENGTH) return "too_long";
  return null;
}

/** Every stored token, newest first. An entry that does not parse is left out rather than crashing the list. */
export async function listTokens(): Promise<MachineToken[]> {
  const raw = toStringRecord(await getRedis().hgetall(KEYS.tokens));
  return Object.values(raw)
    .flatMap((value) => {
      const token = parseStored(value);
      return token ? [token] : [];
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export type CreateTokenResult = { ok: true; id: string; token: string } | { ok: false; reason: "too_many" };

/** Issues a fresh token and stores its hash; the plaintext is returned once and never stored. */
export async function createToken(label: string, machineId: string | null, now: Date): Promise<CreateTokenResult> {
  const redis = getRedis();
  const count = await redis.hlen(KEYS.tokens);
  if (count >= MAX_TOKENS) return { ok: false, reason: "too_many" };

  const token = generatePlainToken();
  const id = generateTokenId();
  const record: MachineToken = { id, label, machineId, createdAt: now.getTime(), lastUsedAt: null, revokedAt: null };
  await redis.hset(KEYS.tokens, { [hashToken(token)]: serialize(record) });
  return { ok: true, id, token };
}

export type RevokeTokenResult = { ok: true } | { ok: false; reason: "not_found" };

/** Sets `revokedAt` on the token with this public id; idempotent — revoking an already-revoked token still answers ok. */
export async function revokeToken(id: string, now: Date): Promise<RevokeTokenResult> {
  const redis = getRedis();
  const raw = toStringRecord(await redis.hgetall(KEYS.tokens));
  const entry = Object.entries(raw).find(([, value]) => parseStored(value)?.id === id);
  if (!entry) return { ok: false, reason: "not_found" };

  const [hash, value] = entry;
  const token = parseStored(value)!;
  if (token.revokedAt === null) {
    await redis.hset(KEYS.tokens, { [hash]: serialize({ ...token, revokedAt: now.getTime() }) });
  }
  return { ok: true };
}

export type TokenAuthResult =
  | { ok: true; tokenId: string; machineId: string | null }
  | { ok: false; reason: "not_found" | "revoked" };

/**
 * Authenticates a bearer token against the stored hashes (not the master
 * token — see `requireBearer` in lib/api.ts, which tries that one first). A
 * fresh match refreshes `lastUsedAt` in the background (`defer`, at most once
 * an hour) so the settings panel can show it without slowing the request down.
 */
export async function authenticateToken(bearer: string, now: Date): Promise<TokenAuthResult> {
  const redis = getRedis();
  const hash = hashToken(bearer);
  const raw = await redis.hget<string>(KEYS.tokens, hash);
  if (raw === null || raw === undefined) return { ok: false, reason: "not_found" };

  const token = parseStored(String(raw));
  if (!token) return { ok: false, reason: "not_found" };
  if (token.revokedAt !== null) return { ok: false, reason: "revoked" };

  if (token.lastUsedAt === null || now.getTime() - token.lastUsedAt >= LAST_USED_REFRESH_MS) {
    const nowMs = now.getTime();
    defer(async () => {
      await getRedis().hset(KEYS.tokens, { [hash]: serialize({ ...token, lastUsedAt: nowMs }) });
    });
  }

  return { ok: true, tokenId: token.id, machineId: token.machineId };
}

/**
 * Housekeeping (lib/housekeeping.ts): tokens revoked more than `retentionDays`
 * ago are dropped from the hash entirely. `dryRun` reports what would be
 * removed without deleting anything, matching `runHousekeeping`'s own option.
 */
export async function pruneRevokedTokens(
  now: Date,
  options: { retentionDays?: number; dryRun?: boolean } = {},
): Promise<{ removed: number; ids: string[] }> {
  const { retentionDays = REVOKED_RETENTION_DAYS, dryRun = false } = options;
  const redis = getRedis();
  const raw = toStringRecord(await redis.hgetall(KEYS.tokens));
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
  if (!dryRun && staleHashes.length > 0) await redis.hdel(KEYS.tokens, ...staleHashes);
  return { removed: staleHashes.length, ids: staleIds };
}

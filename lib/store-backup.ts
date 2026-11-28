import { randomUUID } from "node:crypto";
import type { Redis } from "@upstash/redis";
import { scanAll, toStringRecord } from "@/lib/redis";

/**
 * Backup and restore of a whole Redis store over REST (npm run backup / restore, docs/runbooks.md).
 *
 * The file is `{ takenAt, dbsize, keys: { key: { type, ttlMs, value, expiresAtMs? } } }`: a hash is a
 * field → value record, a list or set a string array, a zset a flat [member, score, …] array (what
 * ZRANGE WITHSCORES returns), a string its text. `ttlMs` is PTTL at the time (-1: no expiry) and
 * `expiresAtMs` the instant that meant; a restore keeps that instant, not the remaining time, so a
 * restore a day later does not hand every key a day more. Older files (the ops script's) have no
 * `expiresAtMs` (it is `takenAt + ttlMs` then) and may hold a hash as a flat array.
 *
 * A key is restored under a temporary name and moved into place with RENAME / RENAMENX, so a key is
 * either there whole or not there: an interrupted restore never leaves half a key that a rerun
 * would then take for an existing one. Chunks of CHUNK members keep every request small.
 */

export type BackupType = "string" | "hash" | "list" | "set" | "zset";
const TYPES: readonly BackupType[] = ["string", "hash", "list", "set", "zset"];

export interface BackupEntry {
  type: BackupType;
  ttlMs: number;
  value: unknown;
  expiresAtMs?: number;
}

export interface Backup {
  takenAt: string;
  dbsize: number;
  keys: Record<string, BackupEntry>;
}

const BATCH = 100;
const CHUNK = 500;
/** Where a key is built before it moves into place. Not a `usage:` name, so no app code reads it. */
export const TEMP_PREFIX = "restore-tmp:";

const toText = (value: unknown): string => (typeof value === "string" ? value : String(value));

/** Reads every key of the store (all five types, with TTLs). Throws on a type this app never writes. */
export async function takeBackup(redis: Redis, now: () => number = Date.now): Promise<Backup> {
  const names = [...new Set(await scanAll(redis, "*"))].filter((name) => !name.startsWith(TEMP_PREFIX)).sort();
  const keys: Record<string, BackupEntry> = {};

  for (let start = 0; start < names.length; start += BATCH) {
    const batch = names.slice(start, start + BATCH);
    const meta = redis.pipeline();
    for (const name of batch) meta.type(name).pttl(name);
    const metaResult = (await meta.exec()) as unknown[];
    const readAt = now();

    const live: { name: string; type: BackupType; ttlMs: number }[] = [];
    batch.forEach((name, i) => {
      const type = toText(metaResult[i * 2]);
      const ttlMs = Number(metaResult[i * 2 + 1]);
      if (type === "none" || ttlMs === -2) return; // expired between SCAN and now
      if (!TYPES.includes(type as BackupType)) throw new Error(`unsupported type ${type} for key ${name}`);
      live.push({ name, type: type as BackupType, ttlMs });
    });

    const reads = redis.pipeline();
    for (const { name, type } of live) {
      if (type === "string") reads.get(name);
      else if (type === "hash") reads.hgetall(name);
      else if (type === "list") reads.lrange(name, 0, -1);
      else if (type === "set") reads.smembers(name);
      else reads.zrange(name, 0, -1, { withScores: true });
    }
    const values = live.length > 0 ? ((await reads.exec()) as unknown[]) : [];

    live.forEach(({ name, type, ttlMs }, i) => {
      const raw = values[i];
      if (raw === null || raw === undefined) return; // gone between the two reads
      let value: unknown;
      if (type === "string") value = toText(raw);
      else if (type === "hash") value = toStringRecord(raw);
      else if (type === "zset") {
        const flat = raw as unknown[];
        value = flat.map((item, at) => (at % 2 === 0 ? toText(item) : Number(item)));
      } else value = (raw as unknown[]).map(toText);
      keys[name] = { type, ttlMs, value, ...(ttlMs >= 0 && { expiresAtMs: readAt + ttlMs }) };
    });
  }

  return { takenAt: new Date(now()).toISOString(), dbsize: Number(await redis.dbsize()), keys };
}

/** Parses and validates a backup file's text; throws an Error saying what is wrong with it. */
export function parseBackup(text: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("not a backup file: not JSON");
  }
  const file = data as { takenAt?: unknown; dbsize?: unknown; keys?: unknown };
  if (typeof data !== "object" || data === null || typeof file.keys !== "object" || file.keys === null) {
    throw new Error("not a backup file: no keys object");
  }
  const takenAtMs = typeof file.takenAt === "string" ? Date.parse(file.takenAt) : Number.NaN;
  if (Number.isNaN(takenAtMs)) throw new Error("not a backup file: takenAt is not a date");

  for (const [key, entry] of Object.entries(file.keys as Record<string, BackupEntry>)) {
    const fail = (why: string): never => {
      throw new Error(`bad entry for key ${key}: ${why}`);
    };
    if (typeof entry !== "object" || entry === null) fail("not an object");
    if (!TYPES.includes(entry.type)) fail(`unknown type ${String(entry.type)}`);
    if (!Number.isFinite(entry.ttlMs)) fail("ttlMs is not a number");
    if (entry.expiresAtMs !== undefined && !Number.isFinite(entry.expiresAtMs)) fail("expiresAtMs is not a number");
    const { value } = entry;
    const size = typeof value === "object" && value !== null ? Object.keys(value).length : 1;
    if (entry.type !== "string" && size === 0) fail("empty value (Redis has no empty collections)");
    const flat = Array.isArray(value) && value.length % 2 === 0;
    if (entry.type === "string" && typeof value !== "string") fail("value is not a string");
    if (entry.type === "hash" && !(flat || (typeof value === "object" && value !== null && !Array.isArray(value)))) {
      fail("value is neither a record nor a flat field/value list");
    }
    if ((entry.type === "list" || entry.type === "set") && !Array.isArray(value)) fail("value is not an array");
    if (
      entry.type === "zset" &&
      !(flat && (value as unknown[]).every((v, i) => i % 2 === 0 || Number.isFinite(Number(v))))
    ) {
      fail("value is not a flat member/score list");
    }
  }
  return file as Backup;
}

/** `{type: count}` of a backup, for a one-line summary. */
export function countByType(backup: Backup): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { type } of Object.values(backup.keys)) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

/** A pattern is an exact key, or a prefix when it ends in `*`. */
function matches(pattern: string, key: string): boolean {
  return pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : key === pattern;
}

export interface RestoreOptions {
  /** Restore only keys matching one of these (exact, or a prefix ending in `*`); all keys when empty. */
  only?: string[];
  /** Replace keys that already exist; they are skipped otherwise. Needs `only`. */
  force?: boolean;
  /** Write. False: only report what would happen. */
  apply?: boolean;
  now?: () => number;
}

export interface RestoreReport {
  /** Keys written (or, on a dry run, that would be). */
  restored: string[];
  /** Of those, the ones that replaced an existing key (`force`). */
  replaced: string[];
  /** Left alone: the key exists and `force` is off (or it appeared while restoring). */
  skippedExisting: string[];
  /** Left alone: its TTL ran out between the backup and now. */
  skippedExpired: string[];
  /** `only` patterns that matched no key in the backup: usually a typo. */
  unmatched: string[];
}

/** The instant a key expires, null for none, from either file generation. */
function expiryOf(entry: BackupEntry, takenAtMs: number): number | null {
  if (entry.expiresAtMs !== undefined) return entry.expiresAtMs;
  return entry.ttlMs >= 0 ? takenAtMs + entry.ttlMs : null;
}

async function writeKey(redis: Redis, key: string, entry: BackupEntry, expiresAt: number | null, force: boolean) {
  const temp = `${TEMP_PREFIX}${randomUUID()}`;
  try {
    const { value } = entry;
    if (entry.type === "string") await redis.set(temp, value as string);
    else {
      const items: unknown[] =
        entry.type === "hash"
          ? Object.entries(Array.isArray(value) ? toStringRecord(value) : (value as Record<string, string>))
          : entry.type === "zset"
            ? Array.from({ length: (value as unknown[]).length / 2 }, (_, i) => ({
                member: toText((value as unknown[])[i * 2]),
                score: Number((value as unknown[])[i * 2 + 1]),
              }))
            : (value as string[]);
      for (let start = 0; start < items.length; start += CHUNK) {
        const chunk = items.slice(start, start + CHUNK);
        if (entry.type === "hash") await redis.hset(temp, Object.fromEntries(chunk as [string, string][]));
        else if (entry.type === "list") await redis.rpush(temp, ...(chunk as string[]));
        else if (entry.type === "set") await redis.sadd(temp, ...(chunk as [string, ...string[]]));
        else await redis.zadd(temp, ...(chunk as [{ score: number; member: string }]));
      }
    }
    if (expiresAt !== null) await redis.pexpireat(temp, expiresAt);
    if (force) {
      await redis.rename(temp, key);
      return true;
    }
    if ((await redis.renamenx(temp, key)) === 1) return true;
    await redis.del(temp);
    return false; // the key appeared meanwhile
  } catch (error) {
    await redis.del(temp).catch(() => undefined);
    throw error;
  }
}

/**
 * Restores `backup` into `redis`: the selected keys, each only if it does not exist yet unless
 * `force`. Writes nothing unless `apply`; the report is the same either way.
 */
export async function restoreBackup(
  redis: Redis,
  backup: Backup,
  options: RestoreOptions = {},
): Promise<RestoreReport> {
  const now = (options.now ?? Date.now)();
  const only = options.only ?? [];
  // Replacing every key would also bring back ended sessions and an old token index that other
  // workspaces' newer tokens are missing from: a forced restore names what it replaces.
  if (options.force && only.length === 0) throw new Error("--force needs --only: name the keys to replace");
  const takenAtMs = Date.parse(backup.takenAt);
  const report: RestoreReport = { restored: [], replaced: [], skippedExisting: [], skippedExpired: [], unmatched: [] };

  const all = Object.keys(backup.keys).sort();
  report.unmatched = only.filter((pattern) => !all.some((key) => matches(pattern, key)));
  const selected = only.length === 0 ? all : all.filter((key) => only.some((pattern) => matches(pattern, key)));

  for (let start = 0; start < selected.length; start += BATCH) {
    const batch = selected.slice(start, start + BATCH);
    const probe = redis.pipeline();
    for (const key of batch) probe.exists(key);
    const present = (await probe.exec()) as unknown[];

    for (const [i, key] of batch.entries()) {
      const entry = backup.keys[key] as BackupEntry;
      const expiresAt = expiryOf(entry, takenAtMs);
      const exists = Number(present[i]) === 1;
      if (expiresAt !== null && expiresAt <= now) report.skippedExpired.push(key);
      else if (exists && !options.force) report.skippedExisting.push(key);
      else if (options.apply && !(await writeKey(redis, key, entry, expiresAt, options.force === true))) {
        report.skippedExisting.push(key);
      } else {
        report.restored.push(key);
        if (exists) report.replaced.push(key);
      }
    }
  }
  return report;
}

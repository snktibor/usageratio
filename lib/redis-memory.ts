import { Redis, type Requester, type UpstashRequest, type UpstashResponse } from "@upstash/redis";

/**
 * An in-memory stand-in for Upstash's REST API, plugged in under the real
 * `@upstash/redis` client: the client still builds every command, pipeline
 * and transaction exactly as it does against Upstash, only the HTTP request
 * lands here. The replies are shaped like the REST API's raw JSON (flat
 * `[field, value, …]` arrays for HGETALL, `"OK"`, integers, `null`), so with
 * `automaticDeserialization: false` the application code sees no difference.
 *
 * Used by demo mode (`DEMO_MODE=1`, no Redis needed) and by the tests (a
 * fresh store per test, an injectable clock, one-off failures). It keeps
 * strings, hashes, lists and sorted sets with lazy key expiry, and nothing
 * else: no persistence, no Lua, no pub/sub, no cluster semantics.
 */

type Entry =
  | { type: "string"; value: string; expiresAt: number | null }
  | { type: "hash"; value: Map<string, string>; expiresAt: number | null }
  | { type: "list"; value: string[]; expiresAt: number | null }
  | { type: "zset"; value: Map<string, number>; expiresAt: number | null };

type EntryType = Entry["type"];

export interface MemoryStore {
  /** The store's own clock; `advance` moves it forward, `set` pins it to an epoch ms. */
  clock: { now(): number; advance(ms: number): void; set(ms: number): void };
  /** Seconds left on a key, as the TTL command reports it: -2 missing, -1 no expiry. */
  ttl(key: string): number;
  /** Every live key with its type and value, for assertions and debugging. */
  dump(): Record<string, { type: EntryType; value: unknown; ttl: number }>;
  /** Every live key name, sorted. */
  keys(): string[];
  /** Makes the next invocation of `command` (any case) answer with `error` instead of running. */
  failNext(command: string, error?: string): void;
  /** Drops every key and every queued failure. */
  clear(): void;
}

/** A Redis error reply: the message goes back as `{ error }`, exactly like the REST API's. */
class ReplyError extends Error {}

const WRONGTYPE = "WRONGTYPE Operation against a key holding the wrong kind of value";
const NOT_INTEGER = "ERR value is not an integer or out of range";

function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function asInteger(value: unknown): number {
  const text = asString(value).trim();
  if (!/^[+-]?\d+$/.test(text)) throw new ReplyError(NOT_INTEGER);
  return Number(text);
}

function asScore(value: unknown): number {
  const text = asString(value).trim().toLowerCase();
  if (text === "inf" || text === "+inf") return Number.POSITIVE_INFINITY;
  if (text === "-inf") return Number.NEGATIVE_INFINITY;
  const score = Number(text);
  if (text === "" || Number.isNaN(score)) throw new ReplyError("ERR value is not a valid float");
  return score;
}

function scoreText(score: number): string {
  if (score === Number.POSITIVE_INFINITY) return "inf";
  if (score === Number.NEGATIVE_INFINITY) return "-inf";
  return String(score);
}

/** A ZRANGEBYSCORE bound: a number, ±inf, or "(x" for an exclusive one. */
function parseBound(value: unknown): { score: number; exclusive: boolean } {
  const text = asString(value).trim();
  if (text.startsWith("(")) return { score: asScore(text.slice(1)), exclusive: true };
  return { score: asScore(text), exclusive: false };
}

function flag(value: unknown): string {
  return asString(value).toUpperCase();
}

/** Redis glob patterns (`*`, `?`, `[abc]`, `\x`) as a RegExp. */
function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "\\" && i + 1 < pattern.length) {
      i += 1;
      source += pattern[i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "*") source += ".*";
    else if (char === "?") source += ".";
    else if (char === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end < 0) source += "\\[";
      else {
        const body = pattern.slice(i + 1, end);
        source += `[${body.startsWith("^") ? `^${body.slice(1)}` : body}]`;
        i = end;
      }
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "su");
}

/** Normalizes a Redis start/stop rank pair against a length; null when the range is empty. */
function rankRange(length: number, rawStart: unknown, rawStop: unknown): [number, number] | null {
  let start = asInteger(rawStart);
  let stop = asInteger(rawStop);
  if (start < 0) start = Math.max(0, length + start);
  if (stop < 0) stop = length + stop;
  stop = Math.min(stop, length - 1);
  return start > stop || start >= length ? null : [start, stop];
}

export function createMemoryRequester(options: { now?: () => number } = {}): {
  requester: Requester;
  store: MemoryStore;
} {
  const data = new Map<string, Entry>();
  const failures = new Map<string, string>();
  const base = options.now ?? Date.now;
  let pinned: number | null = null;
  let offset = 0;
  const now = () => (pinned ?? base()) + offset;

  /** The entry behind `key`, dropping it first if its expiry has passed. */
  function live(key: string): Entry | undefined {
    const entry = data.get(key);
    if (entry && entry.expiresAt !== null && entry.expiresAt <= now()) {
      data.delete(key);
      return undefined;
    }
    return entry;
  }

  function typed<T extends EntryType>(key: string, type: T): Extract<Entry, { type: T }> | undefined {
    const entry = live(key);
    if (entry && entry.type !== type) throw new ReplyError(WRONGTYPE);
    return entry as Extract<Entry, { type: T }> | undefined;
  }

  /** The container behind `key`, created empty (keeping no expiry) when missing. */
  function container<T extends "hash" | "list" | "zset">(key: string, type: T): Extract<Entry, { type: T }> {
    const existing = typed(key, type);
    if (existing) return existing;
    const value = type === "hash" ? new Map<string, string>() : type === "zset" ? new Map<string, number>() : [];
    const entry = { type, value, expiresAt: null } as Extract<Entry, { type: T }>;
    data.set(key, entry);
    return entry;
  }

  /** A container that lost its last element disappears, as it does in Redis. */
  function dropIfEmpty(key: string, entry: Entry): void {
    const size = entry.type === "string" ? 1 : entry.type === "list" ? entry.value.length : entry.value.size;
    if (size === 0) data.delete(key);
  }

  function liveKeys(): string[] {
    return [...data.keys()].filter((key) => live(key) !== undefined).sort();
  }

  function ttlOf(entry: Entry | undefined, unit: 1 | 1000): number {
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.max(1, Math.ceil((entry.expiresAt - now()) / unit));
  }

  function sortedMembers(zset: Map<string, number>): [string, number][] {
    return [...zset.entries()].sort(([memberA, scoreA], [memberB, scoreB]) =>
      scoreA === scoreB ? (memberA < memberB ? -1 : memberA > memberB ? 1 : 0) : scoreA - scoreB,
    );
  }

  function inBounds(score: number, min: ReturnType<typeof parseBound>, max: ReturnType<typeof parseBound>): boolean {
    const aboveMin = min.exclusive ? score > min.score : score >= min.score;
    const belowMax = max.exclusive ? score < max.score : score <= max.score;
    return aboveMin && belowMax;
  }

  function withScores(entries: [string, number][], scores: boolean): string[] {
    return scores
      ? entries.flatMap(([member, score]) => [member, scoreText(score)])
      : entries.map(([member]) => member);
  }

  function setExpiry(key: string, entry: Entry, at: number | null): void {
    entry.expiresAt = at;
    data.set(key, entry);
  }

  const commands: Record<string, (args: unknown[]) => unknown> = {
    PING: (args) => (args.length > 0 ? asString(args[0]) : "PONG"),
    ECHO: (args) => asString(args[0]),
    DBSIZE: () => liveKeys().length,
    FLUSHDB: () => {
      data.clear();
      return "OK";
    },
    FLUSHALL: () => {
      data.clear();
      return "OK";
    },

    GET: (args) => typed(asString(args[0]), "string")?.value ?? null,
    SET: (args) => {
      const key = asString(args[0]);
      const value = asString(args[1]);
      let nx = false;
      let xx = false;
      let get = false;
      let keepTtl = false;
      let expiresAt: number | null = null;
      for (let i = 2; i < args.length; i += 1) {
        const option = flag(args[i]);
        if (option === "NX") nx = true;
        else if (option === "XX") xx = true;
        else if (option === "GET") get = true;
        else if (option === "KEEPTTL") keepTtl = true;
        else if (option === "EX") expiresAt = now() + asInteger(args[++i]) * 1000;
        else if (option === "PX") expiresAt = now() + asInteger(args[++i]);
        else if (option === "EXAT") expiresAt = asInteger(args[++i]) * 1000;
        else if (option === "PXAT") expiresAt = asInteger(args[++i]);
        else throw new ReplyError("ERR syntax error");
      }
      const existing = live(key);
      if (get && existing && existing.type !== "string") throw new ReplyError(WRONGTYPE);
      const previous = existing?.type === "string" ? existing.value : null;
      if ((nx && existing) || (xx && !existing)) return get ? previous : null;
      data.set(key, { type: "string", value, expiresAt: keepTtl ? (existing?.expiresAt ?? null) : expiresAt });
      return get ? previous : "OK";
    },
    DEL: (args) => args.filter((key) => live(asString(key)) !== undefined && data.delete(asString(key))).length,
    UNLINK: (args) => commands.DEL!(args),
    EXISTS: (args) => args.filter((key) => live(asString(key)) !== undefined).length,
    TYPE: (args) => live(asString(args[0]))?.type ?? "none",
    INCR: (args) => commands.INCRBY!([args[0], 1]),
    DECR: (args) => commands.INCRBY!([args[0], -1]),
    DECRBY: (args) => commands.INCRBY!([args[0], -asInteger(args[1])]),
    INCRBY: (args) => {
      const key = asString(args[0]);
      const entry = typed(key, "string");
      const next = (entry ? asInteger(entry.value) : 0) + asInteger(args[1]);
      data.set(key, { type: "string", value: String(next), expiresAt: entry?.expiresAt ?? null });
      return next;
    },
    EXPIRE: (args) => commands.PEXPIREAT!([args[0], now() + asInteger(args[1]) * 1000, ...args.slice(2)]),
    PEXPIRE: (args) => commands.PEXPIREAT!([args[0], now() + asInteger(args[1]), ...args.slice(2)]),
    EXPIREAT: (args) => commands.PEXPIREAT!([args[0], asInteger(args[1]) * 1000, ...args.slice(2)]),
    PEXPIREAT: (args) => {
      const key = asString(args[0]);
      const entry = live(key);
      if (!entry) return 0;
      const at = asInteger(args[1]);
      const condition = args.length > 2 ? flag(args[2]) : null;
      if (condition === "NX" && entry.expiresAt !== null) return 0;
      if (condition === "XX" && entry.expiresAt === null) return 0;
      if (condition === "GT" && (entry.expiresAt === null || at <= entry.expiresAt)) return 0;
      if (condition === "LT" && entry.expiresAt !== null && at >= entry.expiresAt) return 0;
      if (at <= now()) {
        data.delete(key);
        return 1;
      }
      setExpiry(key, entry, at);
      return 1;
    },
    PERSIST: (args) => {
      const key = asString(args[0]);
      const entry = live(key);
      if (!entry || entry.expiresAt === null) return 0;
      setExpiry(key, entry, null);
      return 1;
    },
    TTL: (args) => ttlOf(live(asString(args[0])), 1000),
    PTTL: (args) => ttlOf(live(asString(args[0])), 1),
    KEYS: (args) => {
      const pattern = globToRegExp(asString(args[0]));
      return liveKeys().filter((key) => pattern.test(key));
    },
    SCAN: (args) => {
      const cursor = asInteger(args[0]);
      let pattern: RegExp | null = null;
      let count = 10;
      let type: string | null = null;
      for (let i = 1; i < args.length; i += 1) {
        const option = flag(args[i]);
        if (option === "MATCH") pattern = globToRegExp(asString(args[++i]));
        else if (option === "COUNT") count = Math.max(1, asInteger(args[++i]));
        else if (option === "TYPE") type = asString(args[++i]);
        else throw new ReplyError("ERR syntax error");
      }
      const all = liveKeys();
      const page = all.slice(cursor, cursor + count);
      const next = cursor + count >= all.length ? 0 : cursor + count;
      const matching = page.filter(
        (key) => (!pattern || pattern.test(key)) && (type === null || live(key)?.type === type),
      );
      return [String(next), matching];
    },
    RENAME: (args) => {
      const source = asString(args[0]);
      const entry = live(source);
      if (!entry) throw new ReplyError("ERR no such key");
      data.delete(source);
      data.set(asString(args[1]), entry);
      return "OK";
    },
    RENAMENX: (args) => {
      const source = asString(args[0]);
      const entry = live(source);
      if (!entry) throw new ReplyError("ERR no such key");
      if (live(asString(args[1]))) return 0;
      data.delete(source);
      data.set(asString(args[1]), entry);
      return 1;
    },

    HSET: (args) => {
      const hash = container(asString(args[0]), "hash");
      let added = 0;
      for (let i = 1; i + 1 < args.length; i += 2) {
        const field = asString(args[i]);
        if (!hash.value.has(field)) added += 1;
        hash.value.set(field, asString(args[i + 1]));
      }
      return added;
    },
    HSETNX: (args) => {
      const hash = container(asString(args[0]), "hash");
      const field = asString(args[1]);
      if (hash.value.has(field)) return 0;
      hash.value.set(field, asString(args[2]));
      return 1;
    },
    HGET: (args) => typed(asString(args[0]), "hash")?.value.get(asString(args[1])) ?? null,
    HMGET: (args) => {
      const hash = typed(asString(args[0]), "hash");
      return args.slice(1).map((field) => hash?.value.get(asString(field)) ?? null);
    },
    HGETALL: (args) => [...(typed(asString(args[0]), "hash")?.value.entries() ?? [])].flat(),
    HKEYS: (args) => [...(typed(asString(args[0]), "hash")?.value.keys() ?? [])],
    HVALS: (args) => [...(typed(asString(args[0]), "hash")?.value.values() ?? [])],
    HLEN: (args) => typed(asString(args[0]), "hash")?.value.size ?? 0,
    HEXISTS: (args) => (typed(asString(args[0]), "hash")?.value.has(asString(args[1])) ? 1 : 0),
    HDEL: (args) => {
      const key = asString(args[0]);
      const hash = typed(key, "hash");
      if (!hash) return 0;
      const removed = args.slice(1).filter((field) => hash.value.delete(asString(field))).length;
      dropIfEmpty(key, hash);
      return removed;
    },

    LPUSH: (args) => {
      const list = container(asString(args[0]), "list");
      for (const value of args.slice(1)) list.value.unshift(asString(value));
      return list.value.length;
    },
    RPUSH: (args) => {
      const list = container(asString(args[0]), "list");
      for (const value of args.slice(1)) list.value.push(asString(value));
      return list.value.length;
    },
    LPOP: (args) => {
      const key = asString(args[0]);
      const list = typed(key, "list");
      const value = list?.value.shift() ?? null;
      if (list) dropIfEmpty(key, list);
      return value;
    },
    RPOP: (args) => {
      const key = asString(args[0]);
      const list = typed(key, "list");
      const value = list?.value.pop() ?? null;
      if (list) dropIfEmpty(key, list);
      return value;
    },
    LLEN: (args) => typed(asString(args[0]), "list")?.value.length ?? 0,
    LRANGE: (args) => {
      const list = typed(asString(args[0]), "list");
      if (!list) return [];
      const range = rankRange(list.value.length, args[1], args[2]);
      return range ? list.value.slice(range[0], range[1] + 1) : [];
    },
    LTRIM: (args) => {
      const key = asString(args[0]);
      const list = typed(key, "list");
      if (!list) return "OK";
      const range = rankRange(list.value.length, args[1], args[2]);
      list.value = range ? list.value.slice(range[0], range[1] + 1) : [];
      dropIfEmpty(key, list);
      return "OK";
    },

    ZADD: (args) => {
      const key = asString(args[0]);
      let i = 1;
      let nx = false;
      let xx = false;
      let ch = false;
      let incr = false;
      let gt = false;
      let lt = false;
      for (; i < args.length; i += 1) {
        const option = flag(args[i]);
        if (option === "NX") nx = true;
        else if (option === "XX") xx = true;
        else if (option === "CH") ch = true;
        else if (option === "INCR") incr = true;
        else if (option === "GT") gt = true;
        else if (option === "LT") lt = true;
        else break;
      }
      const pairs = args.slice(i);
      if (pairs.length === 0 || pairs.length % 2 !== 0) throw new ReplyError("ERR syntax error");
      if (incr && pairs.length !== 2) throw new ReplyError("ERR INCR option supports a single increment-element pair");
      const zset = container(key, "zset");
      let added = 0;
      let changed = 0;
      let incremented: number | null = null;
      for (let p = 0; p < pairs.length; p += 2) {
        const member = asString(pairs[p + 1]);
        const current = zset.value.get(member);
        const score = incr && current !== undefined ? current + asScore(pairs[p]) : asScore(pairs[p]);
        if (current === undefined) {
          if (xx) continue;
          zset.value.set(member, score);
          added += 1;
          incremented = score;
        } else {
          if (nx || (gt && score <= current) || (lt && score >= current)) continue;
          if (score !== current) changed += 1;
          zset.value.set(member, score);
          incremented = score;
        }
      }
      dropIfEmpty(key, zset);
      if (incr) return incremented === null ? null : scoreText(incremented);
      return ch ? added + changed : added;
    },
    ZREM: (args) => {
      const key = asString(args[0]);
      const zset = typed(key, "zset");
      if (!zset) return 0;
      const removed = args.slice(1).filter((member) => zset.value.delete(asString(member))).length;
      dropIfEmpty(key, zset);
      return removed;
    },
    ZCARD: (args) => typed(asString(args[0]), "zset")?.value.size ?? 0,
    ZSCORE: (args) => {
      const score = typed(asString(args[0]), "zset")?.value.get(asString(args[1]));
      return score === undefined ? null : scoreText(score);
    },
    ZCOUNT: (args) => {
      const zset = typed(asString(args[0]), "zset");
      if (!zset) return 0;
      const min = parseBound(args[1]);
      const max = parseBound(args[2]);
      return [...zset.value.values()].filter((score) => inBounds(score, min, max)).length;
    },
    ZRANGE: (args) => {
      const zset = typed(asString(args[0]), "zset");
      let byScore = false;
      let rev = false;
      let scores = false;
      let limit: [number, number] | null = null;
      for (let i = 3; i < args.length; i += 1) {
        const option = flag(args[i]);
        if (option === "BYSCORE") byScore = true;
        else if (option === "REV") rev = true;
        else if (option === "WITHSCORES") scores = true;
        else if (option === "LIMIT") {
          limit = [asInteger(args[i + 1]), asInteger(args[i + 2])];
          i += 2;
        } else if (option === "BYLEX") throw new ReplyError("ERR BYLEX is not supported by the memory store");
        else throw new ReplyError("ERR syntax error");
      }
      if (!zset) return [];
      let entries = sortedMembers(zset.value);
      if (byScore) {
        // With REV the bounds arrive as (max, min).
        const min = parseBound(rev ? args[2] : args[1]);
        const max = parseBound(rev ? args[1] : args[2]);
        entries = entries.filter(([, score]) => inBounds(score, min, max));
        if (rev) entries.reverse();
      } else {
        if (rev) entries.reverse();
        const range = rankRange(entries.length, args[1], args[2]);
        entries = range ? entries.slice(range[0], range[1] + 1) : [];
      }
      if (limit) entries = limit[1] < 0 ? entries.slice(limit[0]) : entries.slice(limit[0], limit[0] + limit[1]);
      return withScores(entries, scores);
    },
    ZRANGEBYSCORE: (args) => {
      const rest = args.slice(3);
      return commands.ZRANGE!([args[0], args[1], args[2], "BYSCORE", ...rest]);
    },
    ZREMRANGEBYSCORE: (args) => {
      const key = asString(args[0]);
      const zset = typed(key, "zset");
      if (!zset) return 0;
      const min = parseBound(args[1]);
      const max = parseBound(args[2]);
      let removed = 0;
      for (const [member, score] of zset.value) {
        if (inBounds(score, min, max)) {
          zset.value.delete(member);
          removed += 1;
        }
      }
      dropIfEmpty(key, zset);
      return removed;
    },
    ZREMRANGEBYRANK: (args) => {
      const key = asString(args[0]);
      const zset = typed(key, "zset");
      if (!zset) return 0;
      const entries = sortedMembers(zset.value);
      const range = rankRange(entries.length, args[1], args[2]);
      if (!range) return 0;
      for (const [member] of entries.slice(range[0], range[1] + 1)) zset.value.delete(member);
      dropIfEmpty(key, zset);
      return range[1] - range[0] + 1;
    },
    ZUNIONSTORE: (args) => {
      const destination = asString(args[0]);
      const count = asInteger(args[1]);
      const sources = args.slice(2, 2 + count).map((key) => typed(asString(key), "zset"));
      let weights: number[] = sources.map(() => 1);
      let aggregate: "SUM" | "MIN" | "MAX" = "SUM";
      for (let i = 2 + count; i < args.length; i += 1) {
        const option = flag(args[i]);
        if (option === "WEIGHTS") {
          weights = args.slice(i + 1, i + 1 + count).map(asScore);
          i += count;
        } else if (option === "AGGREGATE") {
          const mode = flag(args[++i]);
          if (mode !== "SUM" && mode !== "MIN" && mode !== "MAX") throw new ReplyError("ERR syntax error");
          aggregate = mode;
        } else throw new ReplyError("ERR syntax error");
      }
      const union = new Map<string, number>();
      sources.forEach((source, index) => {
        for (const [member, raw] of source?.value ?? []) {
          const score = raw * weights[index]!;
          const current = union.get(member);
          union.set(
            member,
            current === undefined
              ? score
              : aggregate === "SUM"
                ? current + score
                : aggregate === "MIN"
                  ? Math.min(current, score)
                  : Math.max(current, score),
          );
        }
      });
      if (union.size === 0) data.delete(destination);
      else data.set(destination, { type: "zset", value: union, expiresAt: null });
      return union.size;
    },
  };

  function run(body: unknown): UpstashResponse<unknown> {
    if (!Array.isArray(body) || body.length === 0) return { error: "ERR empty command" };
    const [name, ...args] = body as unknown[];
    const command = asString(name).toUpperCase();
    const injected = failures.get(command);
    if (injected !== undefined) {
      failures.delete(command);
      return { error: injected };
    }
    const handler = commands[command];
    if (!handler) return { error: `ERR unknown command '${asString(name)}'` };
    try {
      return { result: handler(args) };
    } catch (error) {
      if (error instanceof ReplyError) return { error: error.message };
      throw error;
    }
  }

  const requester: Requester = {
    request: async <TResult>(req: UpstashRequest): Promise<UpstashResponse<TResult>> => {
      const endpoint = req.path?.[0];
      if (endpoint === "pipeline" || endpoint === "multi-exec") {
        // The client maps over the response body itself: a pipeline answers with the array, not `{ result }`.
        const replies = (Array.isArray(req.body) ? req.body : []).map((command) => run(command));
        return replies as unknown as UpstashResponse<TResult>;
      }
      if (req.path && req.path.length > 0) return { error: `ERR unsupported endpoint /${req.path.join("/")}` };
      return run(req.body) as UpstashResponse<TResult>;
    },
  };

  const store: MemoryStore = {
    clock: {
      now,
      advance(ms) {
        offset += ms;
      },
      set(ms) {
        pinned = ms;
        offset = 0;
      },
    },
    ttl: (key) => ttlOf(live(key), 1000),
    dump() {
      const snapshot: Record<string, { type: EntryType; value: unknown; ttl: number }> = {};
      for (const key of liveKeys()) {
        const entry = live(key)!;
        const value =
          entry.type === "string"
            ? entry.value
            : entry.type === "hash"
              ? Object.fromEntries(entry.value)
              : entry.type === "list"
                ? [...entry.value]
                : sortedMembers(entry.value);
        snapshot[key] = { type: entry.type, value, ttl: ttlOf(entry, 1000) };
      }
      return snapshot;
    },
    keys: liveKeys,
    failNext(command, error = `ERR injected failure for ${command.toUpperCase()}`) {
      failures.set(command.toUpperCase(), error);
    },
    clear() {
      data.clear();
      failures.clear();
    },
  };

  return { requester, store };
}

/**
 * The real client over the memory requester. The `Requester` constructor of
 * `@upstash/redis` takes no options, so the command options are set the way
 * `lib/redis.ts` configures the Upstash client: raw replies, no telemetry.
 */
class MemoryRedis extends Redis {
  constructor(requester: Requester) {
    super(requester);
    this.opts = { automaticDeserialization: false };
    this.enableTelemetry = false;
    this.enableAutoPipelining = false;
  }
}

export function createMemoryRedis(options: { now?: () => number } = {}): { redis: Redis; store: MemoryStore } {
  const { requester, store } = createMemoryRequester(options);
  return { redis: new MemoryRedis(requester), store };
}

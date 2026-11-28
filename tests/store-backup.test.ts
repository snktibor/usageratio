import type { Redis } from "@upstash/redis";
import { describe, expect, it } from "vitest";
import { toStringRecord } from "@/lib/redis";
import { createMemoryRedis, type MemoryStore } from "@/lib/redis-memory";
import { type Backup, countByType, parseBackup, restoreBackup, TEMP_PREFIX, takeBackup } from "@/lib/store-backup";

const NOW = Date.parse("2026-11-27T12:00:00Z");
const HOUR = 3_600_000;

function fresh(): { redis: Redis; store: MemoryStore } {
  const { redis, store } = createMemoryRedis({ now: () => NOW });
  return { redis, store };
}

async function populate(redis: Redis): Promise<void> {
  await redis.set("plain", '{"a":1}');
  await redis.set("guard", "1", { px: 2 * HOUR });
  await redis.hset("hash", { "claude:mac": '{"g":"Work"}', "claude:pc": "x" });
  await redis.rpush("list", "newest", "older");
  await redis.sadd("set", "a", "b");
  await redis.zadd("zset", { score: 1_700_000_000_000, member: '{"m":"mac","t":5}' }, { score: 2, member: "second" });
  await redis.pexpireat("zset", NOW + 3 * HOUR);
}

describe("takeBackup", () => {
  it("reads every type with its TTL, and nothing but the keys", async () => {
    const { redis } = fresh();
    await populate(redis);
    const backup = await takeBackup(redis, () => NOW);

    expect(backup.dbsize).toBe(6);
    expect(Object.keys(backup.keys)).toEqual(["guard", "hash", "list", "plain", "set", "zset"]);
    expect(countByType(backup)).toEqual({ string: 2, hash: 1, list: 1, set: 1, zset: 1 });
    expect(backup.keys.plain).toEqual({ type: "string", ttlMs: -1, value: '{"a":1}' });
    expect(backup.keys.hash?.value).toEqual({ "claude:mac": '{"g":"Work"}', "claude:pc": "x" });
    expect(backup.keys.list?.value).toEqual(["newest", "older"]);
    expect(backup.keys.zset?.value).toEqual(["second", 2, '{"m":"mac","t":5}', 1_700_000_000_000]);
    expect(backup.keys.guard).toMatchObject({ ttlMs: 2 * HOUR, expiresAtMs: NOW + 2 * HOUR });
  });

  it("walks more keys than one batch", async () => {
    const { redis } = fresh();
    for (let i = 0; i < 250; i += 1) await redis.set(`k${i}`, String(i));
    const backup = await takeBackup(redis);
    expect(Object.keys(backup.keys)).toHaveLength(250);
    expect(backup.keys.k249?.value).toBe("249");
  });

  it("leaves out a restore's temporary keys, and an empty store backs up to nothing", async () => {
    const { redis } = fresh();
    expect((await takeBackup(redis)).keys).toEqual({});
    await redis.set(`${TEMP_PREFIX}abc`, "half a key");
    expect((await takeBackup(redis)).keys).toEqual({});
  });

  it("refuses a type the app never writes", async () => {
    const { redis } = fresh();
    await redis.set("plain", "x");
    const real = redis.pipeline.bind(redis);
    const odd = Object.create(redis, {
      pipeline: {
        value: () => {
          const pipe = real();
          const exec = pipe.exec.bind(pipe);
          pipe.exec = (async () => ((await exec()) as unknown[]).map((r) => (r === "string" ? "stream" : r))) as never;
          return pipe;
        },
      },
    }) as Redis;
    await expect(takeBackup(odd)).rejects.toThrow(/unsupported type stream/);
  });
});

describe("restoreBackup", () => {
  it("round-trips a whole store into an empty one, TTLs included", async () => {
    const source = fresh();
    await populate(source.redis);
    const backup = parseBackup(JSON.stringify(await takeBackup(source.redis, () => NOW)));

    const target = fresh();
    target.store.clock.set(NOW + HOUR); // an hour later: guard has one hour left, zset two
    const report = await restoreBackup(target.redis, backup, { apply: true, now: () => NOW + HOUR });

    expect(report.restored).toHaveLength(6);
    expect(report.skippedExisting).toEqual([]);
    const dump = target.store.dump();
    expect(Object.keys(dump).sort()).toEqual(["guard", "hash", "list", "plain", "set", "zset"]);
    expect(target.store.ttl("guard")).toBe(HOUR / 1000);
    expect(target.store.ttl("zset")).toBe((2 * HOUR) / 1000);
    expect(target.store.ttl("plain")).toBe(-1);
    expect(await target.redis.lrange("list", 0, -1)).toEqual(["newest", "older"]);
    expect(await target.redis.zrange("zset", 0, -1, { withScores: true })).toEqual([
      "second",
      "2",
      '{"m":"mac","t":5}',
      "1700000000000",
    ]);
    expect(Object.keys(dump).some((key) => key.startsWith(TEMP_PREFIX))).toBe(false);
  });

  it("is a dry run unless told to apply", async () => {
    const source = fresh();
    await populate(source.redis);
    const backup = await takeBackup(source.redis, () => NOW);
    const target = fresh();
    const report = await restoreBackup(target.redis, backup, { now: () => NOW });
    expect(report.restored).toHaveLength(6);
    expect(target.store.keys()).toEqual([]);
  });

  it("selects by exact key and by prefix, and reports a pattern that matches nothing", async () => {
    const source = fresh();
    await populate(source.redis);
    const backup = await takeBackup(source.redis, () => NOW);
    const target = fresh();
    const report = await restoreBackup(target.redis, backup, {
      apply: true,
      only: ["hash", "li*", "nope", "nope:*"],
      now: () => NOW,
    });
    expect(report.restored).toEqual(["hash", "list"]);
    expect(report.unmatched).toEqual(["nope", "nope:*"]);
    expect(target.store.keys()).toEqual(["hash", "list"]);
  });

  it("never overwrites an existing key unless forced", async () => {
    const source = fresh();
    await populate(source.redis);
    const backup = await takeBackup(source.redis, () => NOW);
    const target = fresh();
    await target.redis.set("plain", "newer");
    await target.redis.rpush("hash", "wrong type, still not touched");

    const safe = await restoreBackup(target.redis, backup, { apply: true, only: ["plain", "hash"], now: () => NOW });
    expect(safe.restored).toEqual([]);
    expect(safe.skippedExisting).toEqual(["hash", "plain"]);
    expect(await target.redis.get("plain")).toBe("newer");

    const forced = await restoreBackup(target.redis, backup, {
      apply: true,
      force: true,
      only: ["plain", "hash"],
      now: () => NOW,
    });
    expect(forced.restored).toEqual(["hash", "plain"]);
    expect(forced.replaced).toEqual(["hash", "plain"]);
    expect(await target.redis.get("plain")).toBe('{"a":1}');
    expect(await target.redis.type("hash")).toBe("hash");
  });

  it("refuses to force every key at once, writing nothing", async () => {
    const source = fresh();
    await populate(source.redis);
    const backup = await takeBackup(source.redis, () => NOW);
    const target = fresh();
    await target.redis.set("plain", "newer");
    await expect(restoreBackup(target.redis, backup, { apply: true, force: true, now: () => NOW })).rejects.toThrow(
      "--force needs --only",
    );
    expect(target.store.keys()).toEqual(["plain"]);
  });

  it("skips a key whose TTL has run out, and takes a key that appeared mid-restore for an existing one", async () => {
    const source = fresh();
    await populate(source.redis);
    const backup = await takeBackup(source.redis, () => NOW);

    const late = fresh();
    const expired = await restoreBackup(late.redis, backup, { apply: true, now: () => NOW + 4 * HOUR });
    expect(expired.skippedExpired).toEqual(["guard", "zset"]);
    expect(late.store.keys()).toEqual(["hash", "list", "plain", "set"]);

    const racing = fresh();
    const rival = Object.create(racing.redis, {
      renamenx: {
        value: async (from: string, to: string) => {
          await racing.redis.set(to, "written by someone else");
          return racing.redis.renamenx(from, to);
        },
      },
    }) as Redis;
    const report = await restoreBackup(rival, backup, { apply: true, only: ["plain"], now: () => NOW });
    expect(report.skippedExisting).toEqual(["plain"]);
    expect(await racing.redis.get("plain")).toBe("written by someone else");
    expect(racing.store.keys()).toEqual(["plain"]);
  });

  it("leaves no half-written key behind when a write fails", async () => {
    const source = fresh();
    await populate(source.redis);
    const backup = await takeBackup(source.redis, () => NOW);
    const target = fresh();
    target.store.failNext("RENAMENX");
    await expect(
      restoreBackup(target.redis, backup, { apply: true, only: ["list"], now: () => NOW }),
    ).rejects.toThrow();
    expect(target.store.keys()).toEqual([]);
  });

  it("writes a big collection in chunks", async () => {
    const backup: Backup = {
      takenAt: new Date(NOW).toISOString(),
      dbsize: 1,
      keys: { big: { type: "set", ttlMs: -1, value: Array.from({ length: 1200 }, (_, i) => `m${i}`) } },
    };
    const target = fresh();
    await restoreBackup(target.redis, backup, { apply: true, now: () => NOW });
    expect(await target.redis.scard("big")).toBe(1200);
  });

  it("reads the ops script's older files: a flat hash, string scores, no expiresAtMs", async () => {
    const old = parseBackup(
      JSON.stringify({
        takenAt: new Date(NOW).toISOString(),
        dbsize: 3,
        keys: {
          h: { type: "hash", ttlMs: -1, value: ["f1", "v1", "f2", "v2"] },
          z: { type: "zset", ttlMs: HOUR, value: ["m", "1.5"] },
          s: { type: "string", ttlMs: -1, value: "" },
        },
      }),
    );
    const target = fresh();
    await restoreBackup(target.redis, old, { apply: true, now: () => NOW + 1000 });
    expect(toStringRecord(await target.redis.hgetall("h"))).toEqual({ f1: "v1", f2: "v2" });
    expect(Number(await target.redis.zscore("z", "m"))).toBe(1.5);
    expect(target.store.ttl("z")).toBe(HOUR / 1000);
    expect(await target.redis.get("s")).toBe("");
  });
});

describe("parseBackup", () => {
  const file = (keys: unknown) => JSON.stringify({ takenAt: "2026-11-27T12:00:00Z", dbsize: 1, keys });
  const bad = (text: string, why: RegExp) => expect(() => parseBackup(text)).toThrow(why);

  it("rejects what is not a backup", () => {
    bad("nope", /not JSON/);
    bad("null", /no keys object/);
    bad("{}", /no keys object/);
    bad(JSON.stringify({ keys: {} }), /takenAt/);
  });

  it("rejects a malformed entry, naming the key", () => {
    bad(file({ a: 1 }), /key a: not an object/);
    bad(file({ a: { type: "stream", ttlMs: -1, value: "" } }), /unknown type stream/);
    bad(file({ a: { type: "string", ttlMs: "x", value: "" } }), /ttlMs/);
    bad(file({ a: { type: "string", ttlMs: -1, value: "", expiresAtMs: "x" } }), /expiresAtMs/);
    bad(file({ a: { type: "string", ttlMs: -1, value: 5 } }), /not a string/);
    bad(file({ a: { type: "hash", ttlMs: -1, value: ["odd"] } }), /record/);
    bad(file({ a: { type: "list", ttlMs: -1, value: "x" } }), /not an array/);
    bad(file({ a: { type: "zset", ttlMs: -1, value: ["m", "high"] } }), /member\/score/);
    bad(file({ a: { type: "set", ttlMs: -1, value: [] } }), /empty value/);
  });

  it("accepts a valid file", () => {
    const text = file({ a: { type: "hash", ttlMs: -1, value: { f: "v" } } });
    expect(parseBackup(text).keys.a?.type).toBe("hash");
  });
});

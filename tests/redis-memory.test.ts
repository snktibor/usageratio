import { beforeEach, describe, expect, it } from "vitest";
import { parseOfficialUsageUpdate } from "@/lib/official-usage";
import { getMemoryStoreForTests, getRedis, resetRedisClientForTests, toStringRecord } from "@/lib/redis";
import { createMemoryRedis, type MemoryStore } from "@/lib/redis-memory";
import { parseSettingsUpdate } from "@/lib/settings";
import {
  loadEvents,
  loadIndexes,
  loadRawSettings,
  saveOfficialUsage,
  saveSettings,
  storeReport,
} from "@/lib/usage-store";
import { parseUsageReport, type UsageReport } from "@/lib/validation";

const T0 = Date.parse("2026-09-23T12:00:00Z");

describe("the memory store under the real @upstash/redis client", () => {
  let redis: ReturnType<typeof createMemoryRedis>["redis"];
  let store: MemoryStore;

  beforeEach(() => {
    ({ redis, store } = createMemoryRedis({ now: () => T0 }));
  });

  it("answers strings like the REST API: raw values, OK, null on a refused NX", async () => {
    expect(await redis.set("a", "1")).toBe("OK");
    expect(await redis.get("a")).toBe("1");
    expect(await redis.set("a", "2", { nx: true })).toBeNull();
    expect(await redis.get("a")).toBe("1");
    expect(await redis.set("b", "x", { xx: true })).toBeNull();
    expect(await redis.get("missing")).toBeNull();
    // A stored JSON document stays a string: no automatic deserialization.
    await redis.set("doc", JSON.stringify({ v: 2 }));
    expect(await redis.get("doc")).toBe('{"v":2}');
  });

  it("expires keys lazily on the injected clock", async () => {
    await redis.set("t", "x", { ex: 10 });
    expect(await redis.ttl("t")).toBe(10);
    expect(store.ttl("t")).toBe(10);
    expect(await redis.pttl("t")).toBe(10_000);
    store.clock.advance(9_000);
    expect(await redis.ttl("t")).toBe(1);
    store.clock.advance(1_000);
    expect(await redis.get("t")).toBeNull();
    expect(await redis.ttl("t")).toBe(-2);
    expect(store.keys()).toEqual([]);

    await redis.set("forever", "1");
    expect(await redis.ttl("forever")).toBe(-1);
    expect(await redis.expire("forever", 5)).toBe(1);
    expect(await redis.expire("nope", 5)).toBe(0);
    // The clock stands at T0 + 10 s here, so the key expires at T0 + 15 s.
    store.clock.set(T0 + 14_999);
    expect(await redis.exists("forever")).toBe(1);
    store.clock.set(T0 + 15_000);
    expect(await redis.exists("forever")).toBe(0);
  });

  it("counts with INCR and DECR", async () => {
    expect(await redis.incr("n")).toBe(1);
    expect(await redis.incr("n")).toBe(2);
    expect(await redis.decr("n")).toBe(1);
    expect(await redis.get("n")).toBe("1");
    await redis.set("word", "abc");
    await expect(redis.incr("word")).rejects.toThrow(/not an integer/);
  });

  it("keeps hashes and hands HGETALL back flat", async () => {
    expect(await redis.hset("h", { a: "1", b: "2" })).toBe(2);
    expect(await redis.hset("h", { a: "9" })).toBe(0);
    expect(await redis.hsetnx("h", "a", "0")).toBe(0);
    expect(await redis.hsetnx("h", "c", 1727000000)).toBe(1);
    const raw = await redis.hgetall("h");
    expect(raw).toEqual(["a", "9", "b", "2", "c", "1727000000"]);
    expect(toStringRecord(raw)).toEqual({ a: "9", b: "2", c: "1727000000" });
    expect(await redis.hget("h", "b")).toBe("2");
    expect(await redis.hmget("h", "a", "zz")).toEqual(["9", null]);
    expect(await redis.hexists("h", "b")).toBe(1);
    expect(await redis.hlen("h")).toBe(3);
    expect(await redis.hdel("h", "a", "zz")).toBe(1);
    expect(await redis.hlen("h")).toBe(2);
    expect(await redis.hgetall("none")).toEqual([]);
  });

  it("keeps sorted sets: NX adds, score ranges, ranks, unions and renames", async () => {
    expect(await redis.zadd("z", { nx: true }, { score: 1, member: "a" }, { score: 2, member: "b" })).toBe(2);
    expect(await redis.zadd("z", { nx: true }, { score: 5, member: "a" })).toBe(0);
    expect(await redis.zadd("z", { score: 3, member: "c" })).toBe(1);
    expect(await redis.zrange("z", 0, "+inf", { byScore: true })).toEqual(["a", "b", "c"]);
    expect(await redis.zrange("z", 2, 3, { byScore: true, withScores: true })).toEqual(["b", "2", "c", "3"]);
    expect(await redis.zrange("z", "(2", "+inf", { byScore: true })).toEqual(["c"]);
    expect(await redis.zrange("z", 0, -1)).toEqual(["a", "b", "c"]);
    expect(await redis.zrange("z", -1, -1, { withScores: true })).toEqual(["c", "3"]);
    expect(await redis.zrange("z", 0, 1, { rev: true })).toEqual(["c", "b"]);
    expect(await redis.zcard("z")).toBe(3);
    expect(await redis.zremrangebyscore("z", 0, 1)).toBe(1);
    expect(await redis.zrange("z", 0, -1)).toEqual(["b", "c"]);
    await redis.zadd("z", { score: 4, member: "d" }, { score: 5, member: "e" });
    expect(await redis.zremrangebyrank("z", 0, -3)).toBe(2);
    expect(await redis.zrange("z", 0, -1)).toEqual(["d", "e"]);

    await redis.zadd("other", { score: 9, member: "d" }, { score: 1, member: "f" });
    expect(await redis.zunionstore("dest", 2, ["z", "other"], { aggregate: "max" })).toBe(3);
    expect(await redis.zrange("dest", 0, -1, { withScores: true })).toEqual(["f", "1", "e", "5", "d", "9"]);
    expect(await redis.rename("dest", "moved")).toBe("OK");
    expect(await redis.exists("dest")).toBe(0);
    expect(await redis.zcard("moved")).toBe(3);
    expect(await redis.renamenx("moved", "other")).toBe(0);
    await expect(redis.rename("nope", "x")).rejects.toThrow(/no such key/);
  });

  it("keeps lists newest-first with LPUSH, LTRIM and LRANGE", async () => {
    expect(await redis.lpush("l", "a", "b")).toBe(2);
    expect(await redis.lpush("l", "c")).toBe(3);
    expect(await redis.lrange("l", 0, -1)).toEqual(["c", "b", "a"]);
    expect(await redis.ltrim("l", 0, 1)).toBe("OK");
    expect(await redis.lrange("l", 0, -1)).toEqual(["c", "b"]);
    expect(await redis.llen("l")).toBe(2);
  });

  it("deletes several keys at once and lists them with KEYS and SCAN", async () => {
    await redis.set("usage:a", "1");
    await redis.hset("usage:b", { x: "1" });
    await redis.set("other", "1");
    expect(await redis.keys("usage:*")).toEqual(["usage:a", "usage:b"]);
    expect(await redis.scan("0", { match: "usage:*", count: 100 })).toEqual(["0", ["usage:a", "usage:b"]]);
    const [cursor, page] = (await redis.scan("0", { count: 1 })) as [string, string[]];
    expect(page).toEqual(["other"]);
    expect(cursor).toBe("1");
    expect(await redis.del("usage:a", "usage:b", "missing")).toBe(2);
    expect(store.keys()).toEqual(["other"]);
  });

  it("runs pipelines and transactions and returns one result per command", async () => {
    const pipeline = redis.pipeline();
    pipeline.set("x", "1");
    pipeline.get("x");
    pipeline.incr("n");
    pipeline.hgetall("nothing");
    expect(await pipeline.exec()).toEqual(["OK", "1", 1, []]);

    const tx = redis.multi();
    tx.hsetnx("g", "Work", "#000");
    tx.zadd("e", { nx: true }, { score: 1, member: "m" });
    tx.expire("e", 60);
    expect(await tx.exec()).toEqual([1, 1, 1]);
    expect(store.ttl("e")).toBe(60);
  });

  it("injects a failure into the next call of a command, and only that one", async () => {
    store.failNext("get", "boom");
    await expect(redis.get("x")).rejects.toThrow("boom");
    expect(await redis.get("x")).toBeNull();

    store.failNext("incr");
    const pipeline = redis.pipeline();
    pipeline.set("y", "1");
    pipeline.incr("n");
    await expect(pipeline.exec()).rejects.toThrow(/Command 2 \[ incr \] failed: ERR injected failure/);
    expect(await redis.get("y")).toBe("1");
  });

  it("refuses a command against a key of another type", async () => {
    await redis.set("s", "1");
    await expect(redis.hgetall("s")).rejects.toThrow(/WRONGTYPE/);
    await expect(redis.zadd("s", { score: 1, member: "a" })).rejects.toThrow(/WRONGTYPE/);
    await expect(redis.lpush("s", "a")).rejects.toThrow(/WRONGTYPE/);
    await redis.hset("h", { a: "1" });
    await expect(redis.get("h")).rejects.toThrow(/WRONGTYPE/);
  });

  it("dumps and clears the store", async () => {
    await redis.set("s", "1", { ex: 30 });
    await redis.hset("h", { a: "1" });
    await redis.zadd("z", { score: 2, member: "b" }, { score: 1, member: "a" });
    await redis.lpush("l", "x");
    expect(store.dump()).toEqual({
      s: { type: "string", value: "1", ttl: 30 },
      h: { type: "hash", value: { a: "1" }, ttl: -1 },
      z: {
        type: "zset",
        value: [
          ["a", 1],
          ["b", 2],
        ],
        ttl: -1,
      },
      l: { type: "list", value: ["x"], ttl: -1 },
    });
    store.clear();
    expect(store.keys()).toEqual([]);
    expect(await redis.ping()).toBe("PONG");
  });
});

describe("the application's store code on the memory store", () => {
  const OPTIONS = { now: new Date(T0), maxClockSkewMinutes: 10, retentionDays: 70, timeZone: "Europe/Budapest" };

  function report(body: Record<string, unknown>): UsageReport {
    const parsed = parseUsageReport(
      {
        machineId: "mac-studio",
        groupId: "Personal",
        providers: { claude: 5678, deepseek: 1234 },
        models: { claude: { "claude-opus-4-5-20251101": 5000 } },
        timestamp: new Date(T0).toISOString(),
        ...body,
      },
      OPTIONS,
    );
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    return parsed.report;
  }

  beforeEach(() => {
    process.env.USAGE_STORE = "memory";
    resetRedisClientForTests();
  });

  it("chooses the memory store from USAGE_STORE and exposes its handle to tests", () => {
    getRedis();
    expect(getMemoryStoreForTests()).not.toBeNull();
    expect(getMemoryStoreForTests()?.keys()).toEqual([]);
  });

  it("stores a report once: the same report again is a duplicate", async () => {
    const now = new Date(T0 + 1000);
    const cycle = { timeZone: "Europe/Budapest", startMs: T0 - 86_400_000 };
    const first = await storeReport(report({}), now, 70, cycle);
    expect(first).toEqual({
      ok: true,
      duplicate: false,
      newGroup: true,
      newProviders: ["claude", "deepseek"],
      heartbeat: false,
    });
    const second = await storeReport(report({}), now, 70, cycle);
    expect(second).toEqual({ ok: true, duplicate: true, newGroup: false, newProviders: [], heartbeat: false });

    const store = getMemoryStoreForTests()!;
    expect(store.keys()).toEqual([
      "usage:events:claude:Personal",
      "usage:events:deepseek:Personal",
      "usage:groups",
      "usage:machines",
      "usage:providers",
    ]);
    expect(store.ttl("usage:events:claude:Personal")).toBe(71 * 86_400);
  });

  it("reads back the indexes and the events it stored", async () => {
    const now = new Date(T0 + 1000);
    await storeReport(report({}), now, 70, null);
    await storeReport(
      report({ machineId: "thinkpad", groupId: "Work", providers: { claude: 100 }, models: {} }),
      now,
      70,
      null,
    );

    const indexes = await loadIndexes();
    expect(indexes.settings).toBeNull();
    expect(indexes.groups.map((group) => group.groupId).sort()).toEqual(["Personal", "Work"]);
    expect(indexes.providers.map((provider) => provider.providerId)).toEqual(["claude", "deepseek"]);
    expect(indexes.machines.map((machine) => `${machine.providerId}:${machine.machineId}`).sort()).toEqual([
      "claude:mac-studio",
      "claude:thinkpad",
      "deepseek:mac-studio",
    ]);

    const providerIds = indexes.providers.map((provider) => provider.providerId);
    const { eventsByProvider, groups } = await loadEvents(providerIds, indexes.groups, T0 - 3_600_000);
    expect(eventsByProvider.claude).toHaveLength(2);
    expect(eventsByProvider.claude).toContainEqual({
      machineId: "mac-studio",
      groupId: "Personal",
      tokens: 5678,
      ts: T0,
      models: { "claude-opus-4-5-20251101": 5000 },
    });
    expect(eventsByProvider.deepseek).toEqual([{ machineId: "mac-studio", groupId: "Personal", tokens: 1234, ts: T0 }]);
    expect(groups.every((group) => group.hasReports)).toBe(true);
  });

  it("saves the settings document and the groups, and reads the document back", async () => {
    const parsed = parseSettingsUpdate({
      period: "weekly",
      useTokenLimits: true,
      limits: { claude: 500_000 },
      reset: { weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "Europe/Budapest" },
      showRemaining: true,
      hiddenProviders: [],
      excludedProviders: {},
      subLimits: {},
      groups: [{ id: "Work", color: "#3987e5" }],
      removedGroups: [],
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));

    expect(await saveSettings(parsed.update, new Date(T0), ["claude"])).toEqual({ ok: true });
    const raw = await loadRawSettings();
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toMatchObject({ period: "weekly", limits: { claude: 500_000 }, updatedAt: T0 });
    const indexes = await loadIndexes();
    expect(indexes.groups).toEqual([{ groupId: "Work", color: "#3987e5", firstSeenAt: T0 }]);
  });

  it("stores and clears an official-usage figure", async () => {
    const parsed = parseOfficialUsageUpdate({ providerId: "claude", subLimitId: null, raw: "45.5", cycleStartMs: T0 });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    await saveOfficialUsage(parsed.update, new Date(T0 + 5000));
    expect((await loadIndexes()).officialUsage).toEqual({
      claude: JSON.stringify({ raw: "45.5", enteredAt: T0 + 5000, cycleStartMs: T0 }),
    });
    await saveOfficialUsage({ ...parsed.update, raw: "" }, new Date(T0 + 6000));
    expect((await loadIndexes()).officialUsage).toEqual({});
  });
});

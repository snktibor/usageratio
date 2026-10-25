import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, MAX_MACHINES } from "@/lib/config";
import { type CycleSummary, serializeCycleSummary } from "@/lib/history";
import { MAX_PROVIDERS } from "@/lib/providers";
import { getMemoryStoreForTests, getRedis, toStringRecord } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { emptyResets, type ProviderResets } from "@/lib/resets";
import { MAX_GROUPS, ownResetOf, resolveConfig } from "@/lib/settings";
import {
  loadEvents,
  loadIndexes,
  loadOldestReportTime,
  loadRawSettings,
  loadResets,
  saveResetChange,
  saveResetOverride,
  saveResets,
  storeReport,
} from "@/lib/usage-store";
import { parseUsageReport, type UsageReport } from "@/lib/validation";
import { useRedis } from "./helpers/redis-fixture";

const NOW = new Date("2026-09-23T00:00:00Z");
const OPTIONS = { now: NOW, maxClockSkewMinutes: 10, retentionDays: 70, timeZone: "UTC" };
const GROUPS = [{ groupId: "Personal", color: null, firstSeenAt: 0 }];

function report(body: Record<string, unknown>): UsageReport {
  const parsed = parseUsageReport(
    {
      machineId: "mac",
      groupId: "Personal",
      providers: { claude: 1234 },
      timestamp: "2026-09-22T10:00:00Z",
      ...body,
    },
    OPTIONS,
  );
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.report;
}

/** `storeReport`, asserting it was not refused by a registry cap. */
async function storeOk(...args: Parameters<typeof storeReport>) {
  const result = await storeReport(...args);
  if (!result.ok) throw new Error(`storeReport refused: ${result.refused} (limit ${result.limit})`);
  return result;
}

describe("storeReport — duplicate detection", () => {
  useRedis();

  it("stores a report once; the identical retry is a duplicate that changes nothing", async () => {
    const first = await storeReport(report({}), NOW, 70, null);
    expect(first).toEqual({ ok: true, duplicate: false, newGroup: true, newProviders: ["claude"], heartbeat: false });

    const second = await storeReport(report({}), NOW, 70, null);
    expect(second).toEqual({ ok: true, duplicate: true, newGroup: false, newProviders: [], heartbeat: false });

    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    expect(eventsByProvider.claude).toHaveLength(1);
  });

  it("is not a duplicate when the machine, the tokens or the time differ", async () => {
    await storeReport(report({}), NOW, 70, null);
    expect((await storeOk(report({ providers: { claude: 9999 } }), NOW, 70, null)).duplicate).toBe(false);
    expect((await storeOk(report({ machineId: "other" }), NOW, 70, null)).duplicate).toBe(false);
    expect((await storeOk(report({ timestamp: "2026-09-22T11:00:00Z" }), NOW, 70, null)).duplicate).toBe(false);
  });

  it("is a duplicate only once every one of its providers' events was already stored", async () => {
    await storeReport(report({ providers: { claude: 100, deepseek: 50 } }), NOW, 70, null);
    // Claude repeats exactly, DeepSeek does not: not a duplicate overall, and both providers are already known.
    const mixed = await storeOk(report({ providers: { claude: 100, deepseek: 999 } }), NOW, 70, null);
    expect(mixed.duplicate).toBe(false);
    expect(mixed.newProviders).toEqual([]);

    const repeat = await storeOk(report({ providers: { claude: 100, deepseek: 999 } }), NOW, 70, null);
    expect(repeat.duplicate).toBe(true);
  });
});

describe("loadOldestReportTime", () => {
  useRedis();

  it("is null before any report, then the oldest report over every provider and group", async () => {
    const groups = [...GROUPS, { groupId: "Work", color: null, firstSeenAt: 0 }];
    expect(await loadOldestReportTime(["claude", "deepseek"], groups)).toBeNull();

    await storeOk(report({ timestamp: "2026-09-22T10:00:00Z" }), NOW, 70, null);
    await storeOk(
      report({ groupId: "Work", providers: { deepseek: 5 }, timestamp: "2026-09-21T08:00:00Z" }),
      NOW,
      70,
      null,
    );
    await storeOk(report({ timestamp: "2026-09-22T12:00:00Z" }), NOW, 70, null);

    expect(await loadOldestReportTime(["claude", "deepseek"], groups)).toBe(Date.parse("2026-09-21T08:00:00Z"));
    expect(await loadOldestReportTime(["claude"], groups)).toBe(Date.parse("2026-09-22T10:00:00Z"));
  });
});

describe("storeReport — cost (an opt-in API-list-price estimate)", () => {
  useRedis();

  it("round-trips the cost estimate and its split by model, alongside tokens", async () => {
    const withCost = report({
      providers: { claude: 1000 },
      costs: { claude: 4.5678 },
      modelCosts: { claude: { "claude-opus-4-5": 4.5678 } },
    });
    await storeOk(withCost, NOW, 70, null);

    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    expect(eventsByProvider.claude).toEqual([
      {
        machineId: "mac",
        groupId: "Personal",
        tokens: 1000,
        ts: withCost.timestampMs,
        costUsd: 4.5678,
        modelCosts: { "claude-opus-4-5": 4.5678 },
      },
    ]);
  });

  it("stores no cost fields at all for a report that never sent one (an opted-out or older client)", async () => {
    await storeOk(report({ providers: { claude: 500 } }), NOW, 70, null);

    const raw = await getRedis().zrange<string[]>(KEYS.events("claude", "Personal"), 0, -1);
    const member = JSON.parse(raw[0]!);
    expect(member).not.toHaveProperty("$");
    expect(member).not.toHaveProperty("$b");

    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    expect(eventsByProvider.claude![0]).not.toHaveProperty("costUsd");
    expect(eventsByProvider.claude![0]).not.toHaveProperty("modelCosts");
  });

  it("reads a legacy member (written before cost existed) as having no cost, rather than failing", async () => {
    await getRedis().zadd(KEYS.events("claude", "Personal"), {
      score: 1000,
      member: JSON.stringify({ m: "old-mac", t: 500, ts: 1000 }),
    });
    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    expect(eventsByProvider.claude).toEqual([{ machineId: "old-mac", groupId: "Personal", tokens: 500, ts: 1000 }]);
  });

  it("never puts a cost on a day's checkpoint, even when the report that brought it in had one", async () => {
    const cycle = { timeZone: "UTC", startMs: Date.parse("2026-09-20T00:00:00Z") };
    const withDays = report({
      providers: { claude: 1200 },
      costs: { claude: 6 },
      days: {
        "2026-09-21": { providers: { claude: 1000 } },
        "2026-09-22": { providers: { claude: 200 } },
      },
    });
    await storeReport(withDays, NOW, 70, cycle);

    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    const checkpoint = eventsByProvider.claude!.find((event) => event.checkpoint);
    expect(checkpoint).toBeDefined();
    expect(checkpoint).not.toHaveProperty("costUsd");
    expect(checkpoint).not.toHaveProperty("modelCosts");
  });
});

describe("storeReport — day checkpoints", () => {
  useRedis();
  const cycle = { timeZone: "UTC", startMs: Date.parse("2026-09-20T00:00:00Z") };

  it("stores a checkpoint for each finished day, but not for the one still running", async () => {
    const withDays = report({
      providers: { claude: 1200 },
      days: {
        "2026-09-21": { providers: { claude: 1000 } },
        "2026-09-22": { providers: { claude: 200 } },
      },
    });
    await storeReport(withDays, NOW, 70, cycle);

    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    const checkpoints = eventsByProvider.claude!.filter((event) => event.checkpoint);
    expect(checkpoints).toEqual([
      {
        machineId: "mac",
        groupId: "Personal",
        tokens: 1000,
        ts: Date.parse("2026-09-22T00:00:00Z"),
        checkpoint: true,
        basisMs: Date.parse("2026-09-20T00:00:00Z"),
      },
    ]);
    // The report itself, plus the one finished day's checkpoint: nothing for the day in progress.
    expect(eventsByProvider.claude).toHaveLength(2);
  });

  it("stores the report alone when there is no cycle to bound the checkpoints", async () => {
    const withDays = report({
      providers: { claude: 1200 },
      days: {
        "2026-09-21": { providers: { claude: 1000 } },
        "2026-09-22": { providers: { claude: 200 } },
      },
    });
    // A failed settings read (lib/ingest.ts) passes `null`: the report is stored, checkpoints are skipped.
    await storeReport(withDays, NOW, 70, null);
    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    expect(eventsByProvider.claude).toHaveLength(1);
    expect(eventsByProvider.claude![0]!.checkpoint).toBeUndefined();
  });

  it("does not repeat a checkpoint a later report brings again", async () => {
    const first = report({
      providers: { claude: 1200 },
      days: {
        "2026-09-21": { providers: { claude: 1000 } },
        "2026-09-22": { providers: { claude: 200 } },
      },
    });
    await storeReport(first, NOW, 70, cycle);

    const second = report({
      providers: { claude: 1500 },
      timestamp: "2026-09-22T14:00:00Z",
      days: {
        "2026-09-21": { providers: { claude: 1000 } },
        "2026-09-22": { providers: { claude: 500 } },
      },
    });
    await storeReport(second, NOW, 70, cycle);

    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    // Two report events (10:00 and 14:00) plus one checkpoint: the day-21 checkpoint is identical both
    // times (same machine, tokens and moment), so ZADD NX skips the retry rather than storing it twice.
    expect(eventsByProvider.claude).toHaveLength(3);
    expect(eventsByProvider.claude!.filter((event) => event.checkpoint)).toHaveLength(1);
  });
});

describe("storeReport — heartbeat (an empty providers snapshot)", () => {
  useRedis();

  it("registers the group and writes nothing else", async () => {
    const result = await storeReport(report({ providers: {} }), NOW, 70, null);
    expect(result).toEqual({ ok: true, duplicate: false, newGroup: true, newProviders: [], heartbeat: true });

    const indexes = await loadIndexes();
    expect(indexes.groups.map((group) => group.groupId)).toEqual(["Personal"]);
    expect(indexes.providers).toEqual([]);
    expect(indexes.machines).toEqual([]);
    expect(getMemoryStoreForTests()?.keys()).toEqual(["usage:groups"]);
  });

  it("a second heartbeat of an already-known group is not a new group, and still writes nothing else", async () => {
    await storeReport(report({ providers: {} }), NOW, 70, null);
    const again = await storeReport(report({ providers: {}, machineId: "other" }), NOW, 70, null);
    expect(again).toEqual({ ok: true, duplicate: false, newGroup: false, newProviders: [], heartbeat: true });
    expect(getMemoryStoreForTests()?.keys()).toEqual(["usage:groups"]);
  });

  it("a real report after a heartbeat registers its provider and machine as usual", async () => {
    await storeReport(report({ providers: {} }), NOW, 70, null);
    const real = await storeReport(report({ providers: { claude: 500 } }), NOW, 70, null);
    expect(real).toEqual({ ok: true, duplicate: false, newGroup: false, newProviders: ["claude"], heartbeat: false });

    const indexes = await loadIndexes();
    expect(indexes.providers.map((provider) => provider.providerId)).toEqual(["claude"]);
    expect(indexes.machines).toHaveLength(1);
  });
});

describe("storeReport — machine mode and interval", () => {
  useRedis();

  it("defaults a machine to auto/null and omits both fields from the stored entry", async () => {
    await storeOk(report({}), NOW, 70, null);
    const indexes = await loadIndexes();
    expect(indexes.machines).toEqual([
      expect.objectContaining({ machineId: "mac", mode: "auto", intervalMinutes: null }),
    ]);

    const raw = await getRedis().hget<string>("usage:machines", "claude:mac");
    expect(JSON.parse(raw!)).not.toHaveProperty("md");
    expect(JSON.parse(raw!)).not.toHaveProperty("iv");
  });

  it("stores a manual machine's mode, and an auto machine's own interval", async () => {
    await storeOk(report({ machineId: "phone", mode: "manual" }), NOW, 70, null);
    await storeOk(report({ machineId: "server", mode: "auto", intervalMinutes: 30 }), NOW, 70, null);

    const indexes = await loadIndexes();
    const byId = new Map(indexes.machines.map((machine) => [machine.machineId, machine]));
    expect(byId.get("phone")).toEqual(
      expect.objectContaining({ machineId: "phone", mode: "manual", intervalMinutes: null }),
    );
    expect(byId.get("server")).toEqual(
      expect.objectContaining({ machineId: "server", mode: "auto", intervalMinutes: 30 }),
    );

    const rawPhone = await getRedis().hget<string>("usage:machines", "claude:phone");
    expect(JSON.parse(rawPhone!)).toMatchObject({ md: "manual" });
    expect(JSON.parse(rawPhone!)).not.toHaveProperty("iv");

    const rawServer = await getRedis().hget<string>("usage:machines", "claude:server");
    expect(JSON.parse(rawServer!)).toMatchObject({ iv: 30 });
    expect(JSON.parse(rawServer!)).not.toHaveProperty("md");
  });

  it("reads an entry stored before mode/interval existed as auto/null (production Redis)", async () => {
    await getRedis().hset("usage:machines", { "claude:old-mac": JSON.stringify({ g: "Personal", ts: 1000, t: 500 }) });
    const indexes = await loadIndexes();
    expect(indexes.machines).toEqual([
      expect.objectContaining({ machineId: "old-mac", mode: "auto", intervalMinutes: null }),
    ]);
  });

  it("ignores a damaged interval value and falls back to null", async () => {
    await getRedis().hset("usage:machines", {
      "claude:weird": JSON.stringify({ g: "Personal", ts: 1000, t: 500, iv: -5 }),
    });
    const indexes = await loadIndexes();
    expect(indexes.machines).toEqual([
      expect.objectContaining({ machineId: "weird", mode: "auto", intervalMinutes: null }),
    ]);
  });
});

describe("storeReport — registry caps", () => {
  useRedis();

  it("refuses a brand new group once MAX_GROUPS is reached, but keeps taking reports for an existing one", async () => {
    for (let i = 0; i < MAX_GROUPS; i++) {
      await storeOk(report({ groupId: `Group ${i}`, providers: {} }), NOW, 70, null);
    }
    expect((await storeReport(report({ groupId: "Group 0", providers: {} }), NOW, 70, null)).ok).toBe(true);

    const refused = await storeReport(report({ groupId: "Group new", providers: {} }), NOW, 70, null);
    expect(refused).toEqual({ ok: false, refused: "too_many_groups", limit: MAX_GROUPS });
  });

  it("refuses a brand new provider once MAX_PROVIDERS is reached, but keeps taking reports for an existing one", async () => {
    for (let i = 0; i < MAX_PROVIDERS; i++) {
      await storeOk(report({ providers: { [`provider${i}`]: 10 } }), NOW, 70, null);
    }
    expect((await storeReport(report({ providers: { provider0: 20 } }), NOW, 70, null)).ok).toBe(true);

    const refused = await storeReport(report({ providers: { brandnew: 10 } }), NOW, 70, null);
    expect(refused).toEqual({ ok: false, refused: "too_many_providers", limit: MAX_PROVIDERS });
  });

  it("refuses a brand new machine once MAX_MACHINES is reached, but keeps taking reports for an existing one", async () => {
    for (let i = 0; i < MAX_MACHINES; i++) {
      await storeOk(report({ machineId: `m${i}` }), NOW, 70, null);
    }
    expect((await storeReport(report({ machineId: "m0" }), NOW, 70, null)).ok).toBe(true);

    const refused = await storeReport(report({ machineId: "brand-new-machine" }), NOW, 70, null);
    expect(refused).toEqual({ ok: false, refused: "too_many_machines", limit: MAX_MACHINES });
  });

  it("a heartbeat only ever checks the group cap: it never touches providers or machines", async () => {
    for (let i = 0; i < MAX_PROVIDERS; i++) {
      await storeOk(report({ providers: { [`provider${i}`]: 10 } }), NOW, 70, null);
    }
    // Providers (and their "provider:mac" machines) are already at their cap; a heartbeat still goes through.
    const heartbeat = await storeReport(report({ providers: {}, machineId: "another" }), NOW, 70, null);
    expect(heartbeat).toEqual({ ok: true, duplicate: false, newGroup: false, newProviders: [], heartbeat: true });
  });
});

describe("resets", () => {
  useRedis();
  const resets: ProviderResets = {
    v: 1,
    events: [
      {
        id: "r1",
        atMs: Date.parse("2026-09-22T14:00:00Z"),
        kind: "keep",
        cycleStartMs: Date.parse("2026-09-21T00:00:00Z"),
        before: 80,
        beforeAtMs: null,
        source: "manual",
        recordedAtMs: Date.parse("2026-09-22T14:05:00Z"),
      },
    ],
    autoOffCycleStartMs: null,
  };

  it("saves and loads one provider's resets, and drops a document left empty", async () => {
    await saveResets("claude", resets);
    expect((await loadResets()).claude).toEqual(resets);
    expect((await loadIndexes()).resets.claude).toEqual(resets);
    await saveResets("claude", emptyResets());
    expect(await loadResets()).toEqual({});
  });

  it("sets and removes a provider's own reset", async () => {
    const own = { weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" as const };
    await saveResetOverride("openai", own, NOW, ["openai"]);
    expect(ownResetOf(resolveConfig(getConfig(), await loadRawSettings()), "openai")).toEqual(own);
    await saveResetOverride("openai", null, NOW, ["openai"]);
    expect(ownResetOf(resolveConfig(getConfig(), await loadRawSettings()), "openai")).toBeNull();
  });

  describe("saveResetChange", () => {
    const own = { weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" as const };
    const figure = '{"raw":"5","enteredAt":1,"cycleStartMs":0}';
    const archived = (start: number): CycleSummary => ({
      v: 1,
      start,
      end: start + 1000,
      total: 5,
      limit: null,
      official: null,
      groups: {},
      machines: 1,
      models: {},
      subLimits: {},
      archivedAt: start + 1000,
    });
    const change = { providerId: "openai", providerIds: ["openai"], now: NOW, officialFields: {} };

    it("writes the resets, and removes a document left empty", async () => {
      await saveResetChange({ ...change, resets, rawSettings: null });
      expect((await loadResets()).openai).toEqual(resets);
      await saveResetChange({ ...change, resets: emptyResets(), rawSettings: null });
      expect(await loadResets()).toEqual({});
    });

    it("sets and removes the provider's own reset, and leaves it alone when none is given", async () => {
      await saveResetChange({ ...change, resets, override: own, rawSettings: await loadRawSettings() });
      expect(ownResetOf(resolveConfig(getConfig(), await loadRawSettings()), "openai")).toEqual(own);
      await saveResetChange({ ...change, resets, rawSettings: await loadRawSettings() });
      expect(ownResetOf(resolveConfig(getConfig(), await loadRawSettings()), "openai")).toEqual(own);
      await saveResetChange({ ...change, resets, override: null, rawSettings: await loadRawSettings() });
      expect(ownResetOf(resolveConfig(getConfig(), await loadRawSettings()), "openai")).toBeNull();
    });

    it("deletes the archived summary at the given start only", async () => {
      const history = KEYS.history("openai");
      await getRedis().zadd(history, { score: 1000, member: serializeCycleSummary(archived(1000)) });
      await getRedis().zadd(history, { score: 5000, member: serializeCycleSummary(archived(5000)) });
      await saveResetChange({ ...change, resets, rawSettings: null, deleteArchivedStartMs: 1000 });
      expect(await getRedis().zrange(history, 0, -1)).toEqual([serializeCycleSummary(archived(5000))]);
    });

    it("deletes the cycle's all-time ledger entry with it, so its next archiving writes it again", async () => {
      const ledger = KEYS.allTime("openai");
      await getRedis().hset(ledger, { "1000": serializeCycleSummary(archived(1000)) });
      await getRedis().hset(ledger, { "5000": serializeCycleSummary(archived(5000)) });
      await saveResetChange({ ...change, resets, rawSettings: null, deleteArchivedStartMs: 1000 });
      expect(Object.keys(toStringRecord(await getRedis().hgetall(ledger)))).toEqual(["5000"]);
    });

    it("writes the official fields, and nothing for none", async () => {
      await saveResetChange({ ...change, resets, rawSettings: null });
      expect((await loadIndexes()).officialUsage).toEqual({});
      await saveResetChange({ ...change, resets, rawSettings: null, officialFields: { claude: figure } });
      expect((await loadIndexes()).officialUsage).toEqual({ claude: figure });
    });

    it("writes all of it in one transaction", async () => {
      await getRedis().zadd(KEYS.history("openai"), { score: 1000, member: serializeCycleSummary(archived(1000)) });
      const multi = vi.spyOn(getRedis(), "multi");
      await saveResetChange({
        ...change,
        resets,
        override: own,
        rawSettings: null,
        deleteArchivedStartMs: 1000,
        officialFields: { claude: figure },
      });
      expect(multi).toHaveBeenCalledTimes(1);
      expect((await loadResets()).openai).toEqual(resets);
      expect(ownResetOf(resolveConfig(getConfig(), await loadRawSettings()), "openai")).toEqual(own);
      expect(await getRedis().zcard(KEYS.history("openai"))).toBe(0);
      expect((await loadIndexes()).officialUsage).toEqual({ claude: figure });
    });
  });
});

describe("storeReport — the counting basis", () => {
  useRedis();
  const S = Date.parse("2026-09-21T00:00:00Z");
  const R = Date.parse("2026-09-22T14:00:00Z");

  it("stamps every report and checkpoint with the cycle start it was counted from", async () => {
    const withDays = report({
      providers: { claude: 1200 },
      days: {
        "2026-09-21": { providers: { claude: 1000 } },
        "2026-09-22": { providers: { claude: 200 } },
      },
    });
    await storeOk(withDays, NOW, 70, { timeZone: "UTC", startMs: S });
    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    expect(eventsByProvider.claude!.some((event) => event.checkpoint)).toBe(true);
    expect(eventsByProvider.claude!.every((event) => event.basisMs === S)).toBe(true);
  });

  it("stamps nothing when the cycle could not be read", async () => {
    await storeOk(report({}), NOW, 70, null);
    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    expect(eventsByProvider.claude![0]).not.toHaveProperty("basisMs");
  });

  describe("after a restart at R", () => {
    const resets = {
      claude: {
        v: 1 as const,
        events: [
          {
            id: "r",
            atMs: R,
            kind: "restart" as const,
            cycleStartMs: S,
            before: 90,
            beforeAtMs: null,
            source: "manual" as const,
            recordedAtMs: R,
            previousOverride: null,
          },
        ],
        autoOffCycleStartMs: null,
      },
    };
    const tokensOf = async (withResets: Record<string, ProviderResets>) => {
      const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0, withResets);
      return eventsByProvider.claude!.map((event) => event.tokens);
    };

    beforeEach(async () => {
      vi.stubEnv("TOKEN_MODE", "snapshot");
      // Made after R but counted from S, the shared cycle start; then one counted from R.
      await storeOk(report({ timestamp: "2026-09-22T15:00:00Z", providers: { claude: 9000 } }), NOW, 70, {
        timeZone: "UTC",
        startMs: S,
      });
      await storeOk(report({ timestamp: "2026-09-22T16:00:00Z", providers: { claude: 300 } }), NOW, 70, {
        timeZone: "UTC",
        startMs: R,
      });
    });
    afterEach(() => vi.unstubAllEnvs());

    it("drops the snapshot reports a restart made stale", async () => {
      expect(await tokensOf(resets)).toEqual([300]);
    });

    it("keeps both without the restart", async () => {
      expect(await tokensOf({})).toEqual([9000, 300]);
    });

    it("reads a member with a damaged stamp as unstamped, which a restart does not drop", async () => {
      await getRedis().zadd(KEYS.events("claude", "Personal"), {
        score: Date.parse("2026-09-22T17:00:00Z"),
        member: JSON.stringify({ m: "linux", t: 50, ts: Date.parse("2026-09-22T17:00:00Z"), s: "yesterday" }),
      });
      const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0, resets);
      const damaged = eventsByProvider.claude!.filter((event) => event.machineId === "linux");
      expect(damaged).toHaveLength(1);
      expect(damaged[0]).not.toHaveProperty("basisMs");
      expect(eventsByProvider.claude!.map((event) => event.tokens)).toEqual([300, 50]);
    });
  });
});

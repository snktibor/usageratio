import { describe, expect, it } from "vitest";
import { MAX_MACHINES } from "@/lib/config";
import { MAX_PROVIDERS } from "@/lib/providers";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { MAX_GROUPS } from "@/lib/settings";
import { loadEvents, loadIndexes, storeReport } from "@/lib/usage-store";
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
      { machineId: "mac", groupId: "Personal", tokens: 1000, ts: Date.parse("2026-09-22T00:00:00Z"), checkpoint: true },
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

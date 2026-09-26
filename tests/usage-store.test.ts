import { describe, expect, it } from "vitest";
import { getMemoryStoreForTests } from "@/lib/redis";
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

describe("storeReport — duplicate detection", () => {
  useRedis();

  it("stores a report once; the identical retry is a duplicate that changes nothing", async () => {
    const first = await storeReport(report({}), NOW, 70, null);
    expect(first).toEqual({ duplicate: false, newGroup: true, newProviders: ["claude"], heartbeat: false });

    const second = await storeReport(report({}), NOW, 70, null);
    expect(second).toEqual({ duplicate: true, newGroup: false, newProviders: [], heartbeat: false });

    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    expect(eventsByProvider.claude).toHaveLength(1);
  });

  it("is not a duplicate when the machine, the tokens or the time differ", async () => {
    await storeReport(report({}), NOW, 70, null);
    expect((await storeReport(report({ providers: { claude: 9999 } }), NOW, 70, null)).duplicate).toBe(false);
    expect((await storeReport(report({ machineId: "other" }), NOW, 70, null)).duplicate).toBe(false);
    expect((await storeReport(report({ timestamp: "2026-09-22T11:00:00Z" }), NOW, 70, null)).duplicate).toBe(false);
  });

  it("is a duplicate only once every one of its providers' events was already stored", async () => {
    await storeReport(report({ providers: { claude: 100, deepseek: 50 } }), NOW, 70, null);
    // Claude repeats exactly, DeepSeek does not: not a duplicate overall, and both providers are already known.
    const mixed = await storeReport(report({ providers: { claude: 100, deepseek: 999 } }), NOW, 70, null);
    expect(mixed.duplicate).toBe(false);
    expect(mixed.newProviders).toEqual([]);

    const repeat = await storeReport(report({ providers: { claude: 100, deepseek: 999 } }), NOW, 70, null);
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
    expect(result).toEqual({ duplicate: false, newGroup: true, newProviders: [], heartbeat: true });

    const indexes = await loadIndexes();
    expect(indexes.groups.map((group) => group.groupId)).toEqual(["Personal"]);
    expect(indexes.providers).toEqual([]);
    expect(indexes.machines).toEqual([]);
    expect(getMemoryStoreForTests()?.keys()).toEqual(["usage:groups"]);
  });

  it("a second heartbeat of an already-known group is not a new group, and still writes nothing else", async () => {
    await storeReport(report({ providers: {} }), NOW, 70, null);
    const again = await storeReport(report({ providers: {}, machineId: "other" }), NOW, 70, null);
    expect(again).toEqual({ duplicate: false, newGroup: false, newProviders: [], heartbeat: true });
    expect(getMemoryStoreForTests()?.keys()).toEqual(["usage:groups"]);
  });

  it("a real report after a heartbeat registers its provider and machine as usual", async () => {
    await storeReport(report({ providers: {} }), NOW, 70, null);
    const real = await storeReport(report({ providers: { claude: 500 } }), NOW, 70, null);
    expect(real).toEqual({ duplicate: false, newGroup: false, newProviders: ["claude"], heartbeat: false });

    const indexes = await loadIndexes();
    expect(indexes.providers.map((provider) => provider.providerId)).toEqual(["claude"]);
    expect(indexes.machines).toHaveLength(1);
  });
});

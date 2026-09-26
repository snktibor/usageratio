import { afterEach, describe, expect, it, vi } from "vitest";
import { DEMO_GROUPS, DEMO_MACHINES, DEMO_PROVIDERS } from "@/lib/demo/dataset";
import { DEMO_STALE_MS, ensureDemoData, seedStore, wipeUsageData } from "@/lib/demo/seed";
import { getRedis } from "@/lib/redis";
import { loadIndexes, loadRawSettings } from "@/lib/usage-store";
import { useRedis } from "./helpers/redis-fixture";

const NOW = new Date("2026-09-23T12:00:00Z");

describe("seedStore", () => {
  useRedis();

  it("writes the settings, every report and the official figures through the real code paths", async () => {
    const summary = await seedStore({ now: NOW });
    expect(summary.invalid).toEqual([]);
    expect(summary.duplicates).toBe(0);
    expect(summary.stored).toBe(summary.reports);
    expect(summary.reports).toBeGreaterThan(50);

    const indexes = await loadIndexes();
    expect(indexes.groups.map((group) => group.groupId).sort()).toEqual(DEMO_GROUPS.map((g) => g.id).sort());
    expect(indexes.providers.map((provider) => provider.providerId).sort()).toEqual(
      DEMO_PROVIDERS.map((p) => p.id).sort(),
    );
    expect(new Set(indexes.machines.map((machine) => machine.machineId))).toEqual(
      new Set(DEMO_MACHINES.map((machine) => machine.id)),
    );
    expect(Object.keys(indexes.officialUsage).sort()).toEqual(["claude", "claude:fable"]);
    expect(await loadRawSettings()).not.toBeNull();
  });

  it("stores nothing new the second time: every report is already there", async () => {
    await seedStore({ now: NOW });
    const again = await seedStore({ now: NOW });
    expect(again.stored).toBe(0);
    expect(again.duplicates).toBe(again.reports);
  });

  it("writes nothing on a dry run", async () => {
    const summary = await seedStore({ now: NOW, dryRun: true });
    expect(summary.reports).toBeGreaterThan(0);
    expect(await loadRawSettings()).toBeNull();
  });

  it("wipes only the usage data, never sessions or the stored token", async () => {
    const redis = getRedis();
    await redis.set("usage:session:abc", "1");
    await redis.set("usage:api-token", "{}");
    await redis.set("usage:auth:global", "3");
    await seedStore({ now: NOW });

    const wiped = await wipeUsageData();
    expect(wiped).toBeGreaterThan(5);
    expect(await loadRawSettings()).toBeNull();
    expect((await loadIndexes()).machines).toEqual([]);
    expect(await redis.get("usage:session:abc")).toBe("1");
    expect(await redis.get("usage:api-token")).toBe("{}");
    expect(await redis.get("usage:auth:global")).toBe("3");
  });
});

describe("ensureDemoData", () => {
  useRedis();
  afterEach(() => vi.unstubAllEnvs());

  it("does nothing outside demo mode", async () => {
    vi.stubEnv("DEMO_MODE", "");
    expect(await ensureDemoData(NOW)).toBe("off");
    expect(await loadRawSettings()).toBeNull();
  });

  it("seeds once, then leaves a fresh store alone until it goes stale", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    expect(await ensureDemoData(NOW)).toBe("seeded");
    expect(await ensureDemoData(NOW)).toBe("fresh");
    expect(await ensureDemoData(new Date(NOW.getTime() + DEMO_STALE_MS - 1))).toBe("fresh");
    expect(await ensureDemoData(new Date(NOW.getTime() + DEMO_STALE_MS + 1))).toBe("seeded");
    // The machine index has one row per provider and machine; count the machines.
    const machines = new Set((await loadIndexes()).machines.map((machine) => machine.machineId));
    expect(machines.size).toBe(DEMO_MACHINES.length);
  });

  it("lets a concurrent render through while another one is seeding", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    await getRedis().set("usage:demo:seeding", "1", { ex: 60 });
    expect(await ensureDemoData(NOW)).toBe("busy");
  });
});

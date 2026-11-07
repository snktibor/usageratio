import { createTranslator } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateAlerts } from "@/lib/alerts";
import { DEFAULT_RESET } from "@/lib/config";
import type { CycleSummary } from "@/lib/history";
import { ingestReport } from "@/lib/ingest";
import { deleteMachine, moveMachine, renameOrMergeGroup } from "@/lib/manage-store";
import { getMemoryStoreForTests } from "@/lib/redis";
import { fixedTenantKeys, tenantKeys } from "@/lib/redis-keys";
import { type TenantStore, tenantStore } from "@/lib/tenant";
import { assertTenantId, DEFAULT_TENANT, isTenantId, type TenantId } from "@/lib/tenant-id";
import { createToken, listTokens } from "@/lib/tokens";
import {
  archiveCycle,
  loadEvents,
  loadHistory,
  loadIndexes,
  saveArchivedOfficial,
  saveOfficialUsage,
  saveResets,
} from "@/lib/usage-store";
import en from "@/messages/en.json";
import { useRedis } from "./helpers/redis-fixture";

vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as "Alerts" }),
}));

const OTHER = "AAAAAAAAAAAAAAAAAAAAAA" as TenantId;
const THIRD = "BBBBBBBBBBBBBBBBBBBBBB" as TenantId;

describe("tenant ids", () => {
  it("accepts `default` and 22 base64url characters, nothing else", () => {
    expect(isTenantId("default")).toBe(true);
    expect(isTenantId(OTHER)).toBe(true);
    expect(isTenantId("abcdefghijklmnopqrstu_")).toBe(true);
    for (const bad of [
      "",
      "Default",
      "abc",
      "abcdefghijklmnopqrstuv1",
      "abcdefghijklmnopqrst:u",
      "abcdefghijklmnopqrst*u",
    ]) {
      expect(isTenantId(bad)).toBe(false);
    }
  });

  it("never builds a key from anything else", () => {
    expect(() => tenantKeys("x:usage:settings" as TenantId)).toThrow("invalid tenant id");
    expect(() => assertTenantId("")).toThrow("invalid tenant id");
  });
});

describe("tenantKeys", () => {
  it("keeps the default tenant on the key names a single-tenant instance always had", () => {
    const keys = tenantKeys(DEFAULT_TENANT);
    expect(keys.prefix).toBe("usage:");
    expect([
      keys.settings,
      keys.providers,
      keys.groups,
      keys.machines,
      keys.officialUsage,
      keys.resets,
      keys.events("claude", "Work"),
      keys.history("claude"),
      keys.allTime("claude"),
      keys.apiToken,
      keys.apiTokenAudit,
      keys.housekeepingLast,
      keys.tokens,
      keys.alert("claude", 1000, 80),
    ]).toEqual([
      "usage:settings",
      "usage:providers",
      "usage:groups",
      "usage:machines",
      "usage:official",
      "usage:resets",
      "usage:events:claude:Work",
      "usage:history:claude",
      "usage:alltime:claude",
      "usage:api-token",
      "usage:api-token:audit",
      "usage:housekeeping:last",
      "usage:tokens",
      "usage:alert:claude:1000:80",
    ]);
  });

  it("puts every other tenant behind its own prefix", () => {
    const keys = tenantKeys(OTHER);
    expect(keys.prefix).toBe(`t:${OTHER}:usage:`);
    expect(keys.settings).toBe(`t:${OTHER}:usage:settings`);
    expect(keys.events("claude", "Work")).toBe(`t:${OTHER}:usage:events:claude:Work`);
    expect(keys.registry).toBe(`t:${OTHER}:usage:keys`);
    for (const key of fixedTenantKeys(keys)) expect(key.startsWith(keys.prefix)).toBe(true);
  });
});

const NOW = new Date("2026-09-23T12:00:00Z");
const CYCLE_START_MS = Date.parse("2026-09-21T00:00:00Z");

async function ingest(store: TenantStore, body: Record<string, unknown>, now = NOW) {
  const result = await ingestReport(
    store,
    { machineId: "mac", groupId: "Personal", providers: { claude: 100 }, timestamp: now.toISOString(), ...body },
    now,
  );
  if (!result.ok) throw new Error("errors" in result ? result.errors.join("; ") : JSON.stringify(result));
  return result;
}

function summary(startMs: number): CycleSummary {
  return {
    v: 1,
    start: startMs,
    end: startMs + 7 * 86_400_000,
    total: 1234,
    limit: null,
    official: null,
    groups: { Personal: 1234 },
    machines: 1,
    models: {},
    subLimits: {},
    archivedAt: startMs + 7 * 86_400_000,
  };
}

/** Everything a tenant can write through lib/: reports, moves, merges, history, official figures, resets, tokens, an alert. */
async function exerciseEverything(store: TenantStore, marker: string): Promise<void> {
  await ingest(store, {
    machineId: `${marker}-mac`,
    groupId: `${marker}-group`,
    providers: { claude: 100, openai: 50 },
  });
  await ingest(store, { machineId: `${marker}-pc`, groupId: "Personal", providers: { claude: 70 } });
  await ingest(store, { machineId: `${marker}-box`, groupId: "Work", providers: { claude: 30 } });
  const moved = await moveMachine(
    store,
    "claude",
    `${marker}-pc`,
    { machineId: `${marker}-pc2`, groupId: "Work" },
    {
      merge: false,
      mode: "snapshot",
      reset: DEFAULT_RESET,
      retentionDays: 70,
      now: NOW,
    },
  );
  expect(moved).toMatchObject({ ok: true });
  expect(await renameOrMergeGroup(store, "Work", `${marker}-team`, false, NOW)).toMatchObject({ ok: true });
  expect(await archiveCycle(store, "claude", summary(CYCLE_START_MS - 7 * 86_400_000))).toBe(true);
  expect(await saveArchivedOfficial(store, "claude", CYCLE_START_MS - 7 * 86_400_000, 42)).toBe(true);
  await saveOfficialUsage(
    store,
    { providerId: "claude", subLimitId: null, raw: "40", cycleStartMs: CYCLE_START_MS },
    NOW,
  );
  await saveResets(store, "claude", { v: 1, events: [], autoOffCycleStartMs: CYCLE_START_MS });
  expect((await createToken(store, `${marker} token`, null, NOW)).ok).toBe(true);

  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  await evaluateAlerts(store, {
    providerId: "claude",
    label: "Claude",
    usedFraction: 0.9,
    cycle: { startMs: CYCLE_START_MS, endMs: CYCLE_START_MS + 7 * 86_400_000, timeZone: "UTC" },
    settings: {
      webhookUrl: `https://hooks.example.com/${marker}`,
      thresholds: [80],
      perProvider: true,
      format: "generic",
      locale: "en",
    },
    now: NOW,
  });
}

describe("a tenant's keys", () => {
  useRedis();
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("all sit under its prefix, and every one is a fixed key or in its registry", async () => {
    const memory = getMemoryStoreForTests();
    if (!memory) return; // the registry check reads the memory store's own key list
    const store = tenantStore(OTHER);
    await exerciseEverything(store, "b");

    const keys = memory.keys();
    expect(keys.length).toBeGreaterThan(5);
    expect(keys.filter((key) => !key.startsWith(store.keys.prefix))).toEqual([]);

    const registry = new Set(memory.dump()[store.keys.registry]?.value as string[]);
    const fixed = new Set(fixedTenantKeys(store.keys));
    expect(keys.filter((key) => !fixed.has(key) && !registry.has(key))).toEqual([]);
    // Spot checks: the dynamic keys of each writer are registered.
    expect(registry).toContain(store.keys.events("claude", "b-group"));
    expect(registry).toContain(store.keys.events("claude", "b-team"));
    expect(registry).toContain(store.keys.history("claude"));
    expect(registry).toContain(store.keys.allTime("claude"));
    expect(registry).toContain(store.keys.alert("claude", CYCLE_START_MS, 80));
  });

  it("are invisible to every other tenant, and untouched by its writes", async () => {
    const memory = getMemoryStoreForTests();
    if (!memory) return;
    const a = tenantStore(DEFAULT_TENANT);
    const b = tenantStore(OTHER);
    await exerciseEverything(a, "a");
    const before = JSON.stringify(memory.dump());

    await exerciseEverything(b, "b");
    expect(await deleteMachine(b, "claude", "a-mac")).toEqual({ ok: false, reason: "not_found" });

    // A's keys are byte for byte what they were before B wrote anything.
    const after = memory.dump();
    const aOnly = Object.fromEntries(Object.entries(after).filter(([key]) => !key.startsWith(b.keys.prefix)));
    expect(JSON.stringify(aOnly)).toBe(before);

    // Neither sees the other's machines, groups, events, history or tokens.
    for (const [store, own, foreign] of [
      [a, "a", "b"],
      [b, "b", "a"],
    ] as const) {
      const indexes = await loadIndexes(store);
      const text = JSON.stringify([
        indexes,
        await loadEvents(store, ["claude", "openai"], indexes.groups, 0),
        await loadHistory(store, ["claude"]),
        await listTokens(store),
      ]);
      expect(text).toContain(`${own}-mac`);
      expect(text).not.toContain(`${foreign}-`);
    }

    // A third tenant starts empty.
    const empty = await loadIndexes(tenantStore(THIRD));
    expect(empty.machines).toEqual([]);
    expect(empty.groups).toEqual([]);
  });
});

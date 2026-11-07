import { describe, expect, it } from "vitest";
import { ingestReport } from "@/lib/ingest";
import { migrateToTenants, planTenantMigration } from "@/lib/migrate-tenant";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";
import { parseTenantRecord } from "@/lib/tenants";
import { createToken, hashToken } from "@/lib/tokens";
import { archiveCycle } from "@/lib/usage-store";
import { useRedis } from "./helpers/redis-fixture";
import { KEYS, tenant } from "./helpers/tenant";

const NOW = new Date("2026-09-23T12:00:00Z");

/** A store as an older single-tenant build left it: no token index, no registry, no tenant record. */
async function seedPreTenantStore(): Promise<string> {
  const result = await ingestReport(
    tenant,
    { machineId: "mac", groupId: "Work", providers: { claude: 100 }, timestamp: NOW.toISOString() },
    NOW,
  );
  if (!result.ok) throw new Error("unreachable");
  await archiveCycle(tenant, "claude", {
    v: 1,
    start: NOW.getTime() - 14 * 86_400_000,
    end: NOW.getTime() - 7 * 86_400_000,
    total: 1,
    limit: null,
    official: null,
    groups: {},
    machines: 0,
    models: {},
    subLimits: {},
    archivedAt: NOW.getTime(),
  });
  await getRedis().set(KEYS.alert("claude", NOW.getTime(), 80), "1", { ex: 3600 });
  const created = await createToken(tenant, "laptop", null, NOW);
  if (!created.ok) throw new Error("unreachable");
  await getRedis().del(GLOBAL_KEYS.tokenIndex, KEYS.registry);
  return created.token;
}

describe("migrate:tenant", () => {
  useRedis();

  it("plans the tenant record, the token index and the registry, and a dry run writes nothing", async () => {
    await seedPreTenantStore();
    const before = getMemoryStoreForTests()?.dump();

    const { plan, applied } = await migrateToTenants({ apply: false, now: NOW });
    expect(applied).toBe(false);
    expect(plan.createTenantRecord).toBe(true);
    expect(plan.tokensToIndex).toHaveLength(1);
    expect(plan.keysToRegister).toEqual(
      [
        KEYS.alert("claude", NOW.getTime(), 80),
        KEYS.allTime("claude"),
        KEYS.events("claude", "Work"),
        KEYS.history("claude"),
      ].sort(),
    );
    if (before) expect(getMemoryStoreForTests()?.dump()).toEqual(before);
  });

  it("applies it without moving or deleting anything, and a second run finds nothing to do", async () => {
    const token = await seedPreTenantStore();
    const keysBefore = getMemoryStoreForTests()?.keys();

    await migrateToTenants({ apply: true, now: NOW });

    const record = parseTenantRecord(await getRedis().get(GLOBAL_KEYS.tenantRecord(DEFAULT_TENANT)));
    expect(record).toEqual({ v: 1, name: "Default", createdAt: NOW.getTime(), status: "active" });
    expect(await getRedis().hget(GLOBAL_KEYS.tokenIndex, hashToken(token))).toBe(DEFAULT_TENANT);
    expect(((await getRedis().smembers(KEYS.registry)) as string[]).sort()).toEqual(
      [
        KEYS.alert("claude", NOW.getTime(), 80),
        KEYS.allTime("claude"),
        KEYS.events("claude", "Work"),
        KEYS.history("claude"),
      ].sort(),
    );
    // Every key that was there is still there; only the three new ones were added.
    if (keysBefore) {
      const after = getMemoryStoreForTests()!.keys();
      expect(after.filter((key) => !keysBefore.includes(key)).sort()).toEqual(
        [GLOBAL_KEYS.tenantRecord(DEFAULT_TENANT), GLOBAL_KEYS.tokenIndex, KEYS.registry].sort(),
      );
      expect(keysBefore.filter((key) => !after.includes(key))).toEqual([]);
    }

    expect(await planTenantMigration()).toEqual({
      addOwner: false,
      createTenantRecord: false,
      tokensToIndex: [],
      keysToRegister: [],
    });
    const again = getMemoryStoreForTests()?.dump();
    await migrateToTenants({ apply: true, now: new Date(NOW.getTime() + 60_000) });
    if (again) expect(getMemoryStoreForTests()?.dump()).toEqual(again);
  });

  it("never re-points a token the index already has", async () => {
    const token = await seedPreTenantStore();
    const elsewhere = "BBBBBBBBBBBBBBBBBBBBBB" as TenantId;
    await getRedis().hset(GLOBAL_KEYS.tokenIndex, { [hashToken(token)]: elsewhere });
    const { plan } = await migrateToTenants({ apply: true, now: NOW });
    expect(plan.tokensToIndex).toEqual([]);
    expect(await getRedis().hget(GLOBAL_KEYS.tokenIndex, hashToken(token))).toBe(elsewhere);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { requireBearer } from "@/lib/api";
import { runScheduledHousekeeping } from "@/lib/housekeeping";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { tenantStore } from "@/lib/tenant";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";
import { listTenantIds, markHousekept, tenantsByHousekeepingAge } from "@/lib/tenants";
import { createToken, hashToken, pruneRevokedTokens, revokeToken, tokenTenant } from "@/lib/tokens";
import { useRedis } from "./helpers/redis-fixture";
import { withRequest } from "./helpers/request";

const B = "BBBBBBBBBBBBBBBBBBBBBB" as TenantId;
const C = "CCCCCCCCCCCCCCCCCCCCCC" as TenantId;
const NOW = new Date("2026-09-26T10:00:00Z");

async function indexTenants(...ids: TenantId[]): Promise<void> {
  for (const [index, id] of ids.entries()) await getRedis().zadd(GLOBAL_KEYS.tenants, { score: index + 1, member: id });
}

describe("the tenant index", () => {
  useRedis();

  it("always has the default tenant, first, and skips anything that is not a tenant id", async () => {
    expect(await listTenantIds()).toEqual([DEFAULT_TENANT]);
    await indexTenants(C, B);
    await getRedis().zadd(GLOBAL_KEYS.tenants, { score: 9, member: "not:a-tenant" });
    await getRedis().zadd(GLOBAL_KEYS.tenants, { score: 10, member: DEFAULT_TENANT });
    expect(await listTenantIds()).toEqual([DEFAULT_TENANT, C, B]);
  });

  it("orders the tenants for housekeeping: never done first, then the longest ago", async () => {
    await indexTenants(B, C);
    expect(await tenantsByHousekeepingAge()).toEqual([DEFAULT_TENANT, B, C]);
    await markHousekept(DEFAULT_TENANT, 3000);
    await markHousekept(B, 2000);
    expect(await tenantsByHousekeepingAge()).toEqual([C, B, DEFAULT_TENANT]);
    await markHousekept(C, 4000);
    expect(await tenantsByHousekeepingAge()).toEqual([B, DEFAULT_TENANT, C]);
  });
});

describe("runScheduledHousekeeping", () => {
  useRedis();

  it("housekeeps every tenant and stamps each one", async () => {
    await indexTenants(B);
    const { report, tenants } = await runScheduledHousekeeping(NOW, { dryRun: false });
    expect(tenants).toEqual({ processed: 2, failed: 0, pending: 0 });
    expect(report?.dryRun).toBe(false);
    expect(Number(await getRedis().zscore(GLOBAL_KEYS.tenantsHousekept, B))).toBe(NOW.getTime());
    expect(await getRedis().exists(tenantStore(B).keys.housekeepingLast)).toBe(1);
  });

  it("stamps nothing on a dry run", async () => {
    await indexTenants(B);
    const { tenants } = await runScheduledHousekeeping(NOW, { dryRun: true });
    expect(tenants).toEqual({ processed: 2, failed: 0, pending: 0 });
    expect(await getRedis().exists(GLOBAL_KEYS.tenantsHousekept)).toBe(0);
  });

  it("stops starting tenants once the budget is spent, leaving the rest first in line", async () => {
    await indexTenants(B, C);
    let elapsed = 0;
    const { report, tenants } = await runScheduledHousekeeping(NOW, {
      dryRun: false,
      budgetMs: 100,
      // Each check of the clock moves it on: the first two tenants start, the third does not.
      elapsedMs: () => (elapsed += 60) - 60,
    });
    expect(tenants).toEqual({ processed: 2, failed: 0, pending: 1 });
    expect(report).not.toBeNull();
    expect(await tenantsByHousekeepingAge()).toEqual([C, DEFAULT_TENANT, B]);
  });

  it("logs and skips a tenant whose housekeeping throws, and still does the others", async () => {
    const memory = getMemoryStoreForTests();
    if (!memory) return;
    await indexTenants(B);
    memory.failNext("HGETALL"); // the default tenant's first read
    const { report, tenants } = await runScheduledHousekeeping(NOW, { dryRun: false });
    expect(tenants).toEqual({ processed: 1, failed: 1, pending: 0 });
    expect(report).toBeNull();
    expect(Number(await getRedis().zscore(GLOBAL_KEYS.tenantsHousekept, B))).toBe(NOW.getTime());
    // Stamped all the same: a tenant that keeps failing goes to the back of the line, not the front.
    expect(Number(await getRedis().zscore(GLOBAL_KEYS.tenantsHousekept, DEFAULT_TENANT))).toBe(NOW.getTime());
  });

  it("forgets expired alert guards in the key registry, and only those", async () => {
    const store = tenantStore(B);
    await indexTenants(B);
    const old = NOW.getTime() - 110 * 86_400_000;
    // Set late in a month-long segment, a guard from 80 days ago may still be alive: it stays.
    const lateInSegment = NOW.getTime() - 80 * 86_400_000;
    const recent = NOW.getTime() - 10 * 86_400_000;
    await getRedis().sadd(
      store.keys.registry,
      store.keys.alert("claude", old, 80),
      store.keys.alert("claude", lateInSegment, 80),
      store.keys.alert("claude", recent, 80),
      store.keys.events("claude", "Work"),
      store.keys.history("claude"),
    );
    const { tenants } = await runScheduledHousekeeping(NOW, { dryRun: false });
    expect(tenants.processed).toBe(2);
    expect(((await getRedis().smembers(store.keys.registry)) as string[]).sort()).toEqual(
      [
        store.keys.alert("claude", lateInSegment, 80),
        store.keys.alert("claude", recent, 80),
        store.keys.events("claude", "Work"),
        store.keys.history("claude"),
      ].sort(),
    );
  });
});

describe("the token index", () => {
  useRedis();
  afterEach(() => vi.unstubAllEnvs());

  const bearer = (token: string) =>
    new Request("http://localhost/api/status", { headers: { authorization: `Bearer ${token}` } });

  it("records a new token's tenant with the token itself", async () => {
    const created = await createToken(tenantStore(B), "laptop", null, NOW);
    if (!created.ok) throw new Error("unreachable");
    expect(await tokenTenant(created.token)).toBe(B);
    expect(await tokenTenant("ur_unknown")).toBeNull();
  });

  it("gives a request the tenant of the token it carries, never another", async () => {
    vi.stubEnv("USAGE_API_TOKEN", "0123456789abcdef");
    const b = await createToken(tenantStore(B), "b laptop", null, NOW);
    const own = await createToken(tenantStore(DEFAULT_TENANT), "a laptop", null, NOW);
    if (!b.ok || !own.ok) throw new Error("unreachable");

    const asB = await withRequest(() => requireBearer(bearer(b.token)));
    expect(asB instanceof Response ? asB.status : { tokenId: asB.tokenId, tenantId: asB.store.tenantId }).toEqual({
      tokenId: b.id,
      tenantId: B,
    });
    const asDefault = await withRequest(() => requireBearer(bearer(own.token)));
    expect(asDefault instanceof Response ? asDefault.status : asDefault.store.tenantId).toBe(DEFAULT_TENANT);
    const master = await withRequest(() => requireBearer(bearer("0123456789abcdef")));
    expect(master instanceof Response ? master.status : master.store.tenantId).toBe(DEFAULT_TENANT);
  });

  it("refuses a token the index names a tenant for, but that tenant does not hold", async () => {
    vi.stubEnv("USAGE_API_TOKEN", "0123456789abcdef");
    const created = await createToken(tenantStore(DEFAULT_TENANT), "laptop", null, NOW);
    if (!created.ok) throw new Error("unreachable");
    // Pointed at the wrong tenant: the record is not there, so the token gets nowhere.
    await getRedis().hset(GLOBAL_KEYS.tokenIndex, { [hashToken(created.token)]: B });
    const response = await withRequest(() => requireBearer(bearer(created.token)));
    expect(response instanceof Response && response.status).toBe(401);
  });

  it("finds a default-tenant token issued before the index existed, and indexes it", async () => {
    vi.stubEnv("USAGE_API_TOKEN", "0123456789abcdef");
    const created = await createToken(tenantStore(DEFAULT_TENANT), "laptop", null, NOW);
    if (!created.ok) throw new Error("unreachable");
    await getRedis().hdel(GLOBAL_KEYS.tokenIndex, hashToken(created.token));

    const auth = await withRequest(() => requireBearer(bearer(created.token)));
    expect(auth instanceof Response ? auth.status : auth.store.tenantId).toBe(DEFAULT_TENANT);
    expect(await tokenTenant(created.token)).toBe(DEFAULT_TENANT);
  });

  it("forgets a long-revoked token in the index too", async () => {
    const store = tenantStore(B);
    const created = await createToken(store, "laptop", null, NOW);
    if (!created.ok) throw new Error("unreachable");
    await revokeToken(store, created.id, new Date(NOW.getTime() - 100 * 86_400_000));
    expect(await tokenTenant(created.token)).toBe(B);
    const pruned = await pruneRevokedTokens(store, NOW);
    expect(pruned.ids).toEqual([created.id]);
    expect(await tokenTenant(created.token)).toBeNull();
  });
});

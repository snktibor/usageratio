import { dynamicTenantKeyPatterns, GLOBAL_KEYS } from "@/lib/redis-keys";
import { defaultTenantStore, type TenantStore } from "@/lib/tenant";
import { parseTenantRecord, serializeTenantRecord } from "@/lib/tenants";

/**
 * Prepares a single-tenant store for more tenants (`npm run migrate:tenant`,
 * scripts/migrate-tenant.ts). The default tenant keeps its keys where they
 * are, so nothing is copied, renamed or deleted; this only adds what the
 * multi-tenant code reads besides them:
 *
 *   1. the default tenant's own record, `usage:tenant:default`;
 *   2. a `usage:tokenindex` entry for every per-machine token in
 *      `usage:tokens` (HSETNX: an entry already there is never changed);
 *   3. the default tenant's key registry, `usage:keys`, backfilled with every
 *      dynamic key it already has (a one-off SCAN: the only one there is).
 *
 * A dry run (the default) reports what it would add; `apply` adds it. Running
 * it again finds nothing left to add. A single-tenant instance never needs it:
 * the request path indexes an old token on its first use, and new keys are
 * registered as they are written.
 */

export interface TenantMigrationPlan {
  /** Whether the default tenant's record is missing. */
  createTenantRecord: boolean;
  /** Token hashes in `usage:tokens` that the token index does not have. */
  tokensToIndex: string[];
  /** Dynamic keys the registry does not name yet. */
  keysToRegister: string[];
}

async function scanKeys(store: TenantStore, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const page = (await store.redis.scan(cursor, { match: pattern, count: 500 })) as [string | number, string[]];
    cursor = String(page[0]);
    keys.push(...page[1].map(String));
  } while (cursor !== "0");
  return keys;
}

export async function planTenantMigration(store: TenantStore = defaultTenantStore()): Promise<TenantMigrationPlan> {
  const redis = store.redis;
  const [record, tokenFields, indexFields, registered] = await Promise.all([
    redis.get(GLOBAL_KEYS.tenantRecord(store.tenantId)),
    redis.hkeys(store.keys.tokens),
    redis.hkeys(GLOBAL_KEYS.tokenIndex),
    redis.smembers(store.keys.registry),
  ]);
  const indexed = new Set((indexFields as unknown[]).map(String));
  const inRegistry = new Set((registered as unknown[]).map(String));
  const dynamic = (
    await Promise.all(dynamicTenantKeyPatterns(store.keys).map((pattern) => scanKeys(store, pattern)))
  ).flat();
  return {
    createTenantRecord: parseTenantRecord(record) === null,
    tokensToIndex: (tokenFields as unknown[]).map(String).filter((hash) => !indexed.has(hash)),
    keysToRegister: [...new Set(dynamic)].filter((key) => !inRegistry.has(key)).sort(),
  };
}

export async function migrateToTenants(options: {
  apply: boolean;
  now: Date;
  store?: TenantStore;
}): Promise<{ plan: TenantMigrationPlan; applied: boolean }> {
  const store = options.store ?? defaultTenantStore();
  const plan = await planTenantMigration(store);
  if (!options.apply) return { plan, applied: false };

  const tx = store.redis.multi();
  let writes = 0;
  if (plan.createTenantRecord) {
    const record = serializeTenantRecord({ v: 1, name: "Default", createdAt: options.now.getTime(), status: "active" });
    tx.set(GLOBAL_KEYS.tenantRecord(store.tenantId), record);
    writes += 1;
  }
  for (const hash of plan.tokensToIndex) {
    tx.hsetnx(GLOBAL_KEYS.tokenIndex, hash, store.tenantId);
    writes += 1;
  }
  const [first, ...rest] = plan.keysToRegister;
  if (first !== undefined) {
    tx.sadd(store.keys.registry, first, ...rest);
    writes += 1;
  }
  if (writes > 0) await tx.exec();
  return { plan, applied: true };
}

import { getRedis, toStringRecord } from "@/lib/redis";
import { fixedTenantKeys, GLOBAL_KEYS } from "@/lib/redis-keys";
import { type TenantStore, tenantStore } from "@/lib/tenant";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";
import { loadTenantRecord, setTenantStatus } from "@/lib/tenants";

/**
 * Deletes a tenant and everything of it, for good: its own keys (the fixed
 * ones and every name in its key registry, so no SCAN is needed), its tokens'
 * entries in the global token index, its members' links to it, its places in
 * the tenant indexes, and last its record. The record is marked "deleting"
 * first, so nothing can be read or reported meanwhile; every step can run
 * again, so a deletion that was cut short is simply run again to finish.
 * The default tenant, where a single-user instance keeps its data, is never
 * deleted here.
 */

const BATCH = 100;

export type DeleteTenantResult = { ok: true; keysDeleted: number } | { ok: false; reason: "default_tenant" };

export async function deleteTenant(tenantId: TenantId, now: Date): Promise<DeleteTenantResult> {
  if (tenantId === DEFAULT_TENANT) return { ok: false, reason: "default_tenant" };
  const redis = getRedis();
  const store = tenantStore(tenantId);
  if (await loadTenantRecord(tenantId)) await setTenantStatus(tenantId, "deleting", now);

  // The token index first, while the tenant's own tokens hash still names its fields.
  const tokenHashes = ((await redis.hkeys(store.keys.tokens)) as unknown[]).map(String);
  for (let i = 0; i < tokenHashes.length; i += BATCH) {
    await redis.hdel(GLOBAL_KEYS.tokenIndex, ...(tokenHashes.slice(i, i + BATCH) as [string, ...string[]]));
  }

  const firstPass = await deleteOwnKeys(store);

  // The members' side of each membership, then the tenant's own.
  const members = Object.keys(toStringRecord(await redis.hgetall(GLOBAL_KEYS.tenantMembers(tenantId))));
  const tx = redis.multi();
  for (const userId of members) tx.hdel(GLOBAL_KEYS.userTenants(userId), tenantId);
  tx.del(GLOBAL_KEYS.tenantMembers(tenantId));
  tx.zrem(GLOBAL_KEYS.tenants, tenantId);
  tx.zrem(GLOBAL_KEYS.tenantsHousekept, tenantId);
  tx.del(GLOBAL_KEYS.tenantRecord(tenantId));
  await tx.exec();

  // A second pass: a request that was already past its checks when the deletion began (a report
  // being stored, a token's lastUsedAt) may have written one of the tenant's keys since. Nothing
  // can now: without its record, no session or token gets into the tenant.
  const secondPass = await deleteOwnKeys(store);
  return { ok: true, keysDeleted: firstPass + secondPass };
}

/** Deletes every key the tenant owns: its fixed keys and every name in its registry (read first). */
async function deleteOwnKeys(store: TenantStore): Promise<number> {
  const redis = getRedis();
  const registered = ((await redis.smembers(store.keys.registry)) as unknown[]).map(String);
  const keys = [
    ...new Set([...registered.filter((key) => key.startsWith(store.keys.prefix)), ...fixedTenantKeys(store.keys)]),
  ];
  let deleted = 0;
  for (let i = 0; i < keys.length; i += BATCH) {
    deleted += Number(await redis.del(...(keys.slice(i, i + BATCH) as [string, ...string[]])));
  }
  return deleted;
}

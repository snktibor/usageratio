import { getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { DEFAULT_TENANT, isTenantId, type TenantId } from "@/lib/tenant-id";

/**
 * The instance's tenant index (see "Global keys" in lib/redis-keys.ts): which
 * tenants exist, each one's own record, and the order the daily housekeeping
 * takes them in. The `default` tenant always exists, indexed or not, so a
 * single-tenant instance needs none of these keys.
 */

export interface TenantRecord {
  v: 1;
  /** The workspace's display name: shown to its members only, never used as a key. */
  name: string;
  createdAt: number;
  status: "active";
}

export function serializeTenantRecord(record: TenantRecord): string {
  return JSON.stringify(record);
}

/** The stored record, or null when it is missing or does not parse. */
export function parseTenantRecord(raw: unknown): TenantRecord | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<TenantRecord>;
    if (value?.v !== 1 || typeof value.name !== "string" || typeof value.createdAt !== "number") return null;
    return { v: 1, name: value.name, createdAt: value.createdAt, status: "active" };
  } catch {
    return null;
  }
}

/** A flat `[member, score, member, score, …]` ZRANGE WITHSCORES reply, as members with numeric scores. */
function pairs(raw: unknown): { member: string; score: number }[] {
  const flat = Array.isArray(raw) ? raw : [];
  const result: { member: string; score: number }[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) result.push({ member: String(flat[i]), score: Number(flat[i + 1]) });
  return result;
}

/** Every tenant: `default` first, then the indexed ones in the order they were created. Anything that is not a tenant id is skipped. */
export async function listTenantIds(): Promise<TenantId[]> {
  const indexed = (await getRedis().zrange(GLOBAL_KEYS.tenants, 0, -1)) as unknown[];
  const ids = indexed.map(String).filter((id): id is TenantId => isTenantId(id) && id !== DEFAULT_TENANT);
  return [DEFAULT_TENANT, ...ids];
}

/**
 * Every tenant in the order the daily housekeeping should take them: never
 * housekept first (in `listTenantIds` order), then the longest ago.
 */
export async function tenantsByHousekeepingAge(): Promise<TenantId[]> {
  const [ids, raw] = await Promise.all([
    listTenantIds(),
    getRedis().zrange(GLOBAL_KEYS.tenantsHousekept, 0, -1, { withScores: true }),
  ]);
  const lastRun = new Map(pairs(raw).map(({ member, score }) => [member, score]));
  const never = ids.filter((id) => !lastRun.has(id));
  const seen = ids.filter((id) => lastRun.has(id)).sort((a, b) => lastRun.get(a)! - lastRun.get(b)!);
  return [...never, ...seen];
}

/** Stamps `tenantId`'s housekeeping as done at `atMs`. */
export async function markHousekept(tenantId: TenantId, atMs: number): Promise<void> {
  await getRedis().zadd(GLOBAL_KEYS.tenantsHousekept, { score: atMs, member: tenantId });
}

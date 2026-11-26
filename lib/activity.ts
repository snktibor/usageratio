import { getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { isMultiTenant } from "@/lib/registration";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";

/**
 * The durable activity markers lib/inactive-purge.ts decides by (multi-tenant
 * mode): a tenant's last client request (`usage:tenants:active`) and a user's
 * last sign-in or dashboard day (`usage:users`, also the index of every user).
 * Both are written next to a write that already happens, at most once a UTC
 * day, so the report path costs no extra read and at most one extra command a
 * day per token.
 */

const DAY_MS = 86_400_000;

/** Whether `a` and `b` (epoch ms) fall on different UTC days: the "first time today" test of both markers. */
export function otherUtcDay(a: number, b: number): boolean {
  return Math.floor(a / DAY_MS) !== Math.floor(b / DAY_MS);
}

/**
 * Stamps a client request of `tenantId`'s. Neither the default tenant, which is never deleted, nor
 * anything on a single-user instance, which deletes nothing, is tracked.
 */
export async function recordTenantActivity(tenantId: TenantId, atMs: number): Promise<void> {
  if (tenantId === DEFAULT_TENANT || !isMultiTenant()) return;
  await getRedis().zadd(GLOBAL_KEYS.tenantsActive, { score: atMs, member: tenantId });
}

/** Stamps a sign-in or a dashboard day of `userId`'s. */
export async function recordUserActivity(userId: string, atMs: number): Promise<void> {
  await getRedis().zadd(GLOBAL_KEYS.users, { score: atMs, member: userId });
}

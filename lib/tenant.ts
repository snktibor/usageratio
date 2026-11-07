import type { Redis } from "@upstash/redis";
import { getRedis } from "@/lib/redis";
import { type TenantKeys, tenantKeys } from "@/lib/redis-keys";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";

/**
 * The tenant-bound store: the only way to a tenant's data. Every lib/ function
 * that reads or writes a tenant's keys takes one as its first argument and
 * uses `store.keys` and `store.redis`; nothing else builds a tenant key.
 *
 * Who may make one (tests/redis-key-literals.test.ts enforces the list): the
 * request guards that work the tenant out from a session or a bearer token
 * (lib/tenant-context.ts), jobs that walk every tenant (housekeeping, the demo
 * seed, migrations), and tests.
 */
export interface TenantStore {
  readonly tenantId: TenantId;
  readonly keys: TenantKeys;
  /** The shared client (lib/redis.ts), looked up on every use so a test can swap it. */
  readonly redis: Redis;
}

export function tenantStore(tenantId: TenantId): TenantStore {
  const keys = tenantKeys(tenantId);
  return {
    tenantId,
    keys,
    get redis() {
      return getRedis();
    },
  };
}

/** The single-tenant instance's store: the `default` tenant, whose keys are today's `usage:` names. */
export function defaultTenantStore(): TenantStore {
  return tenantStore(DEFAULT_TENANT);
}

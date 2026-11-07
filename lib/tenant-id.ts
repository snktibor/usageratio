/**
 * Tenant ids. A tenant is one isolated dataset (a "workspace" in the UI); its
 * id decides the prefix of every key it owns (lib/redis-keys.ts
 * `tenantKeys`). An id is never taken from a request: the server works it out
 * from the session or the bearer token (lib/tenant-context.ts).
 *
 * `default` is the tenant a single-user instance has always had: its keys keep
 * the bare `usage:` names. Any other id is 22 base64url characters (128
 * random bits), so it can never be mistaken for `default`.
 */

declare const tenantIdBrand: unique symbol;

/** A tenant id the server has vouched for. A plain string from a request does not type-check as one. */
export type TenantId = string & { readonly [tenantIdBrand]: true };

export const DEFAULT_TENANT = "default" as TenantId;

const GENERATED_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function isTenantId(value: string): value is TenantId {
  return value === DEFAULT_TENANT || GENERATED_ID_PATTERN.test(value);
}

/** Throws on anything that is not a tenant id: a key is never built from one that could carry a `:`. */
export function assertTenantId(value: string): asserts value is TenantId {
  if (!isTenantId(value)) throw new Error("invalid tenant id");
}

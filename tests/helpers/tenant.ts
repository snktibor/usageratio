import { tenantStore } from "@/lib/tenant";
import { DEFAULT_TENANT } from "@/lib/tenant-id";

/** The single-tenant instance's store, as every test that is not about tenants uses it. */
export const tenant = tenantStore(DEFAULT_TENANT);

/** Its key names: the bare `usage:` ones. */
export const KEYS = tenant.keys;

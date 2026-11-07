import { isAuthenticated } from "@/lib/auth";
import { defaultTenantStore, type TenantStore } from "@/lib/tenant";

/**
 * Who is asking, and for which tenant: what a page or a route handler gets
 * once the request has proven itself. The tenant is always worked out on the
 * server, from the session (here) or the bearer token (lib/api.ts
 * `requireBearer`); nothing the client sends ever chooses it.
 *
 * A single-tenant instance has one tenant, `default`, and its PIN session is
 * its owner.
 */
export interface TenantContext {
  store: TenantStore;
  role: "owner";
}

/** The signed-in browser's tenant; null without a live session. Throws when the store cannot be asked. */
export async function currentTenant(): Promise<TenantContext | null> {
  if (!(await isAuthenticated())) return null;
  return { store: defaultTenantStore(), role: "owner" };
}

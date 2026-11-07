import { isAuthenticated } from "@/lib/auth";
import { getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { isMultiTenant } from "@/lib/registration";
import { defaultTenantStore, type TenantStore, tenantStore } from "@/lib/tenant";
import { parseTenantRecord } from "@/lib/tenants";
import { currentUserSession } from "@/lib/user-session";
import { parseRole, type Role } from "@/lib/users";

/**
 * Who is asking, and for which tenant: what a page or a route handler gets
 * once the request has proven itself. The tenant is always worked out on the
 * server, from the session (here) or the bearer token (lib/api.ts
 * `requireBearer`); nothing the client sends ever chooses it.
 *
 * A single-user instance (REGISTRATION=closed) has one tenant, `default`, and
 * its PIN session is its owner. In multi-tenant mode the session names a user
 * and the tenant they are looking at, and every request re-reads that
 * tenant's members hash and record: a member removed a moment ago, or a
 * tenant that is gone, gets nothing.
 */
export interface TenantContext {
  store: TenantStore;
  role: Role;
  /** The signed-in user; null on a single-user instance, where the PIN stands for its one owner. */
  userId: string | null;
}

/** The signed-in browser's tenant; null without a live session or membership. Throws when the store cannot be asked. */
export async function currentTenant(): Promise<TenantContext | null> {
  if (!isMultiTenant()) {
    if (!(await isAuthenticated())) return null;
    return { store: defaultTenantStore(), role: "owner", userId: null };
  }
  const session = await currentUserSession();
  if (!session?.tenantId) return null;
  const reads = getRedis().pipeline();
  reads.hget(GLOBAL_KEYS.tenantMembers(session.tenantId), session.userId);
  reads.get(GLOBAL_KEYS.tenantRecord(session.tenantId));
  const [member, record] = await reads.exec();
  const role = parseRole(member);
  if (!role || !parseTenantRecord(record)) return null;
  return { store: tenantStore(session.tenantId), role, userId: session.userId };
}

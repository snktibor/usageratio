import { getRedis, toStringRecord } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { listTenantIds, loadTenantRecord, type TenantStatus } from "@/lib/tenants";
import { loadUser, parseRole } from "@/lib/users";

/**
 * The instance admin (multi-tenant mode): the GitHub accounts listed by their
 * numeric ids in ADMIN_GITHUB_IDS. An admin sees how many tenants and users
 * there are and how much each tenant uses, can disable a tenant and issue
 * sign-up codes; an admin never sees a tenant's data. Only counts leave
 * `adminOverview`: no machine, group or provider names, no usage figures, no
 * settings, no workspace names (those are the tenant's own).
 */

/** The admin accounts' numeric GitHub ids, from ADMIN_GITHUB_IDS ("123, 456"); anything else is ignored. */
export function adminGithubIds(env: Record<string, string | undefined> = process.env): Set<number> {
  const ids = new Set<number>();
  for (const part of (env.ADMIN_GITHUB_IDS ?? "").split(",")) {
    const id = Number(part.trim());
    if (part.trim() !== "" && Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return ids;
}

/** Whether `userId` signs in with one of the admin accounts. */
export async function isInstanceAdmin(userId: string): Promise<boolean> {
  const admins = adminGithubIds();
  if (admins.size === 0) return false;
  const identities = ((await getRedis().smembers(GLOBAL_KEYS.userIdentities(userId))) as unknown[]).map(String);
  return identities.some((identity) => identity.startsWith("github:") && admins.has(Number(identity.slice(7))));
}

export interface AdminTenantRow {
  tenantId: TenantId;
  createdAt: number | null;
  status: TenantStatus;
  /** The owners' GitHub logins: account data, so the admin can tell whose tenant to disable. */
  owners: string[];
  members: number;
  machines: number;
  providers: number;
  tokens: number;
  /** The latest report of any of its machines (ms); null before the first. */
  lastReportAt: number | null;
  /** How many dynamic keys it has (its key registry's size): a rough measure of its footprint. */
  keys: number;
}

export interface AdminOverview {
  /** Users who belong to at least one workspace (there is no index of the others). */
  usersWithWorkspace: number;
  tenants: { total: number; active: number; disabled: number };
  rows: AdminTenantRow[];
}

/** The latest `ts` among a machines hash's values, without passing a single machine name on. */
function latestReport(machines: Record<string, string>): number | null {
  let latest: number | null = null;
  for (const value of Object.values(machines)) {
    try {
      const ts = Number((JSON.parse(value) as { ts?: unknown }).ts);
      if (Number.isFinite(ts) && (latest === null || ts > latest)) latest = ts;
    } catch {
      // An unreadable entry has no time to offer.
    }
  }
  return latest;
}

export async function adminOverview(): Promise<AdminOverview> {
  const redis = getRedis();
  const memberIds = new Set<string>();
  const rows = await Promise.all(
    (await listTenantIds()).map(async (tenantId): Promise<AdminTenantRow> => {
      const store = tenantStore(tenantId);
      const [record, membersRaw, machinesRaw, providers, tokens, keys] = await Promise.all([
        loadTenantRecord(tenantId),
        redis.hgetall(GLOBAL_KEYS.tenantMembers(tenantId)),
        redis.hgetall(store.keys.machines),
        redis.hlen(store.keys.providers),
        redis.hlen(store.keys.tokens),
        redis.scard(store.keys.registry),
      ]);
      const members = toStringRecord(membersRaw);
      for (const userId of Object.keys(members)) memberIds.add(userId);
      const ownerIds = Object.entries(members)
        .filter(([, value]) => parseRole(value) === "owner")
        .map(([userId]) => userId);
      const owners = await Promise.all(ownerIds.map(async (userId) => (await loadUser(userId))?.login || userId));
      const machines = toStringRecord(machinesRaw);
      return {
        tenantId,
        createdAt: record?.createdAt ?? null,
        status: record?.status ?? "active",
        owners: owners.sort(),
        members: Object.keys(members).length,
        machines: new Set(Object.keys(machines).map((field) => field.slice(field.indexOf(":") + 1))).size,
        providers: Number(providers),
        tokens: Number(tokens),
        lastReportAt: latestReport(machines),
        keys: Number(keys),
      };
    }),
  );
  return {
    usersWithWorkspace: memberIds.size,
    tenants: {
      total: rows.length,
      active: rows.filter((row) => row.status === "active").length,
      disabled: rows.filter((row) => row.status === "disabled").length,
    },
    rows,
  };
}

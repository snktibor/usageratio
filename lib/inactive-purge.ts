import { deleteAccount } from "@/lib/account";
import { INACTIVE_ACCOUNT_DAYS } from "@/lib/config";
import { log } from "@/lib/log";
import { getRedis, scanAll, toStringRecord } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { isMultiTenant } from "@/lib/registration";
import { deleteTenant } from "@/lib/tenant-deletion";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";
import { listTenantIds, parseTenantRecord, type TenantRecord } from "@/lib/tenants";
import { isUserId, parseRole, type Role, userTenants } from "@/lib/users";

/**
 * Storage limitation (GDPR Art. 5(1)(e)): the daily housekeeping run deletes
 * what has seen neither a sign-in nor a client request for
 * INACTIVE_ACCOUNT_DAYS (lib/config.ts), in multi-tenant mode only. A
 * single-user instance has nothing to delete: it is one person's own data.
 *
 * Activity is the two durable markers of lib/activity.ts: a tenant's last
 * client request (`usage:tenants:active`) and a user's last sign-in or
 * dashboard day (`usage:users`, which also indexes every user, with a
 * workspace or without). A tenant or user without a marker counts as active
 * when tracking began (`usage:activity:since`, the first cron run of this
 * build), so data from before is never deleted early.
 *
 * The rules:
 * - a workspace goes when its machines have been silent that long (a newly
 *   created one counts from its creation) and every member, owner included,
 *   has not signed in that long either: an active member never loses it;
 * - a disabled workspace (switched off by an instance admin, so nobody can use
 *   it) goes when its last request and its disabling are both that old,
 *   whatever its members do;
 * - an account goes when it has not signed in that long and owns no
 *   workspace that stays: an owner whose machines still report is active
 *   through them. It leaves the workspaces it is only a member of
 *   (lib/account.ts `deleteAccount`), their machines and tokens staying;
 * - the default tenant, and anyone who belongs to it, are never touched.
 */

const DAY_MS = 86_400_000;

export interface PurgeTenant {
  tenantId: TenantId;
  record: TenantRecord | null;
  /** The `usage:tenants:active` marker; null when there is none. */
  reportedAt: number | null;
  members: { userId: string; role: Role }[];
}

export interface PurgeInput {
  /** Anything last active at or before this goes. */
  cutoffMs: number;
  /** When tracking began: the activity of whatever has no marker. */
  sinceMs: number;
  tenants: PurgeTenant[];
  /** The users index: userId → last sign-in or dashboard day. */
  users: Map<string, number>;
}

export interface PurgePlan {
  tenants: TenantId[];
  users: string[];
}

function tenantActivityMs(tenant: PurgeTenant, sinceMs: number): number {
  const record = tenant.record;
  const disabledAt = record?.status === "disabled" ? (record.statusAt ?? 0) : 0;
  return Math.max(tenant.reportedAt ?? sinceMs, record?.createdAt ?? 0, disabledAt);
}

/** What goes, by the rules above. Pure: the cron run loads its input and carries it out. */
export function planInactivePurge(input: PurgeInput): PurgePlan {
  const { cutoffMs, sinceMs, users } = input;
  const userInactive = (userId: string) => (users.get(userId) ?? sinceMs) <= cutoffMs;

  const tenants = input.tenants
    .filter((tenant) => {
      if (tenant.tenantId === DEFAULT_TENANT || tenant.record?.status === "deleting") return false;
      if (tenantActivityMs(tenant, sinceMs) > cutoffMs) return false;
      return tenant.record?.status === "disabled" || tenant.members.every((member) => userInactive(member.userId));
    })
    .map((tenant) => tenant.tenantId);
  const going = new Set<TenantId>(tenants);

  const memberships = new Map<string, { tenantId: TenantId; role: Role }[]>();
  for (const tenant of input.tenants) {
    for (const { userId, role } of tenant.members) {
      memberships.set(userId, [...(memberships.get(userId) ?? []), { tenantId: tenant.tenantId, role }]);
    }
  }
  const accounts = [...users.keys()].filter(
    (userId) =>
      userInactive(userId) &&
      (memberships.get(userId) ?? []).every(
        ({ tenantId, role }) => tenantId !== DEFAULT_TENANT && (role !== "owner" || going.has(tenantId)),
      ),
  );
  return { tenants, users: accounts };
}

export interface InactivePurgeSummary {
  tenantsDeleted: number;
  usersDeleted: number;
  /** Planned, but found active again (or refused) at the moment of deleting. */
  skipped: number;
  /** Planned, left for the next run because the time budget ran out. */
  pending: number;
}

/** A flat ZRANGE WITHSCORES reply as a map. */
function scores(raw: unknown): Map<string, number> {
  const flat = Array.isArray(raw) ? raw : [];
  const map = new Map<string, number>();
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const score = Number(flat[i + 1]);
    if (Number.isFinite(score)) map.set(String(flat[i]), score);
  }
  return map;
}

/**
 * When tracking began. The first real run starts it: every user there already is joins the index
 * as active now (one SCAN of `usage:user:*`, the only way to reach a user without a workspace,
 * done once), so their months count from here. A dry run before that starts nothing: null.
 */
async function trackingSince(now: Date, dryRun: boolean): Promise<number | null> {
  const redis = getRedis();
  const raw = await redis.get(GLOBAL_KEYS.activitySince);
  if (raw !== null && raw !== undefined && Number.isFinite(Number(raw))) return Number(raw);
  if (dryRun) return null;
  const prefix = GLOBAL_KEYS.user("");
  const userIds = (await scanAll(redis, GLOBAL_KEYS.userPattern))
    .map((key) => key.slice(prefix.length))
    .filter(isUserId);
  const tx = redis.multi();
  for (const userId of userIds) tx.zadd(GLOBAL_KEYS.users, { nx: true }, { score: now.getTime(), member: userId });
  tx.set(GLOBAL_KEYS.activitySince, String(now.getTime()), { nx: true });
  await tx.exec();
  return now.getTime();
}

async function loadTenants(ids: TenantId[], reported: Map<string, number>): Promise<PurgeTenant[]> {
  return Promise.all(
    ids.map(async (tenantId) => {
      const reads = getRedis().pipeline();
      reads.get(GLOBAL_KEYS.tenantRecord(tenantId));
      reads.hgetall(GLOBAL_KEYS.tenantMembers(tenantId));
      const [record, members] = await reads.exec();
      return {
        tenantId,
        record: parseTenantRecord(record),
        reportedAt: reported.get(tenantId) ?? null,
        members: Object.entries(toStringRecord(members)).flatMap(([userId, value]) => {
          const role = parseRole(value);
          return role ? [{ userId, role }] : [];
        }),
      };
    }),
  );
}

/** Whether any of these markers moved past the cutoff since the plan was made (a sign-in, a report). */
async function activeAgain(key: string, members: string[], cutoffMs: number): Promise<boolean> {
  if (members.length === 0) return false;
  const reads = getRedis().pipeline();
  for (const member of members) reads.zscore(key, member);
  return ((await reads.exec()) as unknown[]).some((score) => score !== null && Number(score) > cutoffMs);
}

/**
 * The cron run's part (lib/housekeeping.ts `runScheduledHousekeeping`): plans, then deletes
 * workspaces first and accounts after, each re-checked just before, until `outOfTime`. A dry run
 * writes nothing and counts what would go. The log carries counts and opaque ids only. Null on a
 * single-user instance.
 */
export async function purgeInactive(
  now: Date,
  options: { dryRun: boolean; outOfTime: () => boolean },
): Promise<InactivePurgeSummary | null> {
  if (!isMultiTenant()) return null;
  const { dryRun, outOfTime } = options;
  const summary: InactivePurgeSummary = { tenantsDeleted: 0, usersDeleted: 0, skipped: 0, pending: 0 };
  const sinceMs = await trackingSince(now, dryRun);
  if (sinceMs === null) return summary;

  const redis = getRedis();
  const cutoffMs = now.getTime() - INACTIVE_ACCOUNT_DAYS * DAY_MS;
  const markers = redis.pipeline();
  markers.zrange(GLOBAL_KEYS.tenantsActive, 0, -1, { withScores: true });
  markers.zrange(GLOBAL_KEYS.users, 0, -1, { withScores: true });
  const [reportedRaw, usersRaw] = await markers.exec();
  const reported = scores(reportedRaw);
  const ids = await listTenantIds();
  const tenants = await loadTenants(ids, reported);
  const plan = planInactivePurge({ cutoffMs, sinceMs, tenants, users: scores(usersRaw) });

  if (dryRun) {
    log.info("housekeeping.inactive_purge", { dryRun, tenants: plan.tenants.length, users: plan.users.length });
    return { ...summary, tenantsDeleted: plan.tenants.length, usersDeleted: plan.users.length };
  }

  // A marker a racing request wrote for a tenant deleted meanwhile names nothing any more.
  const stale = [...reported.keys()].filter((id) => !(ids as string[]).includes(id));
  if (stale.length > 0) await redis.zrem(GLOBAL_KEYS.tenantsActive, ...(stale as [string, ...string[]]));

  const byId = new Map(tenants.map((tenant) => [tenant.tenantId, tenant]));
  const steps = [
    ...plan.tenants.map((tenantId) => ({ kind: "tenant" as const, id: tenantId })),
    ...plan.users.map((userId) => ({ kind: "user" as const, id: userId })),
  ];
  for (const [index, step] of steps.entries()) {
    if (outOfTime()) {
      summary.pending = steps.length - index;
      break;
    }
    if (step.kind === "tenant") {
      const tenant = byId.get(step.id as TenantId)!;
      const members = tenant.record?.status === "disabled" ? [] : tenant.members.map((member) => member.userId);
      if (
        (await activeAgain(GLOBAL_KEYS.tenantsActive, [step.id], cutoffMs)) ||
        (await activeAgain(GLOBAL_KEYS.users, members, cutoffMs)) ||
        !(await deleteTenant(step.id as TenantId, now)).ok
      ) {
        summary.skipped += 1;
        continue;
      }
      summary.tenantsDeleted += 1;
    } else {
      // Every workspace the account owned went above (deleting one drops it from the owner's list);
      // one that is still there turned active again, and the account stays with it.
      const owns = (await userTenants(step.id)).some((membership) => membership.role === "owner");
      if (owns || (await activeAgain(GLOBAL_KEYS.users, [step.id], cutoffMs))) {
        summary.skipped += 1;
        continue;
      }
      const result = await deleteAccount(step.id, now);
      if (!result.ok) {
        // An index entry whose user is already gone is just dropped; anything else waits for a later run.
        if (result.reason === "not_found") await redis.zrem(GLOBAL_KEYS.users, step.id);
        else summary.skipped += 1;
        continue;
      }
      summary.usersDeleted += 1;
    }
    log.info("housekeeping.inactive_deleted", { kind: step.kind, id: step.id });
  }
  log.info("housekeeping.inactive_purge", { dryRun, ...summary });
  return summary;
}

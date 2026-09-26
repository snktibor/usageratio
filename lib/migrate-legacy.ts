import { getRedis, toStringRecord } from "@/lib/redis";

/**
 * One-off migration of the pre-provider ("DeepSeek only") key layout into the
 * current, provider-prefixed one — see the layout comment at the top of
 * lib/usage-store.ts, which no longer reads the legacy shapes at all:
 *
 *   usage:events:{groupId}            →  usage:events:deepseek:{groupId}
 *   usage:machines  field "{machineId}"  →  field "deepseek:{machineId}"
 *
 * Run this once against a store that predates providers, with `apply: true`,
 * BEFORE deploying a build of this app that has dropped the legacy read path.
 * Safe to run again: a store with nothing legacy left just plans (and does)
 * nothing (`renamed: 0, merged: 0, machinesMoved: 0`).
 */

const GROUPS_KEY = "usage:groups";
const MACHINES_KEY = "usage:machines";
const LEGACY_PROVIDER_ID = "deepseek";

const legacyEventsKey = (groupId: string): string => `usage:events:${groupId}`;
const migratedEventsKey = (groupId: string): string => `usage:events:${LEGACY_PROVIDER_ID}:${groupId}`;

export interface EventMigrationStep {
  groupId: string;
  /**
   * "rename": no provider-prefixed set existed yet, the legacy one becomes it.
   * "merge": both existed (the provider-prefixed one from a real report, the
   * legacy one from before providers): their members are unioned, keeping the
   * larger (running-total) score of a member both share, then the legacy set
   * is dropped. "skip": no legacy set for this group, nothing to do.
   */
  action: "rename" | "merge" | "skip";
}

export interface MachineMigrationStep {
  /** The unprefixed `usage:machines` field, e.g. "mac-studio". */
  field: string;
  /** "move": a legacy field, to fold under "deepseek:". "skip": already prefixed. */
  action: "move" | "skip";
}

export interface MigrationPlan {
  events: EventMigrationStep[];
  machines: MachineMigrationStep[];
}

export interface MigrationSummary {
  renamed: number;
  merged: number;
  machinesMoved: number;
  skipped: number;
}

/** The machine hash's `{ ts, … }` field: 0 when it is missing or unreadable, so the other one wins a tie-break. */
function tsOf(raw: string | undefined): number {
  if (raw === undefined) return 0;
  try {
    const value = JSON.parse(raw) as { ts?: unknown };
    return typeof value.ts === "number" && Number.isFinite(value.ts) ? value.ts : 0;
  } catch {
    return 0;
  }
}

/** What a run would do, read fresh from the store; also what an applied run acts on. */
export async function planLegacyMigration(): Promise<MigrationPlan> {
  const redis = getRedis();
  const [rawGroups, rawMachines] = await Promise.all([redis.hgetall(GROUPS_KEY), redis.hgetall(MACHINES_KEY)]);
  const groupIds = Object.keys(toStringRecord(rawGroups));
  const machineFields = Object.keys(toStringRecord(rawMachines));

  const events: EventMigrationStep[] = [];
  for (const groupId of groupIds) {
    const hasLegacy = Number(await redis.exists(legacyEventsKey(groupId))) === 1;
    if (!hasLegacy) {
      events.push({ groupId, action: "skip" });
      continue;
    }
    const hasMigrated = Number(await redis.exists(migratedEventsKey(groupId))) === 1;
    events.push({ groupId, action: hasMigrated ? "merge" : "rename" });
  }

  const machines: MachineMigrationStep[] = machineFields.map((field) => ({
    field,
    action: field.includes(":") ? "skip" : "move",
  }));

  return { events, machines };
}

/**
 * Runs (or, `apply: false`, only plans) the migration. Returns the plan it
 * acted on and a summary of what happened (or would have).
 */
export async function migrateLegacyData(options: { apply: boolean }): Promise<{
  plan: MigrationPlan;
  summary: MigrationSummary;
}> {
  const { apply } = options;
  const redis = getRedis();
  const plan = await planLegacyMigration();
  const summary: MigrationSummary = { renamed: 0, merged: 0, machinesMoved: 0, skipped: 0 };

  for (const event of plan.events) {
    if (event.action === "skip") {
      summary.skipped += 1;
      continue;
    }
    if (!apply) {
      if (event.action === "rename") summary.renamed += 1;
      else summary.merged += 1;
      continue;
    }

    const legacyKey = legacyEventsKey(event.groupId);
    const targetKey = migratedEventsKey(event.groupId);
    // RENAMENX itself tells rename from merge: 1 when the target did not yet
    // exist (renamed), 0 when it did (fold the legacy set into it instead).
    const renamed = Number(await redis.renamenx(legacyKey, targetKey));
    if (renamed === 1) {
      summary.renamed += 1;
    } else {
      await redis.zunionstore(targetKey, 2, [targetKey, legacyKey], { aggregate: "max" });
      await redis.del(legacyKey);
      summary.merged += 1;
    }
  }

  if (plan.machines.some((machine) => machine.action === "move")) {
    const currentMachines = toStringRecord(await redis.hgetall(MACHINES_KEY));
    for (const machine of plan.machines) {
      if (machine.action === "skip") {
        summary.skipped += 1;
        continue;
      }
      if (!apply) {
        summary.machinesMoved += 1;
        continue;
      }

      const oldRaw = currentMachines[machine.field];
      if (oldRaw === undefined) continue; // gone since the plan was read (another migration, or a report arrived)
      const newField = `${LEGACY_PROVIDER_ID}:${machine.field}`;
      const newRaw = currentMachines[newField];
      const keep = newRaw !== undefined && tsOf(newRaw) >= tsOf(oldRaw) ? newRaw : oldRaw;
      await redis.hset(MACHINES_KEY, { [newField]: keep });
      await redis.hdel(MACHINES_KEY, machine.field);
      summary.machinesMoved += 1;
    }
  } else {
    summary.skipped += plan.machines.length;
  }

  return { plan, summary };
}

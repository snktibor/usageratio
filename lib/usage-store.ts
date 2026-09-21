import type { UsageEvent } from "@/lib/aggregate";
import type { KnownMachine } from "@/lib/dashboard";
import { getRedis, toStringRecord } from "@/lib/redis";
import {
  parseGroupEntry,
  randomGroupColor,
  serializeGroupEntry,
  serializeSettings,
  type IndexedGroup,
  type KnownGroup,
  type SettingsUpdate,
} from "@/lib/settings";
import type { UsageReport } from "@/lib/validation";

/**
 * Redis layout
 *
 *   usage:settings          STRING {"v": 1, "period", "limit", "reset": {…}, "showRemaining", "updatedAt": ms}
 *                                 the budget, as saved on the settings panel
 *   usage:events:{groupId}  ZSET  score = report time (epoch ms)
 *                                 member = {"m": machineId, "t": tokens, "ts": ms}
 *   usage:groups            HASH  groupId   → {"color": "#rrggbb", "ts": first-seen ms}
 *                                 (a bare ms number in entries older than group colours)
 *   usage:machines          HASH  machineId → {"g": groupId, "ts": ms, "t": tokens}
 *
 * One time-ordered set per group makes both filters a single native command:
 * a group is a key, a period is a score range (ZRANGE … BYSCORE). The reset
 * therefore needs no job and deletes nothing — the cycle is just the lower
 * bound of the query, and changing the reset time or the period re-slices
 * history. Members are unique per (machine, tokens, time), so a retried POST
 * is a no-op.
 *
 * The groups are a hash of their own rather than a list inside the settings
 * document because the machines all report at the top of the hour: a group
 * nobody defined has to be registered atomically. HSETNX does that inside the
 * report's transaction, and never touches a group that is already defined; a
 * read-modify-write of one JSON document would let concurrent reports (or a
 * save on the panel) overwrite each other.
 */
const KEYS = {
  settings: "usage:settings",
  groups: "usage:groups",
  machines: "usage:machines",
  events: (groupId: string) => `usage:events:${groupId}`,
};

const DAY_MS = 86_400_000;

/**
 * Persists one report. `duplicate` is true when the identical report was already
 * stored; `newGroup` when its group was unknown and got registered with a random colour.
 */
export async function storeReport(
  report: UsageReport,
  now: Date,
  retentionDays: number,
): Promise<{ duplicate: boolean; newGroup: boolean }> {
  const eventsKey = KEYS.events(report.groupId);
  const member = JSON.stringify({ m: report.machineId, t: report.tokens, ts: report.timestampMs });
  const lastReport = JSON.stringify({ g: report.groupId, ts: report.timestampMs, t: report.tokens });

  const tx = getRedis().multi();
  tx.hsetnx(KEYS.groups, report.groupId, serializeGroupEntry(randomGroupColor(), now.getTime()));
  tx.zadd(eventsKey, { nx: true }, { score: report.timestampMs, member });
  tx.zremrangebyscore(eventsKey, 0, now.getTime() - retentionDays * DAY_MS);
  tx.expire(eventsKey, (retentionDays + 1) * 86_400);
  tx.hset(KEYS.machines, { [report.machineId]: lastReport });
  const results: unknown[] = await tx.exec();

  return { duplicate: Number(results[1]) === 0, newGroup: Number(results[0]) === 1 };
}

function parseEvent(raw: unknown, groupId: string): UsageEvent | null {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof value !== "object" || value === null) return null;
    const { m, t, ts } = value as Record<string, unknown>;
    if (typeof m !== "string" || typeof t !== "number" || typeof ts !== "number") return null;
    if (!Number.isFinite(t) || t < 0 || !Number.isFinite(ts)) return null;
    return { machineId: m, groupId, tokens: t, ts };
  } catch {
    return null;
  }
}

function parseMachine(machineId: string, raw: string): KnownMachine | null {
  try {
    const { g, ts, t } = JSON.parse(raw) as Record<string, unknown>;
    if (typeof g !== "string" || typeof ts !== "number" || !Number.isFinite(ts)) return null;
    return { machineId, groupId: g, lastSeenAt: ts, lastTokens: typeof t === "number" ? t : 0 };
  } catch {
    return null;
  }
}

/** GET as the raw document, whether or not the SDK deserialized it on the way. */
function toRawDocument(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

export interface StoreIndexes {
  /** The stored settings document, unparsed; null until the panel saves one. */
  settings: string | null;
  groups: IndexedGroup[];
  machines: KnownMachine[];
}

/**
 * The settings and the group and machine indexes, in one round trip. The
 * settings come first because they decide how far back `loadEvents` must reach.
 */
export async function loadIndexes(): Promise<StoreIndexes> {
  const indexes = getRedis().pipeline();
  indexes.get(KEYS.settings);
  indexes.hgetall(KEYS.groups);
  indexes.hgetall(KEYS.machines);
  const [rawSettings, rawGroups, rawMachines]: unknown[] = await indexes.exec();

  const groups: IndexedGroup[] = Object.entries(toStringRecord(rawGroups)).map(([groupId, raw]) =>
    parseGroupEntry(groupId, raw),
  );
  const machines: KnownMachine[] = Object.entries(toStringRecord(rawMachines))
    .map(([machineId, raw]) => parseMachine(machineId, raw))
    .filter((machine): machine is KnownMachine => machine !== null);

  return { settings: toRawDocument(rawSettings), groups, machines };
}

/** The stored settings document alone. */
export async function loadRawSettings(): Promise<string | null> {
  return toRawDocument(await getRedis().get(KEYS.settings));
}

/**
 * All reports of `groups` since `sinceMs`, and for every group whether it has
 * any stored report at all (also older ones). One round trip.
 */
export async function loadEvents(
  groups: IndexedGroup[],
  sinceMs: number,
): Promise<{ events: UsageEvent[]; groups: KnownGroup[] }> {
  const events: UsageEvent[] = [];
  if (groups.length === 0) return { events, groups: [] };

  const reads = getRedis().pipeline();
  for (const group of groups) {
    reads.zrange(KEYS.events(group.groupId), sinceMs, "+inf", { byScore: true });
    reads.exists(KEYS.events(group.groupId));
  }
  const results: unknown[] = await reads.exec();

  const known = groups.map((group, index): KnownGroup => {
    const members = results[2 * index];
    if (Array.isArray(members)) {
      for (const raw of members) {
        // Entries that do not parse (e.g. edited by hand) are skipped, not fatal.
        const event = parseEvent(raw, group.groupId);
        if (event) events.push(event);
      }
    }
    return { ...group, hasReports: Number(results[2 * index + 1]) === 1 };
  });

  return { events, groups: known };
}

/** `loadEvents` without the events: just which groups still have stored reports. */
export async function loadGroupActivity(groups: IndexedGroup[]): Promise<KnownGroup[]> {
  if (groups.length === 0) return [];

  const reads = getRedis().pipeline();
  for (const group of groups) reads.exists(KEYS.events(group.groupId));
  const results: unknown[] = await reads.exec();

  return groups.map((group, index) => ({ ...group, hasReports: Number(results[index]) === 1 }));
}

export type SaveSettingsResult = { ok: true } | { ok: false; groupsWithReports: string[] };

/**
 * Applies one save of the settings panel. Nothing is written when a group to
 * be removed still has stored reports: taking it off the index would hide them
 * from the dashboard until its next report registered it again.
 *
 * Should the first report of a group arrive between the check and the removal,
 * exactly that happens; the group's next hourly report heals it.
 */
export async function saveSettings(update: SettingsUpdate, now: Date): Promise<SaveSettingsResult> {
  const redis = getRedis();

  const reads = redis.pipeline();
  reads.hgetall(KEYS.groups);
  for (const groupId of update.removedGroups) reads.exists(KEYS.events(groupId));
  const [rawGroups, ...stored]: unknown[] = await reads.exec();

  const groupsWithReports = update.removedGroups.filter((_, index) => Number(stored[index]) === 1);
  if (groupsWithReports.length > 0) return { ok: false, groupsWithReports };

  // A recoloured group keeps its first-seen time: it decides the order on the panel.
  const current = toStringRecord(rawGroups);
  const entries: Record<string, string> = {};
  for (const group of update.groups) {
    const existing = current[group.id];
    const firstSeenAt = existing === undefined ? 0 : parseGroupEntry(group.id, existing).firstSeenAt;
    entries[group.id] = serializeGroupEntry(group.color, firstSeenAt || now.getTime());
  }

  const tx = redis.multi();
  tx.set(KEYS.settings, serializeSettings(update.settings, now));
  if (update.groups.length > 0) tx.hset(KEYS.groups, entries);
  if (update.removedGroups.length > 0) tx.hdel(KEYS.groups, ...update.removedGroups);
  await tx.exec();

  return { ok: true };
}

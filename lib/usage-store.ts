import type { UsageEvent } from "@/lib/aggregate";
import type { KnownMachine } from "@/lib/dashboard";
import { reportCheckpoints } from "@/lib/days";
import { type OfficialUsageUpdate, officialUsageField, storedEntryFor } from "@/lib/official-usage";
import { DEFAULT_PROVIDER_ID, mergeProviderIds, normalizeProviderId } from "@/lib/providers";
import { getRedis, toStringRecord } from "@/lib/redis";
import {
  type IndexedGroup,
  type KnownGroup,
  parseGroupEntry,
  randomGroupColor,
  type SettingsUpdate,
  serializeGroupEntry,
  serializeSettings,
} from "@/lib/settings";
import type { UsageReport } from "@/lib/validation";

/**
 * Redis layout
 *
 *   usage:settings                       STRING provider limits and shared reset/display settings
 *   usage:providers                      HASH providerId → first-seen ms
 *   usage:events:{providerId}:{groupId}  ZSET  score = report time (epoch ms)
 *                                              member = {"m": machineId, "t": tokens, "ts": ms,
 *                                                        "b": {modelId: tokens}, "c": 1}
 *                                              ("b", the split by model, only from clients that send one;
 *                                              "c" marks a day's checkpoint, see lib/days.ts)
 *   usage:groups            HASH  groupId   → {"color": "#rrggbb", "ts": first-seen ms}
 *                                 (a bare ms number in entries older than group colours)
 *   usage:machines          HASH  providerId:machineId → {"g": groupId, "ts": ms, "t": tokens}
 *   usage:official           HASH  providerId, or providerId:subLimitId →
 *                                  {"raw": "45.5", "enteredAt": ms, "cycleStartMs": ms}
 *                                  (the ground-truth field on the dashboard; see lib/official-usage.ts)
 *
 * One time-ordered set per provider/group makes all filters native commands:
 * provider and group are in the key, a period is a score range. The reset
 * therefore needs no job and deletes nothing — the cycle is just the lower
 * bound of the query, and changing the reset time or the period re-slices
 * history. Members are unique per (provider, machine, tokens, time), so a
 * retried POST is a no-op.
 *
 * A report split by day (and hour) also leaves a checkpoint at the end of each
 * finished day and hour of its cycle: the machine's running total at that
 * moment. Every later report sends the same days again, so these are no-ops
 * too, until a day's total changes.
 *
 * Pre-provider keys (`usage:events:{groupId}` and plain machine hash fields)
 * are still read as DeepSeek data, so the refactor does not hide history.
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
  providers: "usage:providers",
  groups: "usage:groups",
  machines: "usage:machines",
  officialUsage: "usage:official",
  events: (providerId: string, groupId: string) => `usage:events:${providerId}:${groupId}`,
  legacyEvents: (groupId: string) => `usage:events:${groupId}`,
};

const DAY_MS = 86_400_000;

/**
 * One stored report (or checkpoint) of one provider. The models are sorted so
 * a retried POST serializes to the very same member, which ZADD NX then skips.
 */
function eventMember(
  machineId: string,
  tokens: number,
  timestampMs: number,
  models: Record<string, number> | undefined,
  checkpoint = false,
): string {
  const entries = Object.entries(models ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    m: machineId,
    t: tokens,
    ts: timestampMs,
    ...(entries.length > 0 && { b: Object.fromEntries(entries) }),
    ...(checkpoint && { c: 1 }),
  });
}

/** The stored split by model; null when the member has none or it is damaged. */
function parseModelSplit(raw: unknown): Record<string, number> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const split: Record<string, number> = {};
  for (const [modelId, tokens] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0) return null;
    split[modelId] = tokens;
  }
  return split;
}

/**
 * Persists one report, and the checkpoints of its split by day inside its
 * cycle (`cycle`: the time zone the clients split the days in, and the start
 * of the cycle the report falls in; null stores the report alone).
 * `duplicate` is true when the identical report was already stored;
 * `newGroup` when its group was unknown and got registered with a random colour.
 */
export async function storeReport(
  report: UsageReport,
  now: Date,
  retentionDays: number,
  cycle: { timeZone: string; startMs: number } | null,
): Promise<{ duplicate: boolean; newGroup: boolean; newProviders: string[] }> {
  const providers = Object.entries(report.providers);
  const oldestMs = now.getTime() - retentionDays * DAY_MS;
  const checkpoints = cycle ? reportCheckpoints(report, cycle.timeZone, Math.max(cycle.startMs, oldestMs)) : [];

  const tx = getRedis().multi();
  tx.hsetnx(KEYS.groups, report.groupId, serializeGroupEntry(randomGroupColor(), now.getTime()));
  const machineEntries: Record<string, string> = {};
  for (const [providerId, tokens] of providers) {
    const eventsKey = KEYS.events(providerId, report.groupId);
    const member = eventMember(report.machineId, tokens, report.timestampMs, report.models[providerId]);
    const lastReport = JSON.stringify({ g: report.groupId, ts: report.timestampMs, t: tokens });
    tx.hsetnx(KEYS.providers, providerId, now.getTime());
    tx.zadd(eventsKey, { nx: true }, { score: report.timestampMs, member });
    tx.zremrangebyscore(eventsKey, 0, oldestMs);
    tx.expire(eventsKey, (retentionDays + 1) * 86_400);
    machineEntries[`${providerId}:${report.machineId}`] = lastReport;
  }
  tx.hset(KEYS.machines, machineEntries);
  // After everything the results below are read from, so their positions stay fixed.
  for (const [providerId] of providers) {
    const members = checkpoints
      .filter((checkpoint) => checkpoint.providerId === providerId)
      .map((checkpoint) => ({
        score: checkpoint.ts,
        member: eventMember(report.machineId, checkpoint.tokens, checkpoint.ts, checkpoint.models, true),
      }));
    const [first, ...rest] = members;
    if (first) tx.zadd(KEYS.events(providerId, report.groupId), { nx: true }, first, ...rest);
  }
  const results: unknown[] = await tx.exec();

  const duplicate = providers.every((_, index) => Number(results[2 + index * 4]) === 0);
  const newProviders = providers.flatMap(([providerId], index) =>
    Number(results[1 + index * 4]) === 1 ? [providerId] : [],
  );
  return { duplicate, newGroup: Number(results[0]) === 1, newProviders };
}

function parseEvent(raw: unknown, groupId: string): UsageEvent | null {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof value !== "object" || value === null) return null;
    const { m, t, ts, b, c } = value as Record<string, unknown>;
    if (typeof m !== "string" || typeof t !== "number" || typeof ts !== "number") return null;
    if (!Number.isFinite(t) || t < 0 || !Number.isFinite(ts)) return null;
    const models = parseModelSplit(b);
    return {
      machineId: m,
      groupId,
      tokens: t,
      ts,
      ...(models && { models }),
      ...(c === 1 && { checkpoint: true }),
    };
  } catch {
    return null;
  }
}

export interface ProviderMachine extends KnownMachine {
  providerId: string;
}

function parseMachine(field: string, raw: string): ProviderMachine | null {
  try {
    const { g, ts, t } = JSON.parse(raw) as Record<string, unknown>;
    if (typeof g !== "string" || typeof ts !== "number" || !Number.isFinite(ts)) return null;
    const separator = field.indexOf(":");
    const providerId = separator < 0 ? DEFAULT_PROVIDER_ID : normalizeProviderId(field.slice(0, separator));
    const machineId = separator < 0 ? field : field.slice(separator + 1);
    if (!providerId || machineId.length === 0) return null;
    return { providerId, machineId, groupId: g, lastSeenAt: ts, lastTokens: typeof t === "number" ? t : 0 };
  } catch {
    return null;
  }
}

/** GET as the raw document, whether or not the SDK deserialized it on the way. */
function toRawDocument(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

function parseProviderIndex(raw: unknown): { providerId: string; firstSeenAt: number }[] {
  const providers = Object.entries(toStringRecord(raw)).flatMap(([rawProvider, rawFirstSeenAt]) => {
    const providerId = normalizeProviderId(rawProvider);
    const firstSeenAt = Number(rawFirstSeenAt);
    return providerId ? [{ providerId, firstSeenAt: Number.isFinite(firstSeenAt) ? firstSeenAt : 0 }] : [];
  });
  providers.sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.providerId.localeCompare(b.providerId));
  return providers;
}

export interface StoreIndexes {
  /** The stored settings document, unparsed; null until the panel saves one. */
  settings: string | null;
  groups: IndexedGroup[];
  providers: { providerId: string; firstSeenAt: number }[];
  machines: ProviderMachine[];
  /** The official-usage fields, unparsed; see lib/official-usage.ts. */
  officialUsage: Record<string, string>;
}

/**
 * The settings and the group, machine and official-usage indexes, in one
 * round trip. The settings come first because they decide how far back
 * `loadEvents` must reach.
 */
export async function loadIndexes(): Promise<StoreIndexes> {
  const indexes = getRedis().pipeline();
  indexes.get(KEYS.settings);
  indexes.hgetall(KEYS.groups);
  indexes.hgetall(KEYS.providers);
  indexes.hgetall(KEYS.machines);
  indexes.hgetall(KEYS.officialUsage);
  const [rawSettings, rawGroups, rawProviders, rawMachines, rawOfficialUsage]: unknown[] = await indexes.exec();

  const groups: IndexedGroup[] = Object.entries(toStringRecord(rawGroups)).map(([groupId, raw]) =>
    parseGroupEntry(groupId, raw),
  );
  const parsedMachines = Object.entries(toStringRecord(rawMachines))
    .map(([field, raw]) => parseMachine(field, raw))
    .filter((machine): machine is ProviderMachine => machine !== null);
  // A legacy `machineId` field and its new `deepseek:machineId` replacement can
  // coexist. Keep only the freshest row for that provider/machine pair.
  const machineMap = new Map<string, ProviderMachine>();
  for (const machine of parsedMachines) {
    const key = JSON.stringify([machine.providerId, machine.machineId]);
    const current = machineMap.get(key);
    if (!current || machine.lastSeenAt > current.lastSeenAt) machineMap.set(key, machine);
  }
  const machines = [...machineMap.values()];
  const providerTimes = new Map(
    parseProviderIndex(rawProviders).map(({ providerId, firstSeenAt }) => [providerId, firstSeenAt]),
  );
  for (const machine of machines) {
    const previous = providerTimes.get(machine.providerId);
    if (previous === undefined || (machine.lastSeenAt > 0 && machine.lastSeenAt < previous)) {
      providerTimes.set(machine.providerId, machine.lastSeenAt);
    }
  }
  const providers = [...providerTimes].map(([providerId, firstSeenAt]) => ({ providerId, firstSeenAt }));
  providers.sort((a, b) => a.firstSeenAt - b.firstSeenAt || a.providerId.localeCompare(b.providerId));

  return {
    settings: toRawDocument(rawSettings),
    groups,
    providers,
    machines,
    officialUsage: toStringRecord(rawOfficialUsage),
  };
}

/** The stored settings document alone. */
export async function loadRawSettings(): Promise<string | null> {
  return toRawDocument(await getRedis().get(KEYS.settings));
}

/** Minimal index read for clients asking how to scope their next ccusage snapshot. */
export async function loadReportContext(): Promise<{ settings: string | null; providerIds: string[] }> {
  const reads = getRedis().pipeline();
  reads.get(KEYS.settings);
  reads.hgetall(KEYS.providers);
  const [rawSettings, rawProviders]: unknown[] = await reads.exec();
  return {
    settings: toRawDocument(rawSettings),
    providerIds: parseProviderIndex(rawProviders).map((provider) => provider.providerId),
  };
}

/**
 * All reports of `groups` since `sinceMs`, and for every group whether it has
 * any stored report at all (also older ones). One round trip.
 */
export async function loadEvents(
  providerIds: string[],
  groups: IndexedGroup[],
  sinceMs: number,
): Promise<{ eventsByProvider: Record<string, UsageEvent[]>; groups: KnownGroup[] }> {
  const providers = mergeProviderIds(providerIds);
  const eventsByProvider = Object.fromEntries(providers.map((providerId) => [providerId, [] as UsageEvent[]]));
  if (groups.length === 0) return { eventsByProvider, groups: [] };

  const reads = getRedis().pipeline();
  const requests: { providerId: string; groupId: string }[] = [];
  for (const providerId of providers) {
    for (const group of groups) {
      reads.zrange(KEYS.events(providerId, group.groupId), sinceMs, "+inf", { byScore: true });
      reads.exists(KEYS.events(providerId, group.groupId));
      requests.push({ providerId, groupId: group.groupId });
      if (providerId === DEFAULT_PROVIDER_ID) {
        reads.zrange(KEYS.legacyEvents(group.groupId), sinceMs, "+inf", { byScore: true });
        reads.exists(KEYS.legacyEvents(group.groupId));
        requests.push({ providerId, groupId: group.groupId });
      }
    }
  }
  const results: unknown[] = await reads.exec();
  const activeGroups = new Set<string>();
  const seenEvents = new Map<string, Set<string>>();

  requests.forEach(({ providerId, groupId }, index) => {
    const members = results[2 * index];
    const target = eventsByProvider[providerId];
    if (target && Array.isArray(members)) {
      const seen = seenEvents.get(providerId) ?? new Set<string>();
      seenEvents.set(providerId, seen);
      for (const raw of members) {
        const event = parseEvent(raw, groupId);
        if (!event) continue;
        const identity = JSON.stringify([event.machineId, event.groupId, event.tokens, event.ts, !!event.checkpoint]);
        if (!seen.has(identity)) {
          seen.add(identity);
          target.push(event);
        }
      }
    }
    if (Number(results[2 * index + 1]) === 1) activeGroups.add(groupId);
  });

  return {
    eventsByProvider,
    groups: groups.map((group) => ({ ...group, hasReports: activeGroups.has(group.groupId) })),
  };
}

/** `loadEvents` without the events: just which groups still have stored reports. */
export async function loadGroupActivity(groups: IndexedGroup[], providerIds: string[]): Promise<KnownGroup[]> {
  if (groups.length === 0) return [];

  const providers = mergeProviderIds(providerIds);
  const reads = getRedis().pipeline();
  const requestedGroups: string[] = [];
  for (const group of groups) {
    for (const providerId of providers) {
      reads.exists(KEYS.events(providerId, group.groupId));
      requestedGroups.push(group.groupId);
    }
    reads.exists(KEYS.legacyEvents(group.groupId));
    requestedGroups.push(group.groupId);
  }
  const results: unknown[] = await reads.exec();
  const active = new Set<string>();
  results.forEach((result, index) => {
    if (Number(result) === 1) active.add(requestedGroups[index]!);
  });

  return groups.map((group) => ({ ...group, hasReports: active.has(group.groupId) }));
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
export async function saveSettings(
  update: SettingsUpdate,
  now: Date,
  providerIds: string[],
): Promise<SaveSettingsResult> {
  const redis = getRedis();

  const reads = redis.pipeline();
  reads.hgetall(KEYS.groups);
  const reportChecks: string[] = [];
  for (const groupId of update.removedGroups) {
    for (const providerId of mergeProviderIds(providerIds)) {
      reads.exists(KEYS.events(providerId, groupId));
      reportChecks.push(groupId);
    }
    reads.exists(KEYS.legacyEvents(groupId));
    reportChecks.push(groupId);
  }
  const [rawGroups, ...stored]: unknown[] = await reads.exec();

  const groupsWithReports = [
    ...new Set(stored.flatMap((result, index) => (Number(result) === 1 ? [reportChecks[index]!] : []))),
  ];
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

/**
 * One ground-truth field, typed on the dashboard: the provider's own figure,
 * or one of its sub-limits'. An empty `raw` clears it, so switching browsers
 * (or the next auto-refresh) shows nothing rather than a stale percentage.
 */
export async function saveOfficialUsage(update: OfficialUsageUpdate, now: Date): Promise<void> {
  const field = officialUsageField(update.providerId, update.subLimitId);
  const stored = storedEntryFor(update, now.getTime());
  if (stored === null) await getRedis().hdel(KEYS.officialUsage, field);
  else await getRedis().hset(KEYS.officialUsage, { [field]: stored });
}

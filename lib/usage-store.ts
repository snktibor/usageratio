import type { UsageEvent } from "@/lib/aggregate";
import { MAX_MACHINES } from "@/lib/config";
import type { KnownMachine } from "@/lib/dashboard";
import { reportCheckpoints } from "@/lib/days";
import { type CycleSummary, HISTORY_RETENTION, parseCycleSummary, serializeCycleSummary } from "@/lib/history";
import { type OfficialUsageUpdate, officialUsageField, storedEntryFor } from "@/lib/official-usage";
import { MAX_PROVIDERS, mergeProviderIds, normalizeProviderId } from "@/lib/providers";
import { getRedis, toStringRecord } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { TxPlan } from "@/lib/redis-tx";
import {
  type IndexedGroup,
  type KnownGroup,
  MAX_GROUPS,
  parseGroupEntry,
  randomGroupColor,
  type SettingsUpdate,
  serializeGroupEntry,
  serializeSettings,
} from "@/lib/settings";
import type { ReportMode, UsageReport } from "@/lib/validation";

/**
 * Redis layout
 *
 *   usage:settings                       STRING provider limits and shared reset/display settings
 *   usage:providers                      HASH providerId → first-seen ms
 *   usage:events:{providerId}:{groupId}  ZSET  score = report time (epoch ms)
 *                                              member = {"m": machineId, "t": tokens, "ts": ms,
 *                                                        "b": {modelId: tokens}, "$": costUsd,
 *                                                        "$b": {modelId: costUsd}, "c": 1, "x": 1}
 *                                              ("b", the split by model, only from clients that send one;
 *                                              "$"/"$b", the API-list-price cost estimate and its split by
 *                                              model, only from a client that opted in (lib/setup.ts COST);
 *                                              "c" marks a day's checkpoint, see lib/days.ts; "x" a merged
 *                                              machine's carry-over, see lib/machine-merge.ts)
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
 * Pre-provider data (a bare `usage:events:{groupId}` set, and `usage:machines`
 * fields without a `providerId:` prefix, both from before providers existed)
 * is no longer read here. Run `npm run migrate:legacy -- --apply`
 * (lib/migrate-legacy.ts) against the store once, before deploying a build
 * without this fallback, to fold it under the "deepseek" provider.
 *
 * The groups are a hash of their own rather than a list inside the settings
 * document because the machines all report at the top of the hour: a group
 * nobody defined has to be registered atomically. HSETNX does that inside the
 * report's transaction, and never touches a group that is already defined; a
 * read-modify-write of one JSON document would let concurrent reports (or a
 * save on the panel) overwrite each other.
 */

const DAY_MS = 86_400_000;

/**
 * One stored report (or checkpoint) of one provider. The models are sorted so
 * a retried POST serializes to the very same member, which ZADD NX then skips.
 * `costUsd`/`modelCosts` are the optional API-list-price estimate (lib/setup.ts
 * COST): absent for every client that does not opt in, and always absent from
 * a checkpoint, since a day's split carries no cost of its own (lib/days.ts).
 */
export function eventMember(
  machineId: string,
  tokens: number,
  timestampMs: number,
  models: Record<string, number> | undefined,
  costUsd: number | undefined,
  modelCosts: Record<string, number> | undefined,
  checkpoint = false,
  carried = false,
): string {
  const entries = Object.entries(models ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const costEntries = Object.entries(modelCosts ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({
    m: machineId,
    t: tokens,
    ts: timestampMs,
    ...(entries.length > 0 && { b: Object.fromEntries(entries) }),
    ...(costUsd !== undefined && { $: costUsd }),
    ...(costEntries.length > 0 && { $b: Object.fromEntries(costEntries) }),
    ...(checkpoint && { c: 1 }),
    ...(carried && { x: 1 }),
  });
}

/**
 * A machine's `usage:machines` entry. `md`/`iv` are left out for the common
 * case (mode "auto" without an interval): parseMachine below already treats a
 * missing field as "auto"/null, the same way it must for entries written
 * before these fields existed.
 */
function machineEntry(
  groupId: string,
  timestampMs: number,
  tokens: number,
  mode: ReportMode,
  intervalMinutes: number | null,
): string {
  return JSON.stringify({
    g: groupId,
    ts: timestampMs,
    t: tokens,
    ...(mode !== "auto" && { md: mode }),
    ...(intervalMinutes !== null && { iv: intervalMinutes }),
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

export type StoreReportRefusal = "too_many_groups" | "too_many_providers" | "too_many_machines";

export type StoreReportResult =
  | { ok: true; duplicate: boolean; newGroup: boolean; newProviders: string[]; heartbeat: boolean }
  | { ok: false; refused: StoreReportRefusal; limit: number };

/**
 * The registry caps, checked in one pipeline before the write below: refuses
 * a report that would register a group, provider or machine past MAX_GROUPS,
 * MAX_PROVIDERS or MAX_MACHINES. Read here, not inside the write's MULTI, so
 * two first reports racing each other can each see room and both get
 * written — the caps bound runaway growth, they are not an exact invariant
 * (see lib/config.ts MAX_MACHINES).
 */
async function checkRegistryCaps(report: UsageReport, heartbeat: boolean): Promise<StoreReportRefusal | null> {
  const providers = Object.entries(report.providers);
  const redis = getRedis();
  const caps = redis.pipeline();
  const plan = new TxPlan();
  plan.add("groupCount", () => caps.hlen(KEYS.groups));
  plan.add("groupExists", () => caps.hexists(KEYS.groups, report.groupId));
  if (!heartbeat) {
    plan.add("providerCount", () => caps.hlen(KEYS.providers));
    for (const [providerId] of providers) {
      plan.add(`providerExists:${providerId}`, () => caps.hexists(KEYS.providers, providerId));
    }
    plan.add("machineCount", () => caps.hlen(KEYS.machines));
    for (const [providerId] of providers) {
      plan.add(`machineExists:${providerId}`, () => caps.hexists(KEYS.machines, `${providerId}:${report.machineId}`));
    }
  }
  const results: unknown[] = await caps.exec();

  const groupCount = Number(plan.result(results, "groupCount"));
  const groupExists = Number(plan.result(results, "groupExists")) === 1;
  if (!groupExists && groupCount >= MAX_GROUPS) return "too_many_groups";
  if (heartbeat) return null;

  const providerCount = Number(plan.result(results, "providerCount"));
  const newProviderCount = providers.filter(
    ([providerId]) => Number(plan.result(results, `providerExists:${providerId}`)) === 0,
  ).length;
  if (providerCount + newProviderCount > MAX_PROVIDERS) return "too_many_providers";

  const machineCount = Number(plan.result(results, "machineCount"));
  const newMachineCount = providers.filter(
    ([providerId]) => Number(plan.result(results, `machineExists:${providerId}`)) === 0,
  ).length;
  if (machineCount + newMachineCount > MAX_MACHINES) return "too_many_machines";

  return null;
}

/**
 * Persists one report, and the checkpoints of its split by day inside its
 * cycle (`cycle`: the time zone the clients split the days in, and the start
 * of the cycle the report falls in; null stores the report alone).
 * `duplicate` is true when the identical report was already stored;
 * `newGroup` when its group was unknown and got registered with a random colour.
 *
 * An empty `providers` snapshot (`{}`) is a heartbeat: a fresh machine with
 * nothing to report yet (see lib/validation.ts `parseProviders`). Its group is
 * still registered — so the machine's group shows up on the settings panel —
 * but no provider or machine row is invented for it, since there is nothing
 * to name one after; `heartbeat` comes back true and `duplicate` false.
 *
 * Refuses (`ok: false`) instead of writing anything when the report would
 * register a new group, provider or machine past its cap; see
 * `checkRegistryCaps` above.
 */
export async function storeReport(
  report: UsageReport,
  now: Date,
  retentionDays: number,
  cycle: { timeZone: string; startMs: number } | null,
): Promise<StoreReportResult> {
  const providers = Object.entries(report.providers);
  const heartbeat = providers.length === 0;

  const refused = await checkRegistryCaps(report, heartbeat);
  if (refused === "too_many_groups") return { ok: false, refused, limit: MAX_GROUPS };
  if (refused === "too_many_providers") return { ok: false, refused, limit: MAX_PROVIDERS };
  if (refused === "too_many_machines") return { ok: false, refused, limit: MAX_MACHINES };

  const oldestMs = now.getTime() - retentionDays * DAY_MS;
  const checkpoints =
    cycle && !heartbeat ? reportCheckpoints(report, cycle.timeZone, Math.max(cycle.startMs, oldestMs)) : [];

  const tx = getRedis().multi();
  const plan = new TxPlan();
  plan.add("group", () =>
    tx.hsetnx(KEYS.groups, report.groupId, serializeGroupEntry(randomGroupColor(), now.getTime())),
  );
  if (!heartbeat) {
    const machineEntries: Record<string, string> = {};
    for (const [providerId, tokens] of providers) {
      const eventsKey = KEYS.events(providerId, report.groupId);
      const member = eventMember(
        report.machineId,
        tokens,
        report.timestampMs,
        report.models[providerId],
        report.costs[providerId],
        report.modelCosts[providerId],
      );
      const lastReport = machineEntry(
        report.groupId,
        report.timestampMs,
        tokens,
        report.mode ?? "auto",
        report.intervalMinutes ?? null,
      );
      plan.add(`provider:${providerId}`, () => tx.hsetnx(KEYS.providers, providerId, now.getTime()));
      plan.add(`event:${providerId}`, () => tx.zadd(eventsKey, { nx: true }, { score: report.timestampMs, member }));
      plan.add(null, () => tx.zremrangebyscore(eventsKey, 0, oldestMs));
      plan.add(null, () => tx.expire(eventsKey, (retentionDays + 1) * 86_400));
      machineEntries[`${providerId}:${report.machineId}`] = lastReport;
    }
    plan.add(null, () => tx.hset(KEYS.machines, machineEntries));
    for (const [providerId] of providers) {
      const members = checkpoints
        .filter((checkpoint) => checkpoint.providerId === providerId)
        .map((checkpoint) => ({
          score: checkpoint.ts,
          member: eventMember(
            report.machineId,
            checkpoint.tokens,
            checkpoint.ts,
            checkpoint.models,
            undefined,
            undefined,
            true,
          ),
        }));
      const [first, ...rest] = members;
      if (first) plan.add(null, () => tx.zadd(KEYS.events(providerId, report.groupId), { nx: true }, first, ...rest));
    }
  }
  const results: unknown[] = await tx.exec();

  // ZADD NX answers how many members were new: 0 for every provider means the very same report was stored before.
  const duplicate =
    !heartbeat && providers.every(([providerId]) => Number(plan.result(results, `event:${providerId}`)) === 0);
  const newProviders = heartbeat
    ? []
    : providers.flatMap(([providerId]) =>
        Number(plan.result(results, `provider:${providerId}`)) === 1 ? [providerId] : [],
      );
  return { ok: true, duplicate, newGroup: Number(plan.result(results, "group")) === 1, newProviders, heartbeat };
}

export function parseEvent(raw: unknown, groupId: string): UsageEvent | null {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof value !== "object" || value === null) return null;
    const { m, t, ts, b, c, x, $: cost, $b: modelCostsRaw } = value as Record<string, unknown>;
    if (typeof m !== "string" || typeof t !== "number" || typeof ts !== "number") return null;
    if (!Number.isFinite(t) || t < 0 || !Number.isFinite(ts)) return null;
    const models = parseModelSplit(b);
    // Same shape a token split has (finite, non-negative), just fractional dollars: lenient about
    // an older member, or one from a client that never opted into cost, having neither field.
    const costUsd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
    const modelCosts = parseModelSplit(modelCostsRaw);
    return {
      machineId: m,
      groupId,
      tokens: t,
      ts,
      ...(models && { models }),
      ...(costUsd !== undefined && { costUsd }),
      ...(modelCosts && { modelCosts }),
      ...(c === 1 && { checkpoint: true }),
      ...(x === 1 && { carried: true }),
    };
  } catch {
    return null;
  }
}

export interface ProviderMachine extends KnownMachine {
  providerId: string;
}

/** A finite integer of at least `min`, else `fallback`; used for the lenient fields below. */
function finiteIntegerOr(value: unknown, min: number, fallback: number | null): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : fallback;
}

function parseMachine(field: string, raw: string): ProviderMachine | null {
  try {
    const { g, ts, t, md, iv } = JSON.parse(raw) as Record<string, unknown>;
    if (typeof g !== "string" || typeof ts !== "number" || !Number.isFinite(ts)) return null;
    const separator = field.indexOf(":");
    // A field without a "providerId:" prefix is pre-provider data: run the migration first (see the layout comment above).
    if (separator < 0) return null;
    const providerId = normalizeProviderId(field.slice(0, separator));
    const machineId = field.slice(separator + 1);
    if (!providerId || machineId.length === 0) return null;
    // Lenient: an entry written before these fields existed (or a damaged one) reads as auto/null.
    const mode: ReportMode = md === "manual" ? "manual" : "auto";
    const intervalMinutes = finiteIntegerOr(iv, 1, null);
    return {
      providerId,
      machineId,
      groupId: g,
      lastSeenAt: ts,
      lastTokens: typeof t === "number" ? t : 0,
      mode,
      intervalMinutes,
    };
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

/**
 * Records `providerIds` as first seen at `atMs` (one millisecond apart, in
 * order) unless they are already known. The provider list and the dashboard's
 * default account follow first-seen order; the demo seed uses this to list its
 * accounts in its own order.
 */
export async function registerProviders(providerIds: string[], atMs: number): Promise<void> {
  if (providerIds.length === 0) return;
  const tx = getRedis().multi();
  providerIds.forEach((providerId, index) => {
    tx.hsetnx(KEYS.providers, providerId, atMs + index);
  });
  await tx.exec();
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
  const plan = new TxPlan();
  const requests: { providerId: string; groupId: string }[] = [];
  const request = (providerId: string, groupId: string, key: string) => {
    const index = requests.length;
    plan.add(`members:${index}`, () => reads.zrange(key, sinceMs, "+inf", { byScore: true }));
    plan.add(`exists:${index}`, () => reads.exists(key));
    requests.push({ providerId, groupId });
  };
  for (const providerId of providers) {
    for (const group of groups) {
      request(providerId, group.groupId, KEYS.events(providerId, group.groupId));
    }
  }
  const results: unknown[] = await reads.exec();
  const activeGroups = new Set<string>();
  const seenEvents = new Map<string, Set<string>>();

  requests.forEach(({ providerId, groupId }, index) => {
    const members = plan.result(results, `members:${index}`);
    const target = eventsByProvider[providerId];
    if (target && Array.isArray(members)) {
      const seen = seenEvents.get(providerId) ?? new Set<string>();
      seenEvents.set(providerId, seen);
      for (const raw of members) {
        const event = parseEvent(raw, groupId);
        if (!event) continue;
        const identity = JSON.stringify([
          event.machineId,
          event.groupId,
          event.tokens,
          event.ts,
          !!event.checkpoint,
          !!event.carried,
        ]);
        if (!seen.has(identity)) {
          seen.add(identity);
          target.push(event);
        }
      }
    }
    if (Number(plan.result(results, `exists:${index}`)) === 1) activeGroups.add(groupId);
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
  const plan = new TxPlan();
  const requestedGroups: string[] = [];
  const check = (groupId: string, key: string) => {
    plan.add(`exists:${requestedGroups.length}`, () => reads.exists(key));
    requestedGroups.push(groupId);
  };
  for (const group of groups) {
    for (const providerId of providers) check(group.groupId, KEYS.events(providerId, group.groupId));
  }
  const results: unknown[] = await reads.exec();
  const active = new Set<string>();
  requestedGroups.forEach((groupId, index) => {
    if (Number(plan.result(results, `exists:${index}`)) === 1) active.add(groupId);
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
  const plan = new TxPlan();
  plan.add("groups", () => reads.hgetall(KEYS.groups));
  const reportChecks: string[] = [];
  const check = (groupId: string, key: string) => {
    plan.add(`check:${reportChecks.length}`, () => reads.exists(key));
    reportChecks.push(groupId);
  };
  for (const groupId of update.removedGroups) {
    for (const providerId of mergeProviderIds(providerIds)) check(groupId, KEYS.events(providerId, groupId));
  }
  const results: unknown[] = await reads.exec();
  const rawGroups = plan.result(results, "groups");

  const groupsWithReports = [
    ...new Set(reportChecks.filter((_, index) => Number(plan.result(results, `check:${index}`)) === 1)),
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

// ── History (archived cycles) ────────────────────────────────────────────────
// See lib/history.ts for what a summary holds and how it is built; the reads and
// writes below only move the already-built JSON in and out of the ZSET.

/**
 * Archives one cycle's summary for `providerId`: `ZADD NX` (so a render that
 * loses a race with another one is a harmless no-op) then, in the same
 * transaction, trims the set to the newest HISTORY_RETENTION entries.
 * Returns whether this call is the one that actually wrote it.
 */
export async function archiveCycle(providerId: string, summary: CycleSummary): Promise<boolean> {
  const key = KEYS.history(providerId);
  const tx = getRedis().multi();
  const plan = new TxPlan();
  plan.add("added", () => tx.zadd(key, { nx: true }, { score: summary.start, member: serializeCycleSummary(summary) }));
  plan.add(null, () => tx.zremrangebyrank(key, 0, -(HISTORY_RETENTION + 1)));
  const results: unknown[] = await tx.exec();
  return Number(plan.result(results, "added")) === 1;
}

/**
 * The start of the newest archived cycle, per provider; null where nothing is
 * archived yet. One round trip: a dashboard read uses this to decide whether
 * the previous cycle still needs archiving (see app/[locale]/(dashboard)/page.tsx).
 */
export async function loadNewestArchivedStarts(providerIds: string[]): Promise<Record<string, number | null>> {
  const starts: Record<string, number | null> = {};
  if (providerIds.length === 0) return starts;

  const reads = getRedis().pipeline();
  const plan = new TxPlan();
  for (const providerId of providerIds) {
    plan.add(`newest:${providerId}`, () => reads.zrange(KEYS.history(providerId), -1, -1, { withScores: true }));
  }
  const results: unknown[] = await reads.exec();

  for (const providerId of providerIds) {
    const raw = plan.result(results, `newest:${providerId}`);
    const score = Array.isArray(raw) && raw.length >= 2 ? Number(raw[1]) : NaN;
    starts[providerId] = Number.isFinite(score) ? score : null;
  }
  return starts;
}

/** Up to HISTORY_RETENTION archived cycles per provider, newest first. One round trip. */
export async function loadHistory(providerIds: string[]): Promise<Record<string, CycleSummary[]>> {
  const history: Record<string, CycleSummary[]> = {};
  if (providerIds.length === 0) return history;

  const reads = getRedis().pipeline();
  const plan = new TxPlan();
  for (const providerId of providerIds) {
    plan.add(`entries:${providerId}`, () =>
      reads.zrange(KEYS.history(providerId), 0, HISTORY_RETENTION - 1, { rev: true }),
    );
  }
  const results: unknown[] = await reads.exec();

  for (const providerId of providerIds) {
    const raw = plan.result(results, `entries:${providerId}`);
    const members = Array.isArray(raw) ? raw : [];
    history[providerId] = members
      .map((member) => parseCycleSummary(String(member)))
      .filter((summary): summary is CycleSummary => summary !== null);
  }
  return history;
}

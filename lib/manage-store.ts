import type { UsageEvent } from "@/lib/aggregate";
import { archiveBeforeChange } from "@/lib/archive";
import { archivedGroupIds, isMachineArchived } from "@/lib/archived";
import { RETENTION_DAYS, type ResetConfig, type TokenMode } from "@/lib/config";
import { getCycle, getDaySegments } from "@/lib/cycle";
import { carryOver, type MergeCycle, type MergeUnit } from "@/lib/machine-merge";
import { type ManageAuditWriter, parseManageAuditRecord, queueManageAudit } from "@/lib/manage-audit";
import { randomGroupColor, resolveGroupColors, serializeGroupEntry } from "@/lib/settings";
import type { TenantStore } from "@/lib/tenant";
import { groupSettingsParts, newTrashId, providerSettingsParts, queueTrash, type TrashKeyRef } from "@/lib/trash";
import { eventMember, loadIndexes, loadRawSettings, machineEntry, parseEvent } from "@/lib/usage-store";

/**
 * Renaming, moving, merging and deleting the things the dashboard auto-registers:
 * machines, groups and providers. Nothing here runs on the hot report path
 * (lib/usage-store.ts `storeReport`); these are the settings panel's manual
 * "manage" actions, gated by session + sudo at the route layer
 * (app/api/machines, app/api/groups, app/api/providers).
 *
 * A machine merge combines two snapshot histories day by day, through a
 * carry-over series (lib/machine-merge.ts): read back as one series they
 * would be a max, losing tokens, and as two a sum, counting some twice. A
 * group merge is fine as it is — its ZSETs
 * are unioned with MAX per member, which is exactly how a snapshot's history
 * is already read (lib/aggregate.ts) — so two groups that both reported the
 * same machine at the same moment collapse into one identical entry instead
 * of double-counting.
 */

export interface Affected {
  /** Event-ZSET members rewritten, merged away, or deleted. */
  events: number;
  /** `usage:machines` hash fields moved or removed. */
  machines: number;
  /** Groups whose identity or events changed (a group rename/merge/delete is always exactly 1; a provider delete counts the groups whose events for it were dropped). */
  groups: number;
}

const NO_CHANGE: Affected = { events: 0, machines: 0, groups: 0 };

export type MoveMachineResult =
  | { ok: true; affected: Affected }
  | { ok: false; reason: "not_found" | "group_not_found" | "exists" | "unsupported_mode" };

export interface MoveMachineOptions {
  /** Combine with a machine that already has the new id, instead of refusing (`exists`). */
  merge: boolean;
  mode: TokenMode;
  reset: ResetConfig;
  retentionDays: number;
  now: Date;
  /** Records a merge (a move onto an id in use) in the same transaction; a plain move writes nothing. */
  audit?: ManageAuditWriter;
}

interface MoveUnit {
  groupId: string;
  machineId: string;
  key: string;
  raw: { member: ParsedMember; event: UsageEvent }[];
  carried: { member: ParsedMember; event: UsageEvent }[];
}
export type DeleteResult = { ok: true; affected: Affected } | { ok: false; reason: "not_found" };
export type RenameGroupResult = { ok: true; affected: Affected } | { ok: false; reason: "not_found" | "exists" };

/** A machine that reported within this long ago re-creates what a delete removes with its next report. */
export const RECENT_REPORT_MS = 24 * 3_600_000;

/** What a (forced) delete removes, as the delete dialog shows it before anything is deleted. */
export interface DeleteImpact extends Affected {
  /** Newest stored report among the keys it would delete (ms); null without any. */
  lastReportAt: number | null;
  /** Its machines whose last report is under RECENT_REPORT_MS old: they re-create it with their next one. */
  recentMachines: number;
}

export interface DeleteOptions {
  /** Count what a forced delete would remove, and write nothing: no refusal, no archive. */
  dryRun?: boolean;
  /** Records the delete in the same transaction as the change; a dry run and a refused delete write nothing. */
  audit?: ManageAuditWriter;
}

export type DeleteWithEventsResult =
  | {
      ok: true;
      affected: Affected;
      impact: DeleteImpact;
      /** The trash entry a forced delete of stored reports moved them into (lib/trash.ts); absent when nothing was moved. */
      trashId?: string;
    }
  | { ok: false; reason: "not_found" | "has_events" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParsedMember {
  /** The exact stored JSON text: what ZREM must be given back to remove it. */
  raw: string;
  score: number;
  machineId: string;
}

/** The machine id inside one stored event member, or null when it does not parse. */
function memberMachineId(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return typeof value.m === "string" ? value.m : null;
  } catch {
    return null;
  }
}

/** Every member of each key, with its score and machine id, in one round trip. Unparsable members are skipped: never rewritten, never counted. */
async function readMembersForKeys(store: TenantStore, keys: string[]): Promise<Map<string, ParsedMember[]>> {
  const map = new Map<string, ParsedMember[]>();
  if (keys.length === 0) return map;
  const pipeline = store.redis.pipeline();
  for (const key of keys) pipeline.zrange(key, 0, -1, { withScores: true });
  const results = (await pipeline.exec()) as unknown[];
  keys.forEach((key, index) => {
    const raw = results[index];
    const list: ParsedMember[] = [];
    if (Array.isArray(raw)) {
      for (let i = 0; i + 1 < raw.length; i += 2) {
        const member = String(raw[i]);
        const score = Number(raw[i + 1]);
        const machineId = memberMachineId(member);
        if (machineId !== null && Number.isFinite(score)) list.push({ raw: member, score, machineId });
      }
    }
    map.set(key, list);
  });
  return map;
}

function rewriteMemberMachineId(raw: string, newMachineId: string): string {
  const value = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify({ ...value, m: newMachineId });
}

/**
 * Moves one machine (one provider: the route loops when a caller wants all of
 * them) to a new id, a new group, or both. Everything the machine stored for
 * this provider, in whichever groups, ends up in the new group's events key
 * under the new id, and its `usage:machines` field moves with it.
 *
 * Onto an id already in use (`exists` unless `merge`), and whenever the
 * machine's history is spread over several groups, the histories are
 * combined: the one that stays (the target's own in the new group, else the
 * one reported to last) is kept as it is, and the rest become its carry-over
 * (lib/machine-merge.ts) — day by day, whichever saw more. Snapshot mode only
 * (`unsupported_mode` otherwise); a plain move works in every mode.
 */
export async function moveMachine(
  store: TenantStore,
  providerId: string,
  machineId: string,
  target: { machineId?: string; groupId?: string },
  options: MoveMachineOptions,
): Promise<MoveMachineResult> {
  const indexes = await loadIndexes(store);
  const source = indexes.machines.find((m) => m.providerId === providerId && m.machineId === machineId);
  if (!source) return { ok: false, reason: "not_found" };
  const newMachineId = target.machineId ?? machineId;
  const renamed = newMachineId !== machineId;
  const existing = renamed
    ? indexes.machines.find((m) => m.providerId === providerId && m.machineId === newMachineId)
    : undefined;
  const newGroupId = target.groupId ?? existing?.groupId ?? source.groupId;
  if (!indexes.groups.some((group) => group.groupId === newGroupId)) return { ok: false, reason: "group_not_found" };

  const groupIds = indexes.groups.map((group) => group.groupId);
  const keys = groupIds.map((groupId) => store.keys.events(providerId, groupId));
  const membersByKey = await readMembersForKeys(store, keys);

  // One unit per group and machine id: the machine's own history there, and its carry-over.
  const units: MoveUnit[] = [];
  groupIds.forEach((groupId, index) => {
    for (const id of renamed ? [machineId, newMachineId] : [machineId]) {
      const unit: MoveUnit = { groupId, machineId: id, key: keys[index]!, raw: [], carried: [] };
      for (const member of membersByKey.get(unit.key) ?? []) {
        if (member.machineId !== id) continue;
        const event = parseEvent(member.raw, groupId);
        if (event) (event.carried ? unit.carried : unit.raw).push({ member, event });
      }
      if (unit.raw.length + unit.carried.length > 0) units.push(unit);
    }
  });

  const targetTaken = existing !== undefined || units.some((unit) => unit.machineId === newMachineId && renamed);
  if (targetTaken && !options.merge) return { ok: false, reason: "exists" };
  if (!renamed && newGroupId === source.groupId && units.every((unit) => unit.groupId === newGroupId)) {
    return { ok: true, affected: NO_CHANGE };
  }
  if (units.length > 1 && options.mode !== "snapshot") return { ok: false, reason: "unsupported_mode" };

  const latestRaw = (unit: MoveUnit) => Math.max(-Infinity, ...unit.raw.map(({ event }) => event.ts));
  const base =
    units.find((unit) => unit.machineId === newMachineId && unit.groupId === newGroupId) ??
    [...units].sort((a, b) => latestRaw(b) - latestRaw(a))[0];

  const destKey = store.keys.events(providerId, newGroupId);
  // The members that leave their place: all of them, but the base's own reports when they already sit where they belong.
  const baseStays = base?.key === destKey && base.machineId === newMachineId;
  const removals = units.map((unit) => ({
    key: unit.key,
    members: unit === base && baseStays ? (units.length > 1 ? unit.carried : []) : [...unit.raw, ...unit.carried],
  }));
  const additions: { score: number; member: string }[] = [];
  if (base && !baseStays) {
    const kept = units.length > 1 ? base.raw : [...base.raw, ...base.carried];
    for (const { member } of kept) {
      additions.push({ score: member.score, member: rewriteMemberMachineId(member.raw, newMachineId) });
    }
  }
  if (base && units.length > 1) {
    const toUnit = (unit: MoveUnit): MergeUnit => ({
      raw: unit.raw.map(({ event }) => event),
      carried: unit.carried.map(({ event }) => event),
    });
    const others = units.filter((unit) => unit !== base).map(toUnit);
    const earliestMs = Math.min(
      ...units.flatMap((unit) => [...unit.raw, ...unit.carried].map(({ event }) => event.ts)),
    );
    for (const point of carryOver(toUnit(base), others, mergeCycles(earliestMs, options), options.now.getTime())) {
      additions.push({
        score: point.ts,
        member: eventMember(newMachineId, point.tokens, point.ts, point.models, point.costUsd, undefined, true, true),
      });
    }
  }

  const eventsTouched = removals.reduce((sum, removal) => sum + removal.members.length, 0);
  const groupsLeft = new Set(units.map((unit) => unit.groupId).filter((groupId) => groupId !== newGroupId));
  if (source.groupId !== newGroupId) groupsLeft.add(source.groupId);
  const affected = { events: eventsTouched, machines: existing ? 2 : 1, groups: groupsLeft.size };
  const audit =
    targetTaken && options.audit
      ? await options.audit({
          action: "machine_merged",
          subject: { kind: "machine", id: machineId, providerId, target: newMachineId },
          affected,
        })
      : null;

  const tx = store.redis.multi();
  for (const removal of removals) {
    if (removal.members.length === 0) continue;
    const [first, ...rest] = removal.members.map(({ member }) => member.raw) as [string, ...string[]];
    tx.zrem(removal.key, first, ...rest);
  }
  if (additions.length > 0) {
    const [first, ...rest] = additions as [{ score: number; member: string }, ...{ score: number; member: string }[]];
    tx.zadd(destKey, first, ...rest);
    tx.expire(destKey, (options.retentionDays + 1) * 86_400);
    tx.sadd(store.keys.registry, destKey);
  }

  // The index keeps whichever of the two entries reported last, now under the new id and group.
  const newest = existing && existing.lastSeenAt > source.lastSeenAt ? existing : source;
  if (renamed) tx.hdel(store.keys.machines, `${providerId}:${machineId}`);
  tx.hset(store.keys.machines, {
    [`${providerId}:${newMachineId}`]: machineEntry(
      newGroupId,
      newest.lastSeenAt,
      newest.lastTokens,
      newest.mode,
      newest.intervalMinutes,
      newest.archivedAt,
    ),
  });
  if (audit) queueManageAudit(tx, store, audit);
  await tx.exec();

  return { ok: true, affected };
}

/** Every cycle (under the current reset settings) from the one holding `earliestMs` to the running one. */
function mergeCycles(earliestMs: number, { reset, now }: MoveMachineOptions): MergeCycle[] {
  const cycles: MergeCycle[] = [];
  let cycle = getCycle(new Date(earliestMs), reset);
  // A year of weekly cycles is 53; retention keeps far less, the bound is only a safety net.
  for (let i = 0; i < 400 && cycle.start.getTime() <= now.getTime(); i += 1) {
    cycles.push({
      startMs: cycle.start.getTime(),
      endMs: cycle.end.getTime(),
      dayEndsMs: getDaySegments(cycle, reset.timeZone).map((segment) => segment.end.getTime()),
    });
    cycle = getCycle(cycle.end, reset);
  }
  return cycles;
}

/** Deletes one machine (one provider): its `usage:machines` field and every member naming it, in every group's events key of this provider. */
export async function deleteMachine(
  store: TenantStore,
  providerId: string,
  machineId: string,
  options: { audit?: ManageAuditWriter } = {},
): Promise<DeleteResult> {
  const indexes = await loadIndexes(store);
  const machine = indexes.machines.find((m) => m.providerId === providerId && m.machineId === machineId);
  if (!machine) return { ok: false, reason: "not_found" };

  const groupIds = indexes.groups.map((group) => group.groupId);
  const keys = groupIds.map((groupId) => store.keys.events(providerId, groupId));
  const membersByKey = await readMembersForKeys(store, keys);

  const matchesByKey = keys.map((key) => ({
    key,
    matches: (membersByKey.get(key) ?? []).filter((entry) => entry.machineId === machineId),
  }));
  const affected = {
    events: matchesByKey.reduce((sum, { matches }) => sum + matches.length, 0),
    machines: 1,
    groups: 0,
  };
  const audit = options.audit
    ? await options.audit({
        action: "machine_deleted",
        subject: { kind: "machine", id: machineId, providerId },
        affected,
      })
    : null;

  const tx = store.redis.multi();
  for (const { key, matches } of matchesByKey) {
    if (matches.length > 0) tx.zrem(key, ...matches.map((entry) => entry.raw));
  }
  tx.hdel(store.keys.machines, `${providerId}:${machineId}`);
  if (audit) queueManageAudit(tx, store, audit);
  await tx.exec();

  return { ok: true, affected };
}

/**
 * Silent machines dropped from the index (not their stored reports), across every provider.
 * Mirrors lib/housekeeping.ts's own machine step, triggered on demand. Archived machines stay
 * (lib/archived.ts): they are already off the list, and the Archived list keeps them.
 */
export async function pruneMachines(
  store: TenantStore,
  now: Date,
  inactiveDays: number,
): Promise<{ removedIds: string[] }> {
  const indexes = await loadIndexes(store);
  const cutoffMs = now.getTime() - inactiveDays * 86_400_000;
  const archivedGroups = archivedGroupIds(indexes.groups);
  const stale = indexes.machines.filter(
    (machine) => machine.lastSeenAt < cutoffMs && !isMachineArchived(machine, archivedGroups),
  );
  const fields = stale.map((machine) => `${machine.providerId}:${machine.machineId}`);
  if (fields.length > 0) await store.redis.hdel(store.keys.machines, ...fields);
  return { removedIds: fields };
}

export type ArchiveResult = { ok: true; changed: boolean } | { ok: false; reason: "not_found" };

/**
 * Archives (`archived: true`) or restores one group (lib/archived.ts): only its `usage:groups`
 * entry changes, its reports and machines stay as they are. A group without a stored colour (an
 * entry older than colours) is given the one the dashboard shows it in, so archiving never
 * changes how it is drawn. `changed` is false when it already was in that state.
 *
 * Read, then written: a report landing in between rewrites nothing here (it only HSETNXes an
 * existing group), so the archive simply wins; the group's next report brings it back.
 */
export async function setGroupArchived(
  store: TenantStore,
  groupId: string,
  archived: boolean,
  now: Date,
): Promise<ArchiveResult> {
  const indexes = await loadIndexes(store);
  const group = indexes.groups.find((entry) => entry.groupId === groupId);
  if (!group) return { ok: false, reason: "not_found" };
  if ((group.archivedAt !== undefined) === archived) return { ok: true, changed: false };

  // resolveGroupColors gives every group it is handed a colour.
  const color = group.color ?? resolveGroupColors(indexes.groups).get(groupId)!;
  const entry = serializeGroupEntry(color, group.firstSeenAt, archived ? now.getTime() : undefined);
  await store.redis.hset(store.keys.groups, { [groupId]: entry });
  return { ok: true, changed: true };
}

/**
 * Archives (`archived: true`) or restores one machine's entry for one provider (the route is
 * called once per provider, like a move): only its `usage:machines` field changes. Restoring a
 * machine whose group is archived clears its own mark, but it stays archived with the group.
 *
 * Read, then written: a report landing in between is overwritten by the copy read before it, so
 * the entry's last-seen time and tokens lag one report behind until the next one, which also
 * brings the machine back.
 */
export async function setMachineArchived(
  store: TenantStore,
  providerId: string,
  machineId: string,
  archived: boolean,
  now: Date,
): Promise<ArchiveResult> {
  const indexes = await loadIndexes(store);
  const machine = indexes.machines.find((m) => m.providerId === providerId && m.machineId === machineId);
  if (!machine) return { ok: false, reason: "not_found" };
  if ((machine.archivedAt !== undefined) === archived) return { ok: true, changed: false };

  const entry = machineEntry(
    machine.groupId,
    machine.lastSeenAt,
    machine.lastTokens,
    machine.mode,
    machine.intervalMinutes,
    archived ? now.getTime() : undefined,
  );
  await store.redis.hset(store.keys.machines, { [`${providerId}:${machineId}`]: entry });
  return { ok: true, changed: true };
}

/** Moves (or merges) a group's `excludedProviders` entry in the settings document; a no-op without a stored document or exclusion. */
async function moveExclusionsInSettings(
  store: TenantStore,
  oldId: string,
  newId: string,
  merge: boolean,
  now: Date,
): Promise<void> {
  const raw = await loadRawSettings(store);
  if (!raw) return;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(doc) || !isRecord(doc.excludedProviders) || !Object.hasOwn(doc.excludedProviders, oldId)) return;

  const exclusions = { ...doc.excludedProviders } as Record<string, unknown>;
  const sourceList = Array.isArray(exclusions[oldId]) ? (exclusions[oldId] as unknown[]) : [];
  delete exclusions[oldId];
  const destinationList = Array.isArray(exclusions[newId]) ? (exclusions[newId] as unknown[]) : [];
  const merged = merge ? [...new Set([...destinationList, ...sourceList])] : sourceList;
  if (merged.length > 0) exclusions[newId] = merged;

  await store.redis.set(
    store.keys.settings,
    JSON.stringify({ ...doc, excludedProviders: exclusions, updatedAt: now.getTime() }),
  );
}

/**
 * Renames a group onto an id nobody uses yet, or merges it into an existing
 * one when `merge` is true (else 409 `exists`). A rename moves every
 * provider's events key (RENAME), the `usage:groups` entry (keeping its own
 * colour and first-seen), the `g` of its machines, and its
 * `excludedProviders` entry. A merge unions each provider's events key into
 * the destination's with `AGGREGATE MAX` — the same rule a snapshot's history
 * already reads by — keeps the destination's own group entry and exclusions
 * (unioning the source's providers into them), and moves the machines.
 */
export async function renameOrMergeGroup(
  store: TenantStore,
  groupId: string,
  newGroupId: string,
  merge: boolean,
  now: Date,
  options: { audit?: ManageAuditWriter } = {},
): Promise<RenameGroupResult> {
  const indexes = await loadIndexes(store);
  const groupsById = new Map(indexes.groups.map((group) => [group.groupId, group]));
  const source = groupsById.get(groupId);
  if (!source) return { ok: false, reason: "not_found" };
  if (groupId === newGroupId) return { ok: true, affected: NO_CHANGE };
  const destinationExists = groupsById.has(newGroupId);
  if (destinationExists && !merge) return { ok: false, reason: "exists" };

  const redis = store.redis;
  const providerIds = indexes.providers.map((provider) => provider.providerId);
  const srcKeys = providerIds.map((providerId) => store.keys.events(providerId, groupId));
  const destKeys = providerIds.map((providerId) => store.keys.events(providerId, newGroupId));

  let srcExists: number[] = [];
  let destExists: number[] = [];
  if (providerIds.length > 0) {
    const existence = redis.pipeline();
    for (const key of srcKeys) existence.exists(key);
    for (const key of destKeys) existence.exists(key);
    const results = ((await existence.exec()) as unknown[]).map(Number);
    srcExists = results.slice(0, providerIds.length);
    destExists = results.slice(providerIds.length);
  }

  let eventsTouched = 0;
  const activeIndexes = providerIds.map((_, index) => index).filter((index) => srcExists[index] === 1);
  if (activeIndexes.length > 0) {
    const cards = redis.pipeline();
    for (const index of activeIndexes) cards.zcard(srcKeys[index]!);
    const counts = ((await cards.exec()) as unknown[]).map(Number);
    eventsTouched = counts.reduce((sum, count) => sum + count, 0);
  }

  // A merge moves the source's reports into the destination's: the just-ended cycle's summary must
  // be written while the two groups' split is still readable. A plain rename moves nothing between
  // groups, so its summary would read the same.
  if (destinationExists && activeIndexes.length > 0) {
    await archiveBeforeChange(store, now, {
      indexes,
      providerIds: activeIndexes.map((index) => providerIds[index]!),
    });
  }

  const movedMachines = indexes.machines.filter((machine) => machine.groupId === groupId);
  const affected = { events: eventsTouched, machines: movedMachines.length, groups: 1 };
  // Only a merge is audited: a rename onto an unused id loses nothing.
  const audit =
    destinationExists && options.audit
      ? await options.audit({
          action: "group_merged",
          subject: { kind: "group", id: groupId, target: newGroupId },
          affected,
        })
      : null;

  const tx = redis.multi();
  for (const index of activeIndexes) {
    const srcKey = srcKeys[index]!;
    const destKey = destKeys[index]!;
    if (destExists[index] === 1) {
      tx.zunionstore(destKey, 2, [destKey, srcKey], { aggregate: "max" });
      // ZUNIONSTORE stores the union without an expiry: re-arm it like storeReport does.
      tx.expire(destKey, (RETENTION_DAYS + 1) * 86_400);
      tx.del(srcKey);
    } else {
      tx.rename(srcKey, destKey);
    }
    tx.sadd(store.keys.registry, destKey);
  }

  if (movedMachines.length > 0) {
    const machineEntries: Record<string, string> = {};
    for (const machine of movedMachines) {
      machineEntries[`${machine.providerId}:${machine.machineId}`] = machineEntry(
        newGroupId,
        machine.lastSeenAt,
        machine.lastTokens,
        machine.mode,
        machine.intervalMinutes,
        machine.archivedAt,
      );
    }
    tx.hset(store.keys.machines, machineEntries);
  }

  if (!destinationExists) {
    tx.hset(store.keys.groups, {
      [newGroupId]: serializeGroupEntry(source.color ?? randomGroupColor(), source.firstSeenAt, source.archivedAt),
    });
  }
  tx.hdel(store.keys.groups, groupId);
  if (audit) queueManageAudit(tx, store, audit);
  await tx.exec();

  await moveExclusionsInSettings(store, groupId, newGroupId, merge, now);

  return { ok: true, affected };
}

/** Counts the reports in `activeKeys` (in total and key by key) and finds the newest one, for the delete impact. */
async function countReports(
  store: TenantStore,
  activeKeys: string[],
): Promise<{ events: number; lastReportAt: number | null; counts: number[] }> {
  if (activeKeys.length === 0) return { events: 0, lastReportAt: null, counts: [] };
  const pipeline = store.redis.pipeline();
  for (const key of activeKeys) {
    pipeline.zcard(key);
    pipeline.zrange(key, -1, -1, { withScores: true });
  }
  const results = (await pipeline.exec()) as unknown[];
  let events = 0;
  let lastReportAt: number | null = null;
  const counts: number[] = [];
  for (let index = 0; index < activeKeys.length; index++) {
    counts.push(Number(results[index * 2]));
    events += counts[index]!;
    // [member, score] of the newest member.
    const score = Number((results[index * 2 + 1] as unknown[])[1]);
    if (Number.isFinite(score) && (lastReportAt === null || score > lastReportAt)) lastReportAt = score;
  }
  return { events, lastReportAt, counts };
}

/** What deleting `activeKeys` (their reports) and `machines` would remove, and how fresh both are; `counts` is the reports of each key. */
async function deleteImpact(
  store: TenantStore,
  activeKeys: string[],
  machines: { lastSeenAt: number }[],
  groups: number,
  now: Date,
): Promise<{ impact: DeleteImpact; counts: number[] }> {
  const { events, lastReportAt, counts } = await countReports(store, activeKeys);
  const recentSince = now.getTime() - RECENT_REPORT_MS;
  return {
    impact: {
      events,
      machines: machines.length,
      groups,
      lastReportAt,
      recentMachines: machines.filter((machine) => machine.lastSeenAt >= recentSince).length,
    },
    counts,
  };
}

/** The raw `usage:machines` entries of `fields` (the field's own bytes, for the trash to put back as they were); a field without one is left out. */
async function readRawMachines(store: TenantStore, fields: string[]): Promise<Record<string, string>> {
  if (fields.length === 0) return {};
  const reads = store.redis.pipeline();
  for (const field of fields) reads.hget(store.keys.machines, field);
  const values = (await reads.exec()) as unknown[];
  const raw: Record<string, string> = {};
  fields.forEach((field, index) => {
    const value = values[index];
    if (typeof value === "string") raw[field] = value;
  });
  return raw;
}

/** The delete's own login, for the trash entry: the audit entry the writer made says who (multi-tenant mode). */
function loginOf(audit: string | null): string | null {
  return audit ? (parseManageAuditRecord(audit)?.by ?? null) : null;
}

/** Removes a group's `excludedProviders` entry outright (used by `deleteGroup`); a no-op without one. */
async function removeExclusionsInSettings(store: TenantStore, groupId: string, now: Date): Promise<void> {
  const raw = await loadRawSettings(store);
  if (!raw) return;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(doc) || !isRecord(doc.excludedProviders) || !Object.hasOwn(doc.excludedProviders, groupId)) return;
  const exclusions = { ...doc.excludedProviders } as Record<string, unknown>;
  delete exclusions[groupId];
  await store.redis.set(
    store.keys.settings,
    JSON.stringify({ ...doc, excludedProviders: exclusions, updatedAt: now.getTime() }),
  );
}

/**
 * Deletes a group outright: without `force`, refuses (`has_events`) while any
 * provider still has stored events for it — the same rule PUT /api/settings
 * already applies to a group taken off the panel's list. With `force`,
 * moves every provider's events key for it into the trash (lib/trash.ts: kept 30
 * days, restorable; `trashId` in the answer), and deletes its `usage:groups`
 * entry, its machines' `usage:machines` fields, and its `excludedProviders`
 * entry (the trash keeps their contents). With
 * `options.dryRun` it only reports what that would remove: it neither refuses
 * nor archives nor writes.
 */
export async function deleteGroup(
  store: TenantStore,
  groupId: string,
  force: boolean,
  now: Date,
  options: DeleteOptions = {},
): Promise<DeleteWithEventsResult> {
  const indexes = await loadIndexes(store);
  const group = indexes.groups.find((candidate) => candidate.groupId === groupId);
  if (!group) return { ok: false, reason: "not_found" };

  const redis = store.redis;
  const providerIds = indexes.providers.map((provider) => provider.providerId);
  const keys = providerIds.map((providerId) => store.keys.events(providerId, groupId));

  let existsFlags: number[] = [];
  if (keys.length > 0) {
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.exists(key);
    existsFlags = ((await pipeline.exec()) as unknown[]).map(Number);
  }
  const activeKeys = keys.filter((_, index) => existsFlags[index] === 1);
  const machinesInGroup = indexes.machines.filter((machine) => machine.groupId === groupId);
  if (options.dryRun) {
    const { impact } = await deleteImpact(store, activeKeys, machinesInGroup, 1, now);
    return { ok: true, affected: { events: impact.events, machines: impact.machines, groups: 1 }, impact };
  }
  if (activeKeys.length > 0 && !force) return { ok: false, reason: "has_events" };
  const { impact, counts } = await deleteImpact(store, activeKeys, machinesInGroup, 1, now);
  const affected = { events: impact.events, machines: impact.machines, groups: 1 };
  // The events go with the group: archive the just-ended cycle first, while they can still be read.
  if (activeKeys.length > 0) {
    await archiveBeforeChange(store, now, {
      indexes,
      providerIds: providerIds.filter((_, index) => existsFlags[index] === 1),
    });
  }

  const machineFields = machinesInGroup.map((machine) => `${machine.providerId}:${machine.machineId}`);
  // Stored reports are moved into the trash (lib/trash.ts), not deleted: a group without any has nothing to restore.
  const trashId = activeKeys.length > 0 ? newTrashId() : null;
  const [rawGroup, rawMachines] = trashId
    ? await Promise.all([redis.hget(store.keys.groups, groupId), readRawMachines(store, machineFields)])
    : [null, {}];
  const audit = options.audit
    ? await options.audit({
        action: "group_deleted",
        subject: { kind: "group", id: groupId },
        affected,
        ...(trashId && { trashId }),
      })
    : null;

  const tx = redis.multi();
  if (trashId) {
    const refs: TrashKeyRef[] = [];
    providerIds.forEach((providerId, index) => {
      if (existsFlags[index] === 1) refs.push({ p: providerId, g: groupId, n: counts[refs.length]! });
    });
    queueTrash(
      tx,
      store,
      {
        v: 1,
        kind: "group",
        id: trashId,
        name: groupId,
        at: now.getTime(),
        by: loginOf(audit),
        n: affected,
        keys: refs,
        machines: rawMachines,
        group:
          typeof rawGroup === "string"
            ? rawGroup
            : serializeGroupEntry(group.color ?? randomGroupColor(), group.firstSeenAt),
        excluded: groupSettingsParts(indexes.settings, groupId).excluded ?? [],
      },
      now.getTime(),
    );
  }
  if (machineFields.length > 0) tx.hdel(store.keys.machines, ...machineFields);
  tx.hdel(store.keys.groups, groupId);
  if (audit) queueManageAudit(tx, store, audit);
  await tx.exec();

  await removeExclusionsInSettings(store, groupId, now);

  return { ok: true, affected, impact, ...(trashId && { trashId }) };
}

/** Strips `providerId` from `limits`, `subLimits`, `hiddenProviders` and every `excludedProviders` entry of the settings document; a no-op without a stored document or reference. */
async function scrubProviderInSettings(store: TenantStore, providerId: string, now: Date): Promise<void> {
  const raw = await loadRawSettings(store);
  if (!raw) return;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isRecord(doc)) return;

  let changed = false;
  const next: Record<string, unknown> = { ...doc };

  if (isRecord(doc.limits) && Object.hasOwn(doc.limits, providerId)) {
    const limits = { ...doc.limits };
    delete limits[providerId];
    next.limits = limits;
    changed = true;
  }
  if (isRecord(doc.subLimits) && Object.hasOwn(doc.subLimits, providerId)) {
    const subLimits = { ...doc.subLimits };
    delete subLimits[providerId];
    next.subLimits = subLimits;
    changed = true;
  }
  if (Array.isArray(doc.hiddenProviders) && doc.hiddenProviders.includes(providerId)) {
    next.hiddenProviders = doc.hiddenProviders.filter((id) => id !== providerId);
    changed = true;
  }
  if (isRecord(doc.excludedProviders)) {
    const exclusions: Record<string, unknown> = {};
    let exclusionsChanged = false;
    for (const [groupId, list] of Object.entries(doc.excludedProviders)) {
      if (!Array.isArray(list) || !list.includes(providerId)) {
        exclusions[groupId] = list;
        continue;
      }
      exclusionsChanged = true;
      const filtered = list.filter((id) => id !== providerId);
      if (filtered.length > 0) exclusions[groupId] = filtered;
    }
    if (exclusionsChanged) {
      next.excludedProviders = exclusions;
      changed = true;
    }
  }

  if (!changed) return;
  next.updatedAt = now.getTime();
  await store.redis.set(store.keys.settings, JSON.stringify(next));
}

/**
 * Deletes a provider outright: without `force`, refuses (`has_events`) while
 * any of its groups still has stored events. With `force`, moves its events
 * key in every group into the trash (lib/trash.ts: kept 30 days, restorable;
 * `trashId` in the answer), and deletes its `usage:providers` entry, its
 * machines' `usage:machines` fields, its `usage:official` fields (its own and
 * every sub-limit's) and its resets, and scrubs it from the settings document
 * (the trash keeps their contents). With
 * `options.dryRun` it only reports what that would remove: it neither refuses
 * nor archives nor writes.
 */
export async function deleteProvider(
  store: TenantStore,
  providerId: string,
  force: boolean,
  now: Date,
  options: DeleteOptions = {},
): Promise<DeleteWithEventsResult> {
  const indexes = await loadIndexes(store);
  const provider = indexes.providers.find((candidate) => candidate.providerId === providerId);
  if (!provider) return { ok: false, reason: "not_found" };

  const redis = store.redis;
  const groupIds = indexes.groups.map((group) => group.groupId);
  const keys = groupIds.map((groupId) => store.keys.events(providerId, groupId));

  let existsFlags: number[] = [];
  if (keys.length > 0) {
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.exists(key);
    existsFlags = ((await pipeline.exec()) as unknown[]).map(Number);
  }
  const activeKeys = keys.filter((_, index) => existsFlags[index] === 1);
  const activeGroupCount = activeKeys.length;
  const machinesOfProvider = indexes.machines.filter((machine) => machine.providerId === providerId);
  if (options.dryRun) {
    const { impact } = await deleteImpact(store, activeKeys, machinesOfProvider, activeGroupCount, now);
    return {
      ok: true,
      affected: { events: impact.events, machines: impact.machines, groups: activeGroupCount },
      impact,
    };
  }
  if (activeKeys.length > 0 && !force) return { ok: false, reason: "has_events" };
  const { impact, counts } = await deleteImpact(store, activeKeys, machinesOfProvider, activeGroupCount, now);
  const affected = { events: impact.events, machines: impact.machines, groups: activeGroupCount };
  // The events go with the provider: archive the just-ended cycle first, while they can still be read.
  if (activeKeys.length > 0) await archiveBeforeChange(store, now, { indexes, providerIds: [providerId] });

  const machineFields = machinesOfProvider.map((machine) => `${machine.providerId}:${machine.machineId}`);
  const officialFields = Object.keys(indexes.officialUsage).filter(
    (field) => field === providerId || field.startsWith(`${providerId}:`),
  );

  // Stored reports are moved into the trash (lib/trash.ts), not deleted: a provider without any has nothing to restore.
  const trashId = activeKeys.length > 0 ? newTrashId() : null;
  const [rawResets, rawMachines] = trashId
    ? await Promise.all([redis.hget(store.keys.resets, providerId), readRawMachines(store, machineFields)])
    : [null, {}];
  const audit = options.audit
    ? await options.audit({
        action: "provider_deleted",
        subject: { kind: "provider", id: providerId },
        affected,
        ...(trashId && { trashId }),
      })
    : null;

  const tx = redis.multi();
  if (trashId) {
    const refs: TrashKeyRef[] = [];
    groupIds.forEach((groupId, index) => {
      if (existsFlags[index] === 1) refs.push({ p: providerId, g: groupId, n: counts[refs.length]! });
    });
    const settingsParts = providerSettingsParts(indexes.settings, providerId);
    queueTrash(
      tx,
      store,
      {
        v: 1,
        kind: "provider",
        id: trashId,
        name: providerId,
        at: now.getTime(),
        by: loginOf(audit),
        n: affected,
        keys: refs,
        machines: rawMachines,
        firstSeen: provider.firstSeenAt,
        official: Object.fromEntries(officialFields.map((field) => [field, indexes.officialUsage[field]!])),
        resets: typeof rawResets === "string" ? rawResets : null,
        ...settingsParts,
      },
      now.getTime(),
    );
  }
  if (machineFields.length > 0) tx.hdel(store.keys.machines, ...machineFields);
  tx.hdel(store.keys.providers, providerId);
  if (officialFields.length > 0) tx.hdel(store.keys.officialUsage, ...officialFields);
  tx.hdel(store.keys.resets, providerId);
  if (audit) queueManageAudit(tx, store, audit);
  await tx.exec();

  await scrubProviderInSettings(store, providerId, now);

  return { ok: true, affected, impact, ...(trashId && { trashId }) };
}

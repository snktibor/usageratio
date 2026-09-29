import type { UsageEvent } from "@/lib/aggregate";
import type { ResetConfig, TokenMode } from "@/lib/config";
import { getCycle, getDaySegments } from "@/lib/cycle";
import { carryOver, type MergeCycle, type MergeUnit } from "@/lib/machine-merge";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { randomGroupColor, serializeGroupEntry } from "@/lib/settings";
import { eventMember, loadIndexes, loadRawSettings, parseEvent } from "@/lib/usage-store";

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
export type DeleteWithEventsResult =
  | { ok: true; affected: Affected }
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
async function readMembersForKeys(keys: string[]): Promise<Map<string, ParsedMember[]>> {
  const map = new Map<string, ParsedMember[]>();
  if (keys.length === 0) return map;
  const pipeline = getRedis().pipeline();
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
  providerId: string,
  machineId: string,
  target: { machineId?: string; groupId?: string },
  options: MoveMachineOptions,
): Promise<MoveMachineResult> {
  const indexes = await loadIndexes();
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
  const keys = groupIds.map((groupId) => KEYS.events(providerId, groupId));
  const membersByKey = await readMembersForKeys(keys);

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

  const destKey = KEYS.events(providerId, newGroupId);
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

  const tx = getRedis().multi();
  let eventsTouched = 0;
  for (const removal of removals) {
    if (removal.members.length === 0) continue;
    eventsTouched += removal.members.length;
    const [first, ...rest] = removal.members.map(({ member }) => member.raw) as [string, ...string[]];
    tx.zrem(removal.key, first, ...rest);
  }
  if (additions.length > 0) {
    const [first, ...rest] = additions as [{ score: number; member: string }, ...{ score: number; member: string }[]];
    tx.zadd(destKey, first, ...rest);
    tx.expire(destKey, (options.retentionDays + 1) * 86_400);
  }

  // The index keeps whichever of the two entries reported last, now under the new id and group.
  const newest = existing && existing.lastSeenAt > source.lastSeenAt ? existing : source;
  if (renamed) tx.hdel(KEYS.machines, `${providerId}:${machineId}`);
  tx.hset(KEYS.machines, {
    [`${providerId}:${newMachineId}`]: JSON.stringify({
      g: newGroupId,
      ts: newest.lastSeenAt,
      t: newest.lastTokens,
      ...(newest.mode === "manual" && { md: "manual" }),
      ...(newest.intervalMinutes != null && { iv: newest.intervalMinutes }),
    }),
  });
  await tx.exec();

  const groupsLeft = new Set(units.map((unit) => unit.groupId).filter((groupId) => groupId !== newGroupId));
  if (source.groupId !== newGroupId) groupsLeft.add(source.groupId);
  return {
    ok: true,
    affected: { events: eventsTouched, machines: existing ? 2 : 1, groups: groupsLeft.size },
  };
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
export async function deleteMachine(providerId: string, machineId: string): Promise<DeleteResult> {
  const indexes = await loadIndexes();
  const machine = indexes.machines.find((m) => m.providerId === providerId && m.machineId === machineId);
  if (!machine) return { ok: false, reason: "not_found" };

  const groupIds = indexes.groups.map((group) => group.groupId);
  const keys = groupIds.map((groupId) => KEYS.events(providerId, groupId));
  const membersByKey = await readMembersForKeys(keys);

  const tx = getRedis().multi();
  let eventsTouched = 0;
  for (const key of keys) {
    const matches = (membersByKey.get(key) ?? []).filter((entry) => entry.machineId === machineId);
    if (matches.length === 0) continue;
    eventsTouched += matches.length;
    tx.zrem(key, ...matches.map((entry) => entry.raw));
  }
  tx.hdel(KEYS.machines, `${providerId}:${machineId}`);
  await tx.exec();

  return { ok: true, affected: { events: eventsTouched, machines: 1, groups: 0 } };
}

/** Silent machines dropped from the index (not their stored reports), across every provider. Mirrors lib/housekeeping.ts's own machine step, triggered on demand. */
export async function pruneMachines(now: Date, inactiveDays: number): Promise<{ removedIds: string[] }> {
  const indexes = await loadIndexes();
  const cutoffMs = now.getTime() - inactiveDays * 86_400_000;
  const stale = indexes.machines.filter((machine) => machine.lastSeenAt < cutoffMs);
  const fields = stale.map((machine) => `${machine.providerId}:${machine.machineId}`);
  if (fields.length > 0) await getRedis().hdel(KEYS.machines, ...fields);
  return { removedIds: fields };
}

/** Moves (or merges) a group's `excludedProviders` entry in the settings document; a no-op without a stored document or exclusion. */
async function moveExclusionsInSettings(oldId: string, newId: string, merge: boolean, now: Date): Promise<void> {
  const raw = await loadRawSettings();
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

  await getRedis().set(
    KEYS.settings,
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
  groupId: string,
  newGroupId: string,
  merge: boolean,
  now: Date,
): Promise<RenameGroupResult> {
  const indexes = await loadIndexes();
  const groupsById = new Map(indexes.groups.map((group) => [group.groupId, group]));
  const source = groupsById.get(groupId);
  if (!source) return { ok: false, reason: "not_found" };
  if (groupId === newGroupId) return { ok: true, affected: NO_CHANGE };
  const destinationExists = groupsById.has(newGroupId);
  if (destinationExists && !merge) return { ok: false, reason: "exists" };

  const redis = getRedis();
  const providerIds = indexes.providers.map((provider) => provider.providerId);
  const srcKeys = providerIds.map((providerId) => KEYS.events(providerId, groupId));
  const destKeys = providerIds.map((providerId) => KEYS.events(providerId, newGroupId));

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

  const tx = redis.multi();
  for (const index of activeIndexes) {
    const srcKey = srcKeys[index]!;
    const destKey = destKeys[index]!;
    if (destExists[index] === 1) {
      tx.zunionstore(destKey, 2, [destKey, srcKey], { aggregate: "max" });
      tx.del(srcKey);
    } else {
      tx.rename(srcKey, destKey);
    }
  }

  const movedMachines = indexes.machines.filter((machine) => machine.groupId === groupId);
  if (movedMachines.length > 0) {
    const machineEntries: Record<string, string> = {};
    for (const machine of movedMachines) {
      machineEntries[`${machine.providerId}:${machine.machineId}`] = JSON.stringify({
        g: newGroupId,
        ts: machine.lastSeenAt,
        t: machine.lastTokens,
      });
    }
    tx.hset(KEYS.machines, machineEntries);
  }

  if (!destinationExists) {
    tx.hset(KEYS.groups, { [newGroupId]: serializeGroupEntry(source.color ?? randomGroupColor(), source.firstSeenAt) });
  }
  tx.hdel(KEYS.groups, groupId);
  await tx.exec();

  await moveExclusionsInSettings(groupId, newGroupId, merge, now);

  return { ok: true, affected: { events: eventsTouched, machines: movedMachines.length, groups: 1 } };
}

/** Removes a group's `excludedProviders` entry outright (used by `deleteGroup`); a no-op without one. */
async function removeExclusionsInSettings(groupId: string, now: Date): Promise<void> {
  const raw = await loadRawSettings();
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
  await getRedis().set(
    KEYS.settings,
    JSON.stringify({ ...doc, excludedProviders: exclusions, updatedAt: now.getTime() }),
  );
}

/**
 * Deletes a group outright: without `force`, refuses (`has_events`) while any
 * provider still has stored events for it — the same rule PUT /api/settings
 * already applies to a group taken off the panel's list. With `force`,
 * deletes every provider's events key for it, its `usage:groups` entry, its
 * machines' `usage:machines` fields, and its `excludedProviders` entry.
 */
export async function deleteGroup(groupId: string, force: boolean, now: Date): Promise<DeleteWithEventsResult> {
  const indexes = await loadIndexes();
  const group = indexes.groups.find((candidate) => candidate.groupId === groupId);
  if (!group) return { ok: false, reason: "not_found" };

  const redis = getRedis();
  const providerIds = indexes.providers.map((provider) => provider.providerId);
  const keys = providerIds.map((providerId) => KEYS.events(providerId, groupId));

  let existsFlags: number[] = [];
  if (keys.length > 0) {
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.exists(key);
    existsFlags = ((await pipeline.exec()) as unknown[]).map(Number);
  }
  const activeKeys = keys.filter((_, index) => existsFlags[index] === 1);
  if (activeKeys.length > 0 && !force) return { ok: false, reason: "has_events" };

  let eventsTouched = 0;
  if (activeKeys.length > 0) {
    const cards = redis.pipeline();
    for (const key of activeKeys) cards.zcard(key);
    eventsTouched = ((await cards.exec()) as unknown[]).map(Number).reduce((sum, count) => sum + count, 0);
  }

  const machinesInGroup = indexes.machines.filter((machine) => machine.groupId === groupId);
  const machineFields = machinesInGroup.map((machine) => `${machine.providerId}:${machine.machineId}`);

  const tx = redis.multi();
  for (const key of activeKeys) tx.del(key);
  if (machineFields.length > 0) tx.hdel(KEYS.machines, ...machineFields);
  tx.hdel(KEYS.groups, groupId);
  await tx.exec();

  await removeExclusionsInSettings(groupId, now);

  return { ok: true, affected: { events: eventsTouched, machines: machineFields.length, groups: 1 } };
}

/** Strips `providerId` from `limits`, `subLimits`, `hiddenProviders` and every `excludedProviders` entry of the settings document; a no-op without a stored document or reference. */
async function scrubProviderInSettings(providerId: string, now: Date): Promise<void> {
  const raw = await loadRawSettings();
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
  await getRedis().set(KEYS.settings, JSON.stringify(next));
}

/**
 * Deletes a provider outright: without `force`, refuses (`has_events`) while
 * any of its groups still has stored events. With `force`, deletes its
 * events key in every group, its `usage:providers` entry, its machines'
 * `usage:machines` fields, its `usage:official` fields (its own and every
 * sub-limit's), and scrubs it from the settings document.
 */
export async function deleteProvider(providerId: string, force: boolean, now: Date): Promise<DeleteWithEventsResult> {
  const indexes = await loadIndexes();
  const known = indexes.providers.some((provider) => provider.providerId === providerId);
  if (!known) return { ok: false, reason: "not_found" };

  const redis = getRedis();
  const groupIds = indexes.groups.map((group) => group.groupId);
  const keys = groupIds.map((groupId) => KEYS.events(providerId, groupId));

  let existsFlags: number[] = [];
  if (keys.length > 0) {
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.exists(key);
    existsFlags = ((await pipeline.exec()) as unknown[]).map(Number);
  }
  const activeKeys = keys.filter((_, index) => existsFlags[index] === 1);
  const activeGroupCount = existsFlags.filter((flag) => flag === 1).length;
  if (activeKeys.length > 0 && !force) return { ok: false, reason: "has_events" };

  let eventsTouched = 0;
  if (activeKeys.length > 0) {
    const cards = redis.pipeline();
    for (const key of activeKeys) cards.zcard(key);
    eventsTouched = ((await cards.exec()) as unknown[]).map(Number).reduce((sum, count) => sum + count, 0);
  }

  const machinesOfProvider = indexes.machines.filter((machine) => machine.providerId === providerId);
  const machineFields = machinesOfProvider.map((machine) => `${machine.providerId}:${machine.machineId}`);
  const officialFields = Object.keys(indexes.officialUsage).filter(
    (field) => field === providerId || field.startsWith(`${providerId}:`),
  );

  const tx = redis.multi();
  for (const key of activeKeys) tx.del(key);
  if (machineFields.length > 0) tx.hdel(KEYS.machines, ...machineFields);
  tx.hdel(KEYS.providers, providerId);
  if (officialFields.length > 0) tx.hdel(KEYS.officialUsage, ...officialFields);
  await tx.exec();

  await scrubProviderInSettings(providerId, now);

  return { ok: true, affected: { events: eventsTouched, machines: machineFields.length, groups: activeGroupCount } };
}

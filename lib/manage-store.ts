import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { randomGroupColor, serializeGroupEntry } from "@/lib/settings";
import { loadIndexes, loadRawSettings } from "@/lib/usage-store";

/**
 * Renaming, merging and deleting the things the dashboard auto-registers:
 * machines, groups and providers. Nothing here runs on the hot report path
 * (lib/usage-store.ts `storeReport`); these are the settings panel's manual
 * "manage" actions, gated by session + sudo at the route layer
 * (app/api/machines, app/api/groups, app/api/providers).
 *
 * No machine merge exists: two snapshot series combined would be read back as
 * a max, not a sum, silently losing tokens. A group merge is fine — its ZSETs
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

export type RenameMachineResult = { ok: true; affected: Affected } | { ok: false; reason: "not_found" | "exists" };
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
 * Renames one machine, for one provider only: its own events key is per
 * provider+group, so a machine reporting to several providers is renamed
 * provider by provider (the route loops when a caller wants all of them).
 * Rewrites its members in every group's events key of this provider and moves
 * its `usage:machines` field. Refuses (`exists`) onto an id already used by
 * this provider — see the module comment on why there is no merge.
 */
export async function renameMachine(
  providerId: string,
  machineId: string,
  newMachineId: string,
): Promise<RenameMachineResult> {
  const indexes = await loadIndexes();
  const machine = indexes.machines.find((m) => m.providerId === providerId && m.machineId === machineId);
  if (!machine) return { ok: false, reason: "not_found" };
  if (machineId === newMachineId) return { ok: true, affected: NO_CHANGE };
  const collides = indexes.machines.some((m) => m.providerId === providerId && m.machineId === newMachineId);
  if (collides) return { ok: false, reason: "exists" };

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
    const additions = matches.map((entry) => ({
      score: entry.score,
      member: rewriteMemberMachineId(entry.raw, newMachineId),
    }));
    const [first, ...rest] = additions as [{ score: number; member: string }, ...{ score: number; member: string }[]];
    tx.zadd(key, first, ...rest);
  }
  tx.hdel(KEYS.machines, `${providerId}:${machineId}`);
  tx.hset(KEYS.machines, {
    [`${providerId}:${newMachineId}`]: JSON.stringify({
      g: machine.groupId,
      ts: machine.lastSeenAt,
      t: machine.lastTokens,
    }),
  });
  await tx.exec();

  return { ok: true, affected: { events: eventsTouched, machines: 1, groups: 0 } };
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

import { randomBytes } from "node:crypto";
import { rederiveArchivedCycles } from "@/lib/archive";
import { MAX_MACHINES, RETENTION_DAYS, TRASH_RETENTION_DAYS } from "@/lib/config";
import { log } from "@/lib/log";
import { type ManageAuditWriter, queueManageAudit } from "@/lib/manage-audit";
import type { Affected } from "@/lib/manage-store";
import { MAX_PROVIDERS } from "@/lib/providers";
import { MAX_GROUPS, PRESET_COLORS, parseGroupEntry } from "@/lib/settings";
import type { TenantStore } from "@/lib/tenant";
import { loadIndexes } from "@/lib/usage-store";

/**
 * The trash: what a forced delete of a group or a provider takes with it stays recoverable for
 * TRASH_RETENTION_DAYS. The delete RENAMEs each events key to `trash:{id}:events:{provider}:{group}`
 * (O(1), the members untouched), and stores what else it removed (index entries, the machines'
 * entries, the settings parts) as one meta document, `trash:{id}`; `usage:trash` indexes the
 * entries by deletion time. Everything expires together after the retention (`EXPIRE` after every
 * RENAME, which carries the key's own, shorter or longer, TTL), and housekeeping trims the index
 * and the registry names afterwards (`trimTrash`).
 *
 * A restore never RENAMEs back: a report may have re-created the group or provider meanwhile, so
 * it unions the trashed reports into the live key (`AGGREGATE MAX`, the rule a group merge reads
 * by) and puts the index entries back only where none exists (`HSETNX`), so what is live wins.
 * It then re-derives the archived cycle summaries written while the entry was away
 * (lib/archive.ts `rederiveArchivedCycles`), and only then takes the entry out of the trash, in the
 * transaction that audits the restore: a restore that fails half way is simply run again.
 *
 * The key layout is in lib/redis-keys.ts.
 */

export { TRASH_RETENTION_DAYS };
/** The most entries the list returns, newest first. */
export const TRASH_LIST_LIMIT = 100;
/** `newTrashId`: 12 random bytes, base64url. */
export const TRASH_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;

const DAY_MS = 86_400_000;
const TRASH_TTL_SECONDS = TRASH_RETENTION_DAYS * 86_400;

export function newTrashId(): string {
  return randomBytes(12).toString("base64url");
}

/** One events key the delete moved: `events(p, g)`, with how many reports it held. */
export interface TrashKeyRef {
  p: string;
  g: string;
  n: number;
}

interface TrashMetaBase {
  v: 1;
  /** The trash id: the key names carry it. */
  id: string;
  /** The deleted group's or provider's own id. */
  name: string;
  /** Deleted at (ms). */
  at: number;
  /** Multi-tenant mode: the login that deleted it. */
  by: string | null;
  n: Affected;
  keys: TrashKeyRef[];
  /** `usage:machines` field → the raw entry it held. */
  machines: Record<string, string>;
}

export interface GroupTrashMeta extends TrashMetaBase {
  kind: "group";
  /** The raw `usage:groups` entry. */
  group: string;
  /** Its `excludedProviders` entry in the settings document. */
  excluded: string[];
}

export interface ProviderTrashMeta extends TrashMetaBase {
  kind: "provider";
  /** Its `usage:providers` value (first-seen ms). */
  firstSeen: number;
  /** `usage:official` field → the raw entry. */
  official: Record<string, string>;
  /** The raw `usage:resets` document; null without one. */
  resets: string | null;
  /** Its entries in the settings document, as they were stored (`limits`, `subLimits`). */
  limit?: unknown;
  subLimits?: unknown;
  hidden: boolean;
  /** The groups whose `excludedProviders` entry named it. */
  excludedIn: string[];
}

export type TrashMeta = GroupTrashMeta | ProviderTrashMeta;

export interface TrashEntry {
  id: string;
  kind: "group" | "provider";
  name: string;
  deletedAt: number;
  expiresAt: number;
  by: string | null;
  affected: Affected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

export function serializeTrashMeta(meta: TrashMeta): string {
  return JSON.stringify({
    v: 1,
    kind: meta.kind,
    id: meta.id,
    name: meta.name,
    at: meta.at,
    ...(meta.by !== null && { by: meta.by }),
    n: { e: meta.n.events, m: meta.n.machines, g: meta.n.groups },
    keys: meta.keys,
    machines: meta.machines,
    ...(meta.kind === "group"
      ? { group: meta.group, ...(meta.excluded.length > 0 && { excluded: meta.excluded }) }
      : {
          firstSeen: meta.firstSeen,
          official: meta.official,
          resets: meta.resets,
          ...(meta.limit !== undefined && { limit: meta.limit }),
          ...(meta.subLimits !== undefined && { subLimits: meta.subLimits }),
          hidden: meta.hidden,
          excludedIn: meta.excludedIn,
        }),
  });
}

/** A stored meta (the client does not deserialize, lib/redis.ts); null when it is none, or no readable meta of this version. */
export function parseTrashMeta(raw: unknown): TrashMeta | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1) return null;
  const { kind, id, name, at, by, n, keys, machines } = value;
  if (kind !== "group" && kind !== "provider") return null;
  if (typeof id !== "string" || typeof name !== "string" || !isFiniteNumber(at)) return null;
  if (!isRecord(n) || ![n.e, n.m, n.g].every(isFiniteNumber)) return null;
  if (!Array.isArray(keys) || !isStringRecord(machines)) return null;
  const refs: TrashKeyRef[] = [];
  for (const ref of keys) {
    if (!isRecord(ref) || typeof ref.p !== "string" || typeof ref.g !== "string" || !isFiniteNumber(ref.n)) return null;
    refs.push({ p: ref.p, g: ref.g, n: ref.n });
  }
  const base = {
    v: 1 as const,
    id,
    name,
    at,
    by: typeof by === "string" ? by : null,
    n: { events: n.e as number, machines: n.m as number, groups: n.g as number },
    keys: refs,
    machines,
  };
  if (kind === "group") {
    if (typeof value.group !== "string") return null;
    if (value.excluded !== undefined && !isStringList(value.excluded)) return null;
    return { ...base, kind, group: value.group, excluded: (value.excluded as string[] | undefined) ?? [] };
  }
  if (!isFiniteNumber(value.firstSeen) || !isStringRecord(value.official)) return null;
  if (value.resets !== null && typeof value.resets !== "string") return null;
  if (typeof value.hidden !== "boolean" || !isStringList(value.excludedIn)) return null;
  return {
    ...base,
    kind,
    firstSeen: value.firstSeen,
    official: value.official,
    resets: value.resets,
    ...(value.limit !== undefined && { limit: value.limit }),
    ...(value.subLimits !== undefined && { subLimits: value.subLimits }),
    hidden: value.hidden,
    excludedIn: value.excludedIn,
  };
}

/** The names a trash entry adds to the key registry: its meta and every events key it holds. */
function trashNames(store: TenantStore, meta: TrashMeta): string[] {
  return [store.keys.trashEntry(meta.id), ...meta.keys.map(({ p, g }) => store.keys.trashEvents(meta.id, p, g))];
}

/**
 * Queues the move into the trash in the delete's transaction `tx`: each events key RENAMEd under
 * the entry with the retention's expiry (RENAME carries the old key's own, up to 71 days), the
 * meta with its expiry, the index entry and the registry names, which are in the same transaction
 * so deleting a tenant finds them. Returns the names registered.
 */
export function queueTrash(
  tx: ReturnType<TenantStore["redis"]["multi"]>,
  store: TenantStore,
  meta: TrashMeta,
  nowMs: number,
): string[] {
  for (const { p, g } of meta.keys) {
    const trashKey = store.keys.trashEvents(meta.id, p, g);
    tx.rename(store.keys.events(p, g), trashKey);
    tx.expire(trashKey, TRASH_TTL_SECONDS);
  }
  tx.set(store.keys.trashEntry(meta.id), serializeTrashMeta(meta), { ex: TRASH_TTL_SECONDS });
  tx.zadd(store.keys.trash, { score: nowMs, member: meta.id });
  const names = trashNames(store, meta);
  tx.sadd(store.keys.registry, ...(names as [string, ...string[]]));
  return names;
}

// ── The settings document's parts ────────────────────────────────────────────

function parseSettingsDocument(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const doc: unknown = JSON.parse(raw);
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** A group's `excludedProviders` entry in the stored settings document (absent: none). */
export function groupSettingsParts(raw: string | null, groupId: string): { excluded?: string[] } {
  const doc = parseSettingsDocument(raw);
  const list = doc && isRecord(doc.excludedProviders) ? doc.excludedProviders[groupId] : undefined;
  if (!Array.isArray(list)) return {};
  return { excluded: list.filter((id): id is string => typeof id === "string") };
}

/** A provider's entries in the stored settings document: its limit and sub-limits as stored, whether it is hidden, the groups that exclude it. */
export function providerSettingsParts(
  raw: string | null,
  providerId: string,
): { limit?: unknown; subLimits?: unknown; hidden: boolean; excludedIn: string[] } {
  const doc = parseSettingsDocument(raw);
  if (!doc) return { hidden: false, excludedIn: [] };
  const own = (record: unknown) =>
    isRecord(record) && Object.hasOwn(record, providerId) ? record[providerId] : undefined;
  const limit = own(doc.limits);
  const subLimits = own(doc.subLimits);
  const excludedIn = isRecord(doc.excludedProviders)
    ? Object.entries(doc.excludedProviders)
        .filter(([, list]) => Array.isArray(list) && list.includes(providerId))
        .map(([groupId]) => groupId)
    : [];
  return {
    ...(limit !== undefined && { limit }),
    ...(subLimits !== undefined && { subLimits }),
    hidden: Array.isArray(doc.hiddenProviders) && doc.hiddenProviders.includes(providerId),
    excludedIn,
  };
}

/**
 * The settings document with a trash entry's parts put back where they are absent; null when
 * nothing changes (no stored document, an unreadable one, or everything already there). A group's
 * exclusions are unioned into what is there. A provider's limit and sub-limits come back only
 * where it has none now; it is hidden again only when it was not live (one a user re-created and
 * switched on stays on); it is excluded again only from groups that still exist. Pure.
 */
export function withRestoredSettings(
  raw: string | null,
  meta: TrashMeta,
  live: { providerLive: boolean; groupIds: string[] },
  nowMs: number,
): string | null {
  const doc = parseSettingsDocument(raw);
  if (!doc) return null;
  const next: Record<string, unknown> = { ...doc };
  let changed = false;

  const exclusions = isRecord(doc.excludedProviders) ? { ...doc.excludedProviders } : {};
  const addExclusions = (groupId: string, providerIds: string[]) => {
    const current = Array.isArray(exclusions[groupId]) ? (exclusions[groupId] as unknown[]) : [];
    const union = [...new Set([...current, ...providerIds])];
    if (union.length === current.length) return;
    exclusions[groupId] = union;
    next.excludedProviders = exclusions;
    changed = true;
  };

  if (meta.kind === "group") {
    addExclusions(meta.name, meta.excluded);
  } else {
    const setIfAbsent = (field: "limits" | "subLimits", value: unknown) => {
      if (value === undefined) return;
      const stored = doc[field];
      const record: Record<string, unknown> = isRecord(stored) ? stored : {};
      if (Object.hasOwn(record, meta.name)) return;
      next[field] = { ...record, [meta.name]: value };
      changed = true;
    };
    setIfAbsent("limits", meta.limit);
    setIfAbsent("subLimits", meta.subLimits);
    const hidden = Array.isArray(doc.hiddenProviders) ? doc.hiddenProviders : [];
    if (meta.hidden && !live.providerLive && !hidden.includes(meta.name)) {
      next.hiddenProviders = [...hidden, meta.name];
      changed = true;
    }
    for (const groupId of meta.excludedIn) {
      if (live.groupIds.includes(groupId)) addExclusions(groupId, [meta.name]);
    }
  }
  return changed ? JSON.stringify({ ...next, updatedAt: nowMs }) : null;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** One entry's meta; null when it is gone (expired, purged) or unreadable (logged). */
async function readMeta(store: TenantStore, id: string): Promise<TrashMeta | null> {
  const raw = await store.redis.get(store.keys.trashEntry(id));
  if (raw === null) return null;
  const meta = parseTrashMeta(raw);
  // A meta that names another id would put its keys under the wrong names: treat it like a damaged one.
  if (!meta || meta.id !== id) {
    log.warn("trash.meta_unreadable", { trashId: id });
    return null;
  }
  return meta;
}

const entryOf = (meta: TrashMeta): TrashEntry => ({
  id: meta.id,
  kind: meta.kind,
  name: meta.name,
  deletedAt: meta.at,
  expiresAt: meta.at + TRASH_RETENTION_DAYS * DAY_MS,
  by: meta.by,
  affected: meta.n,
});

/** The recently deleted groups and providers, newest first (at most TRASH_LIST_LIMIT); an id whose meta has expired or is unreadable is left out. */
export async function listTrash(store: TenantStore): Promise<TrashEntry[]> {
  const ids = ((await store.redis.zrange(store.keys.trash, 0, TRASH_LIST_LIMIT - 1, { rev: true })) as unknown[]).map(
    String,
  );
  if (ids.length === 0) return [];
  const metas = (await store.redis.mget(...ids.map((id) => store.keys.trashEntry(id)))) as unknown[];
  return ids.flatMap((id, index) => {
    const meta = parseTrashMeta(metas[index]);
    return meta && meta.id === id ? [entryOf(meta)] : [];
  });
}

// ── Restore ──────────────────────────────────────────────────────────────────

export type RestoreResult =
  | {
      ok: true;
      kind: "group" | "provider";
      id: string;
      restored: { events: number; machines: number };
      /** The group or provider (or one of its events keys) was live: the restore joined what had arrived since. */
      merged: boolean;
      /** Group restores: the effective entry's colour and the exclusions after the union. */
      group?: { id: string; color: string; excluded: string[] };
    }
  | { ok: false; reason: "not_found" | "too_many_groups" | "too_many_providers" | "too_many_machines" };

/**
 * Puts a recently deleted group or provider back (see the header for how it meets what is live).
 * Refuses past the caps the report path refuses at (`too_many_*`, nothing written), and answers
 * `not_found` for an id that is unknown, expired, purged or unreadable.
 *
 * Two transactions: the first puts the data back, the second takes the entry out of the trash and
 * audits the restore. Everything the first does is idempotent (a union, `HSETNX`), so a failure in
 * either leaves the entry in the trash and the restore to be run again.
 */
export async function restoreTrash(
  store: TenantStore,
  id: string,
  now: Date,
  options: { audit?: ManageAuditWriter } = {},
): Promise<RestoreResult> {
  const redis = store.redis;
  const meta = await readMeta(store, id);
  if (!meta) return { ok: false, reason: "not_found" };

  const indexes = await loadIndexes(store);
  const nowMs = now.getTime();
  const retentionCutoffMs = nowMs - RETENTION_DAYS * DAY_MS;
  const checks = redis.pipeline();
  for (const { p, g } of meta.keys) {
    checks.zcard(store.keys.trashEvents(id, p, g));
    // What the restore will keep: past the retention is pruned the moment it is unioned in.
    checks.zcount(store.keys.trashEvents(id, p, g), `(${retentionCutoffMs}`, "+inf");
    checks.exists(store.keys.events(p, g));
  }
  const results = meta.keys.length > 0 ? ((await checks.exec()) as unknown[]).map(Number) : [];
  const keys = meta.keys.map((ref, index) => ({
    ref,
    live: store.keys.events(ref.p, ref.g),
    trashed: store.keys.trashEvents(id, ref.p, ref.g),
    count: results[index * 3]!,
    restorable: results[index * 3 + 1]!,
    liveExists: results[index * 3 + 2] === 1,
  }));
  const kept = keys.filter((key) => key.count > 0);

  const liveGroupIds = indexes.groups.map((group) => group.groupId);
  const liveProviderIds = indexes.providers.map((provider) => provider.providerId);
  const groupLive = meta.kind === "group" && liveGroupIds.includes(meta.name);
  const providerLive = meta.kind === "provider" && liveProviderIds.includes(meta.name);

  // A group restore leaves the machines of a provider that is gone: that would bring the provider back by the back door.
  const machineFields = Object.keys(meta.machines).filter(
    (field) => meta.kind === "provider" || liveProviderIds.includes(field.slice(0, Math.max(field.indexOf(":"), 0))),
  );
  const liveMachineFields = new Set(indexes.machines.map((machine) => `${machine.providerId}:${machine.machineId}`));
  const newMachineFields = machineFields.filter((field) => !liveMachineFields.has(field));

  if (meta.kind === "group" && !groupLive && indexes.groups.length >= MAX_GROUPS) {
    return { ok: false, reason: "too_many_groups" };
  }
  if (meta.kind === "provider" && !providerLive && indexes.providers.length >= MAX_PROVIDERS) {
    return { ok: false, reason: "too_many_providers" };
  }
  if (indexes.machines.length + newMachineFields.length > MAX_MACHINES) {
    return { ok: false, reason: "too_many_machines" };
  }

  const nextSettings = withRestoredSettings(indexes.settings, meta, { providerLive, groupIds: liveGroupIds }, nowMs);

  const restore = redis.multi();
  for (const { live, trashed } of kept) {
    // Never RENAME back: a report since may have created `live`. The union is idempotent, and a report racing this transaction lands before it (in `live`) or after (into the restored key).
    restore.zunionstore(live, 2, [live, trashed], { aggregate: "max" });
    // Exactly storeReport's prune, and the expiry the union dropped.
    restore.zremrangebyscore(live, 0, retentionCutoffMs);
    restore.expire(live, (RETENTION_DAYS + 1) * 86_400);
    restore.sadd(store.keys.registry, live);
  }
  if (meta.kind === "group") {
    restore.hsetnx(store.keys.groups, meta.name, meta.group);
  } else {
    restore.hsetnx(store.keys.providers, meta.name, String(meta.firstSeen));
    for (const [field, raw] of Object.entries(meta.official)) restore.hsetnx(store.keys.officialUsage, field, raw);
    if (meta.resets !== null) restore.hsetnx(store.keys.resets, meta.name, meta.resets);
  }
  for (const field of machineFields) restore.hsetnx(store.keys.machines, field, meta.machines[field]!);
  if (nextSettings !== null) restore.set(store.keys.settings, nextSettings);
  await restore.exec();

  // Best effort, and after the restore has committed: it logs and returns what it managed.
  const rederived = await rederiveArchivedCycles(store, [...new Set(kept.map(({ ref }) => ref.p))], meta.at, now, {
    archiveMissing: meta.kind === "provider",
  });

  const audit = options.audit
    ? await options.audit({
        action: "trash_restored",
        subject: { kind: meta.kind, id: meta.name },
        affected: meta.n,
        trashId: id,
        rederived,
      })
    : null;
  const cleanup = redis.multi();
  cleanup.del(store.keys.trashEntry(id), ...keys.map(({ trashed }) => trashed));
  cleanup.zrem(store.keys.trash, id);
  cleanup.srem(store.keys.registry, ...(trashNames(store, meta) as [string, ...string[]]));
  if (audit) queueManageAudit(cleanup, store, audit);
  await cleanup.exec();

  const events = kept.reduce((sum, key) => sum + key.restorable, 0);
  const merged = groupLive || providerLive || kept.some(({ liveExists }) => liveExists);
  return {
    ok: true,
    kind: meta.kind,
    id: meta.name,
    restored: { events, machines: newMachineFields.length },
    merged,
    ...(meta.kind === "group" && {
      group: {
        id: meta.name,
        color:
          (groupLive ? indexes.groups.find((group) => group.groupId === meta.name)?.color : null) ??
          parseGroupEntry(meta.name, meta.group).color ??
          PRESET_COLORS[0],
        excluded: groupSettingsParts(nextSettings ?? indexes.settings, meta.name).excluded ?? [],
      },
    }),
  };
}

// ── Purge and trim ───────────────────────────────────────────────────────────

/** Deletes a recently deleted entry for good, before its retention runs out. Idempotent: a second call finds nothing (`not_found`). */
export async function purgeTrash(
  store: TenantStore,
  id: string,
  options: { audit?: ManageAuditWriter } = {},
): Promise<{ ok: true; affected: Affected } | { ok: false; reason: "not_found" }> {
  const meta = await readMeta(store, id);
  if (!meta) return { ok: false, reason: "not_found" };

  const audit = options.audit
    ? await options.audit({
        action: "trash_purged",
        subject: { kind: meta.kind, id: meta.name },
        affected: meta.n,
        trashId: id,
      })
    : null;
  const names = trashNames(store, meta);
  const tx = store.redis.multi();
  tx.del(...(names as [string, ...string[]]));
  tx.zrem(store.keys.trash, id);
  tx.srem(store.keys.registry, ...(names as [string, ...string[]]));
  if (audit) queueManageAudit(tx, store, audit);
  await tx.exec();
  return { ok: true, affected: meta.n };
}

/**
 * Housekeeping's step: the index ids older than the retention (their keys have expired on their
 * own), with every registry name of theirs, which `registryNames` lists. Dropping the names is safe
 * because a trash id is random and never written again. `dryRun` only counts.
 */
export async function trimTrash(
  store: TenantStore,
  now: Date,
  registryNames: string[],
  dryRun: boolean,
): Promise<{ removed: number; ids: string[] }> {
  const redis = store.redis;
  const cutoffMs = now.getTime() - TRASH_RETENTION_DAYS * DAY_MS;
  const ids = ((await redis.zrange(store.keys.trash, "-inf", `(${cutoffMs}`, { byScore: true })) as unknown[]).map(
    String,
  );
  if (ids.length === 0) return { removed: 0, ids };
  if (!dryRun) {
    const expired = new Set(ids);
    const entryPrefix = store.keys.trashEntry("");
    // `trash:{id}` and `trash:{id}:events:…`: the id is whatever follows the prefix up to the next colon.
    const names = registryNames.filter(
      (name) => name.startsWith(entryPrefix) && expired.has(name.slice(entryPrefix.length).split(":", 1)[0]!),
    );
    if (names.length > 0) {
      await redis.del(...(names as [string, ...string[]]));
      await redis.srem(store.keys.registry, ...(names as [string, ...string[]]));
    }
    await redis.zrem(store.keys.trash, ...(ids as [string, ...string[]]));
  }
  return { removed: ids.length, ids };
}

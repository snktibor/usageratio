import { ACCOUNT_EXPORT_FORMAT, ACCOUNT_EXPORT_VERSION } from "@/lib/account-export";
import { RETENTION_DAYS, WORKSPACE_QUOTAS } from "@/lib/config";
import { HISTORY_RETENTION, parseCycleSummary } from "@/lib/history";
import { ownedWorkspaceCount } from "@/lib/members";
import { parseStoredOfficialEntry } from "@/lib/official-usage";
import { normalizeProviderId } from "@/lib/providers";
import { countMachines, growsPast, type MachineCounting, type Quotas } from "@/lib/quotas";
import { isSubLimitId } from "@/lib/sub-limits";
import { type TenantStore, tenantStore } from "@/lib/tenant";
import { deleteTenant } from "@/lib/tenant-deletion";
import type { TenantId } from "@/lib/tenant-id";
import { parseEvent, parseMachine } from "@/lib/usage-store";
import { createTenantFor } from "@/lib/users";
import { isValidId } from "@/lib/validation";

/**
 * POST /api/import: one workspace of an account export (lib/account-export.ts)
 * loaded into an empty workspace, so its usage can be seen again: a new
 * workspace in multi-tenant mode, the instance itself on a single-user one.
 *
 * What comes back is the usage: the settings, providers, groups, machines,
 * official readings, usage restarts, the raw reports still inside the
 * retention window, and every archived cycle (the history and the all-time
 * ledger). What does not: tokens (the export holds no token, only its record,
 * and a token of another instance would be no use here), the audit trails, the
 * trash, the alert guards and the bookkeeping keys. The webhook URL is masked
 * in an export, so alerts come back switched off.
 *
 * The file is someone's own data, but it is still untrusted input: every key
 * name is rebuilt from validated parts (never written as given), every value
 * must read back through the same parser the app reads it with, and the
 * workspace quotas hold as they do for reports. `planImport` is pure; nothing
 * is written before the whole file has passed.
 */

/** What the request body may be, as sent (gzip-encoded or not). */
export const IMPORT_MAX_BODY_BYTES = 4 * 1024 * 1024;
/** And once inflated. */
export const IMPORT_MAX_INFLATED_BYTES = 64 * 1024 * 1024;
/** Raw reports in one import, every events key together. */
export const IMPORT_MAX_EVENTS = 500_000;
/** One stored value (a settings document, a summary, a machine entry). */
const MAX_VALUE_BYTES = 64 * 1024;
const MAX_NAME_LENGTH = 64;
const DAY_MS = 86_400_000;
/** Commands per MULTI, and members per ZADD. */
const COMMANDS_PER_TX = 500;
const MEMBERS_PER_ZADD = 500;

export interface ImportPlan {
  /** The exported workspace's name, cleaned. */
  name: string;
  settings: string | null;
  /** Relative key name ("providers", "alltime:claude", …) → fields. */
  hashes: { name: string; fields: Record<string, string> }[];
  /** Relative key name ("events:claude:Work", "history:claude") → members; `ttlSeconds` for the events. */
  zsets: { name: string; members: { score: number; member: string }[]; ttlSeconds: number | null }[];
  /** Exported keys that are not imported (see the module comment). */
  skipped: string[];
  counts: { providers: number; groups: number; machines: number; reports: number; cycles: number };
}

export type QuotaRefusal = "too_many_machines" | "too_many_providers" | "too_many_groups";

export type ImportPlanResult =
  | { ok: true; plan: ImportPlan }
  | { ok: false; reason: "invalid_payload"; errors: string[] }
  | { ok: false; reason: QuotaRefusal; limit: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stored value written back as text: JSON for anything but a string, and never a huge one. */
function stored(value: unknown): string | null {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text !== undefined && text.length <= MAX_VALUE_BYTES ? text : null;
}

function parsedOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
  return name.length > 0 ? name : null;
}

/** The exported `{ member, score }` list of a sorted set; null when it is not one. */
function zsetEntries(value: unknown): { member: unknown; score: number }[] | null {
  if (!Array.isArray(value)) return null;
  const entries: { member: unknown; score: number }[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.score !== "number" || !Number.isFinite(item.score)) return null;
    entries.push({ member: item.member, score: item.score });
  }
  return entries;
}

/** Checks `input` (the request body) and turns it into what `writeImport` stores. */
export function planImport(input: unknown, now: Date, quotas: Quotas, counting: MachineCounting): ImportPlanResult {
  const errors: string[] = [];
  const fail = (): ImportPlanResult => ({ ok: false, reason: "invalid_payload", errors });
  if (!isRecord(input)) return { ok: false, reason: "invalid_payload", errors: ["body must be a JSON object"] };
  if (input.format !== ACCOUNT_EXPORT_FORMAT || input.version !== ACCOUNT_EXPORT_VERSION) {
    errors.push(`format must be "${ACCOUNT_EXPORT_FORMAT}", version ${ACCOUNT_EXPORT_VERSION}`);
  }
  const workspace = input.workspace;
  if (!isRecord(workspace) || !isRecord(workspace.keys)) {
    errors.push("workspace must be an object with its keys");
    return fail();
  }
  const name = cleanName(workspace.name);
  if (!name) errors.push(`workspace.name must be 1-${MAX_NAME_LENGTH} characters`);
  if (errors.length > 0) return fail();

  const oldestMs = now.getTime() - RETENTION_DAYS * DAY_MS;
  const plan: ImportPlan = {
    name: name!,
    settings: null,
    hashes: [],
    zsets: [],
    skipped: [],
    counts: { providers: 0, groups: 0, machines: 0, reports: 0, cycles: 0 },
  };
  /** A hash of the export: each field kept when `accept` passes it, the value as stored. */
  const hash = (key: string, value: unknown, accept: (field: string, text: string) => boolean) => {
    if (!isRecord(value)) return errors.push(`${key} must be an object`);
    const fields: Record<string, string> = {};
    for (const [field, raw] of Object.entries(value)) {
      const text = stored(raw);
      if (text === null || !accept(field, text))
        return errors.push(`${key}: field ${JSON.stringify(field)} is not valid`);
      fields[field] = text;
    }
    if (Object.keys(fields).length > 0) plan.hashes.push({ name: key, fields });
    return Object.keys(fields).length;
  };
  const isProvider = (id: string) => normalizeProviderId(id) === id;
  const machineFields: string[] = [];

  for (const [key, value] of Object.entries(workspace.keys)) {
    const parts = key.split(":");
    if (key === "settings") {
      if (!isRecord(value)) {
        errors.push("settings must be an object");
        continue;
      }
      // The export masks the webhook URL: alerts come back off, to be set again.
      const alerts = isRecord(value.alerts) ? { ...value.alerts, webhookUrl: null } : value.alerts;
      plan.settings = stored(alerts === undefined ? value : { ...value, alerts });
      if (plan.settings === null) errors.push("settings is too large");
    } else if (key === "providers") {
      plan.counts.providers = Number(
        hash(key, value, (field, text) => isProvider(field) && Number.isFinite(Number(text))),
      );
    } else if (key === "groups") {
      plan.counts.groups = Number(hash(key, value, (field) => isValidId(field)));
    } else if (key === "machines") {
      hash(key, value, (field, text) => {
        const machine = parseMachine(field, text);
        const valid = machine !== null && isValidId(machine.machineId) && isValidId(machine.groupId);
        if (valid) machineFields.push(field);
        return valid;
      });
    } else if (key === "official") {
      hash(key, value, (field, text) => {
        const [providerId, subLimitId, ...rest] = field.split(":");
        const fieldOk =
          isProvider(providerId!) && rest.length === 0 && (subLimitId === undefined || isSubLimitId(subLimitId));
        return fieldOk && parseStoredOfficialEntry(text) !== null;
      });
    } else if (key === "resets") {
      hash(key, value, (field, text) => isProvider(field) && isRecord(parsedOrNull(text)));
    } else if (parts[0] === "alltime" && parts.length === 2 && isProvider(parts[1]!)) {
      plan.counts.cycles += Number(
        hash(key, value, (field, text) => /^\d{1,16}$/.test(field) && parseCycleSummary(text) !== null),
      );
    } else if (
      (parts[0] === "events" && parts.length === 3 && isProvider(parts[1]!) && isValidId(parts[2])) ||
      (parts[0] === "history" && parts.length === 2 && isProvider(parts[1]!))
    ) {
      const events = parts[0] === "events";
      const entries = zsetEntries(value);
      if (!entries) {
        errors.push(`${key} must be a list of { member, score }`);
        continue;
      }
      const members: { score: number; member: string }[] = [];
      for (const { member, score } of entries) {
        const text = stored(member);
        const valid =
          text !== null && (events ? parseEvent(text, parts[2]!) !== null : parseCycleSummary(text) !== null);
        if (!valid) {
          errors.push(`${key}: a member is not valid`);
          break;
        }
        if (events && score <= oldestMs) continue; // past the retention window: a report would prune it too
        members.push({ score, member: text });
      }
      // The history keeps its newest cycles only, as `archiveCycle` trims it.
      const kept = events ? members : members.sort((a, b) => b.score - a.score).slice(0, HISTORY_RETENTION);
      if (kept.length === 0) continue;
      plan.zsets.push({ name: key, members: kept, ttlSeconds: events ? (RETENTION_DAYS + 1) * 86_400 : null });
      if (events) plan.counts.reports += kept.length;
    } else {
      plan.skipped.push(key);
    }
  }
  if (errors.length > 0) return fail();
  if (plan.counts.reports > IMPORT_MAX_EVENTS) {
    return { ok: false, reason: "invalid_payload", errors: [`at most ${IMPORT_MAX_EVENTS} reports can be imported`] };
  }

  plan.counts.machines = countMachines(machineFields, counting);
  if (plan.counts.machines > quotas.machines) return { ok: false, reason: "too_many_machines", limit: quotas.machines };
  if (plan.counts.providers > quotas.providers)
    return { ok: false, reason: "too_many_providers", limit: quotas.providers };
  if (plan.counts.groups > quotas.groups) return { ok: false, reason: "too_many_groups", limit: quotas.groups };
  plan.skipped.sort();
  return { ok: true, plan };
}

/** The key a relative name of the plan stands for, in `store`. */
function keyOf(store: TenantStore, name: string): string {
  const { keys } = store;
  const parts = name.split(":");
  if (name === "providers") return keys.providers;
  if (name === "groups") return keys.groups;
  if (name === "machines") return keys.machines;
  if (name === "official") return keys.officialUsage;
  if (name === "resets") return keys.resets;
  if (parts[0] === "alltime") return keys.allTime(parts[1]!);
  if (parts[0] === "history") return keys.history(parts[1]!);
  if (parts[0] === "events") return keys.events(parts[1]!, parts[2]!);
  throw new Error(`not an importable key: ${name}`);
}

/**
 * Writes a plan into `store`, which the caller has made sure is empty. The dynamic keys go into
 * the registry in the same transaction that writes them, so deleting the workspace finds them.
 * Not atomic as a whole (a large import takes several transactions): a caller whose write fails
 * deletes what it started (a new workspace) or empties it.
 */
export async function writeImport(store: TenantStore, plan: ImportPlan): Promise<void> {
  type Command = (tx: ReturnType<TenantStore["redis"]["multi"]>) => void;
  const commands: Command[] = [];
  if (plan.settings !== null) commands.push((tx) => tx.set(store.keys.settings, plan.settings!));
  for (const { name, fields } of plan.hashes) {
    const key = keyOf(store, name);
    commands.push((tx) => tx.hset(key, fields));
    if (name.startsWith("alltime:")) commands.push((tx) => tx.sadd(store.keys.registry, key));
  }
  for (const { name, members, ttlSeconds } of plan.zsets) {
    const key = keyOf(store, name);
    commands.push((tx) => tx.sadd(store.keys.registry, key));
    for (let i = 0; i < members.length; i += MEMBERS_PER_ZADD) {
      const [first, ...rest] = members.slice(i, i + MEMBERS_PER_ZADD);
      commands.push((tx) => tx.zadd(key, first!, ...rest));
    }
    if (ttlSeconds !== null) commands.push((tx) => tx.expire(key, ttlSeconds));
  }
  for (let i = 0; i < commands.length; i += COMMANDS_PER_TX) {
    const tx = store.redis.multi();
    for (const command of commands.slice(i, i + COMMANDS_PER_TX)) command(tx);
    await tx.exec();
  }
}

/** Whether the workspace holds no usage yet: no provider, group or machine, and no dynamic key. */
export async function workspaceIsEmpty(store: TenantStore): Promise<boolean> {
  const reads = store.redis.pipeline();
  reads.hlen(store.keys.providers);
  reads.hlen(store.keys.groups);
  reads.hlen(store.keys.machines);
  reads.scard(store.keys.registry);
  const counts = (await reads.exec()).map(Number);
  return counts.every((count) => count === 0);
}

export type NewWorkspaceResult =
  | { ok: true; tenantId: TenantId }
  | { ok: false; reason: "too_many_workspaces"; limit: number };

/**
 * Multi-tenant mode: a new workspace for `userId`, owned by them and named after the exported one,
 * with the plan written into it. Counts against their owned workspaces like any other. A write
 * that fails takes the half-filled workspace with it.
 */
export async function importIntoNewWorkspace(userId: string, plan: ImportPlan, now: Date): Promise<NewWorkspaceResult> {
  const limit = WORKSPACE_QUOTAS.ownedWorkspaces;
  const owned = await ownedWorkspaceCount(userId);
  if (growsPast(owned, owned + 1, limit)) return { ok: false, reason: "too_many_workspaces", limit };
  const tenantId = await createTenantFor(userId, `${plan.name} (import)`.slice(0, MAX_NAME_LENGTH + 9), now);
  try {
    await writeImport(tenantStore(tenantId), plan);
  } catch (error) {
    await deleteTenant(tenantId, now).catch(() => undefined);
    throw error;
  }
  return { ok: true, tenantId };
}

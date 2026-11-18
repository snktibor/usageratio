import {
  AUDIT_LIMIT,
  type AuditRequestFields,
  describeClient,
  displayIp,
  optionalText,
  parseRequestFields,
  serializeRequestFields,
} from "@/lib/api-token";
import type { Affected } from "@/lib/manage-store";
import type { TenantStore } from "@/lib/tenant";
import { requestAuditFields } from "@/lib/token-vault";
import { loadUser } from "@/lib/users";

/**
 * The audit trail of the destructive things the settings panel does to the data the dashboard
 * registered by itself: groups, providers and machines deleted or merged, usage restarts
 * recorded, changed or deleted. The same request fields as the token trails (lib/api-token.ts), so
 * it tells which browser and address did it, and in multi-tenant mode who; the key is
 * `manage:audit` (lib/redis-keys.ts). Every entry is queued in the transaction of the change it
 * describes (`queueManageAudit`), so a change and its record exist together or not at all.
 */

export type ManageAction =
  | "group_deleted"
  | "group_merged"
  | "provider_deleted"
  | "machine_deleted"
  | "machine_merged"
  | "restart_recorded"
  | "restart_edited"
  | "restart_deleted"
  | "trash_restored"
  | "trash_purged";

export const MANAGE_ACTIONS: readonly ManageAction[] = [
  "group_deleted",
  "group_merged",
  "provider_deleted",
  "machine_deleted",
  "machine_merged",
  "restart_recorded",
  "restart_edited",
  "restart_deleted",
  "trash_restored",
  "trash_purged",
];

export type ManageSubjectKind = "group" | "provider" | "machine";

/** What an entry is about: `id` is the group, provider or machine id; a machine's provider is `providerId`; a merge's destination is `target`. */
export interface ManageSubject {
  kind: ManageSubjectKind;
  id: string;
  providerId?: string;
  target?: string;
}

/** What the library says about one change; the writer adds who and from where. */
export interface ManageAuditDetail {
  action: ManageAction;
  subject: ManageSubject;
  affected?: Affected;
  /** The trash entry that holds what a delete removed (a restore or a permanent delete names the one it acts on). */
  trashId?: string;
  /** A restore: how many archived cycle summaries it rewrote (lib/archive.ts `rederiveArchivedCycles`). */
  rederived?: number;
}

/** One stored entry. */
export interface ManageAuditRecord extends AuditRequestFields {
  action: ManageAction;
  subject: ManageSubject;
  affected: Affected | null;
  trashId: string | null;
  /** A restore: archived cycle summaries rewritten; absent on any other entry. */
  rederived?: number;
  /** Multi-tenant mode: the GitHub login of the user who did it (display only); null on a single-user instance. */
  by: string | null;
}

/** One entry as the history list gets it. */
export interface ManageAuditEntry {
  at: number;
  action: ManageAction;
  subject: ManageSubject;
  affected: Affected | null;
  trashId: string | null;
  /** "Chrome 140"; null when the request named no known browser. */
  browser: string | null;
  os: string | null;
  userAgent: string;
  /** One display string, as in the token trails. */
  ip: string;
  session: string | null;
  by: string | null;
}

/** The serialized audit entry of one change: built once per request (`manageAudit`), awaited by the library before it opens its transaction. */
export type ManageAuditWriter = (detail: ManageAuditDetail) => Promise<string>;

/**
 * The writer for the request being served: its browser and address, and in multi-tenant mode the
 * GitHub login of the user, worked out once however many entries the request writes.
 */
export function manageAudit(actor: { userId: string | null }, now: Date): ManageAuditWriter {
  let base: Promise<[AuditRequestFields, string | null]> | null = null;
  return async (detail) => {
    base ??= Promise.all([
      requestAuditFields(now),
      actor.userId ? loadUser(actor.userId).then((user) => user?.login || null) : Promise.resolve(null),
    ]);
    const [fields, by] = await base;
    return serializeManageAuditRecord({
      ...fields,
      action: detail.action,
      subject: detail.subject,
      affected: detail.affected ?? null,
      trashId: detail.trashId ?? null,
      ...(detail.rederived !== undefined && { rederived: detail.rederived }),
      by,
    });
  };
}

export function serializeManageAuditRecord(record: ManageAuditRecord): string {
  const { subject, affected, trashId, rederived } = record;
  return JSON.stringify({
    at: record.at,
    a: record.action,
    ...serializeRequestFields(record),
    ...(record.by !== null && { by: record.by }),
    k: subject.kind,
    id: subject.id,
    ...(subject.providerId !== undefined && { p: subject.providerId }),
    ...(subject.target !== undefined && { to: subject.target }),
    ...(affected && { n: { e: affected.events, m: affected.machines, g: affected.groups } }),
    ...(trashId !== null && { tr: trashId }),
    ...(rederived !== undefined && { rc: rederived }),
  });
}

const SUBJECT_KINDS: readonly unknown[] = ["group", "provider", "machine"];

function parseAffected(value: unknown): Affected | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { e, m, g } = value as Record<string, unknown>;
  if (![e, m, g].every((count) => typeof count === "number" && Number.isFinite(count))) return null;
  return { events: e as number, machines: m as number, groups: g as number };
}

/** One list item of the trail; null when it is not a readable entry. */
export function parseManageAuditRecord(raw: string): ManageAuditRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) return null;
  if (!(MANAGE_ACTIONS as readonly unknown[]).includes(entry.a)) return null;
  if (!SUBJECT_KINDS.includes(entry.k) || typeof entry.id !== "string") return null;
  const providerId = optionalText(entry.p);
  const target = optionalText(entry.to);
  const rederived = typeof entry.rc === "number" && Number.isFinite(entry.rc) ? entry.rc : undefined;
  return {
    at: entry.at,
    action: entry.a as ManageAction,
    ...parseRequestFields(entry),
    subject: {
      kind: entry.k as ManageSubjectKind,
      id: entry.id,
      ...(providerId !== null && { providerId }),
      ...(target !== null && { target }),
    },
    affected: parseAffected(entry.n),
    trashId: optionalText(entry.tr),
    ...(rederived !== undefined && { rederived }),
    by: optionalText(entry.by),
  };
}

export function toManageAuditEntry(record: ManageAuditRecord): ManageAuditEntry {
  const { browser, os } = describeClient(record.userAgent, record.brands, record.platform);
  return {
    at: record.at,
    action: record.action,
    subject: record.subject,
    affected: record.affected,
    trashId: record.trashId,
    browser,
    os,
    userAgent: record.userAgent,
    ip: displayIp(record),
    session: record.session,
    by: record.by,
  };
}

/** Queues one serialized entry in `tx`, newest first, keeping the newest AUDIT_LIMIT. */
export function queueManageAudit(
  tx: ReturnType<TenantStore["redis"]["multi"]>,
  store: TenantStore,
  record: string,
): void {
  tx.lpush(store.keys.manageAudit, record);
  tx.ltrim(store.keys.manageAudit, 0, AUDIT_LIMIT - 1);
}

/** The trail, newest first. Entries that do not parse are left out. */
export async function loadManageAudit(store: TenantStore): Promise<ManageAuditEntry[]> {
  const raw = await store.redis.lrange<string>(store.keys.manageAudit, 0, AUDIT_LIMIT - 1);
  return raw.flatMap((item) => {
    const record = parseManageAuditRecord(String(item));
    return record ? [toManageAuditEntry(record)] : [];
  });
}

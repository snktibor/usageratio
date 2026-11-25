import { listInvites } from "@/lib/invites";
import { listMembers } from "@/lib/members";
import { getRedis, toStringRecord } from "@/lib/redis";
import { fixedTenantKeys, GLOBAL_KEYS, type TenantKeys } from "@/lib/redis-keys";
import { type TenantStore, tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { loadTenantRecord } from "@/lib/tenants";
import { listLiveSessions } from "@/lib/user-session";
import { loadUser, type Role, userTenants } from "@/lib/users";
import { maskWebhookUrl } from "@/lib/webhook";

/**
 * GET /api/account/export: everything the service holds about the signed-in
 * user, as one JSON document (access and portability, GDPR Art. 15 and 20).
 *
 * The account itself (login, sign-in identities, sessions), every workspace
 * it belongs to, and for each workspace it owns the workspace's complete data:
 * every key the workspace owns (its fixed keys and every name in its key
 * registry, the same list deleting it goes by), its record, its members and
 * its pending invites. A workspace it only belongs to gives its name and the
 * membership: the data there is its owner's to export.
 *
 * The keys are written under their name without the workspace's prefix
 * (`events:claude:Work`, see lib/redis-keys.ts for every shape), their values
 * as stored, JSON parsed where they are JSON. Left out, and nothing else: the
 * shared API token (encrypted, a credential), the key registry and the tokens
 * lock (bookkeeping). The machine tokens' hashes are replaced by the tokens'
 * ids, the webhook URL by its mask, as on the settings page.
 */

export const ACCOUNT_EXPORT_FORMAT = "usageratio-account-export";
export const ACCOUNT_EXPORT_VERSION = 1;

/** Keys read per pipeline: a large workspace has hundreds of event keys. */
const BATCH = 50;

type KeyType = "string" | "hash" | "list" | "zset";

export interface ZsetEntry {
  member: unknown;
  score: number;
}

export interface WorkspaceData {
  record: { name: string; createdAt: number; status: string } | null;
  members: { login: string; role: Role; joinedAt: number }[];
  invites: { id: string; createdAt: number; expiresAt: number; login: string | null }[];
  /** Key name without the workspace's prefix → its value. */
  keys: Record<string, unknown>;
}

export interface ExportedWorkspace {
  tenantId: TenantId;
  name: string;
  role: Role;
  joinedAt: number | null;
  /** Only for a workspace the user owns. */
  data?: WorkspaceData;
}

export interface AccountExport {
  format: typeof ACCOUNT_EXPORT_FORMAT;
  version: typeof ACCOUNT_EXPORT_VERSION;
  generatedAt: string;
  account: {
    userId: string;
    login: string;
    createdAt: number;
    lastLoginAt: number;
    identities: string[];
    sessions: { label: string; createdAt: number; seenAt: number }[];
  };
  workspaces: ExportedWorkspace[];
}

/** The whole export, or null when the user does not exist (any more). */
export async function buildAccountExport(userId: string, now: Date): Promise<AccountExport | null> {
  const user = await loadUser(userId);
  if (!user) return null;
  const redis = getRedis();
  const identities = ((await redis.smembers(GLOBAL_KEYS.userIdentities(userId))) as unknown[]).map(String).sort();
  const sessions = (await listLiveSessions(userId, now.getTime())).map(({ label, createdAt, seenAt }) => ({
    label,
    createdAt,
    seenAt,
  }));

  const workspaces: ExportedWorkspace[] = [];
  for (const { tenantId, role } of await userTenants(userId)) {
    const record = await loadTenantRecord(tenantId);
    const members = await listMembers(tenantId);
    const own = members.find((member) => member.userId === userId);
    const entry: ExportedWorkspace = {
      tenantId,
      name: record?.name ?? tenantId,
      role,
      joinedAt: own?.joinedAt ?? null,
    };
    if (role === "owner") {
      const invites = await listInvites(tenantId, now);
      entry.data = {
        record: record ? { name: record.name, createdAt: record.createdAt, status: record.status } : null,
        members: members.map(({ login, role: memberRole, joinedAt }) => ({ login, role: memberRole, joinedAt })),
        invites: invites.map(({ id, createdAt, expiresAt, login }) => ({ id, createdAt, expiresAt, login })),
        keys: await exportWorkspaceKeys(tenantStore(tenantId)),
      };
    }
    workspaces.push(entry);
  }

  return {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    generatedAt: now.toISOString(),
    account: {
      userId,
      login: user.login,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      identities,
      sessions,
    },
    workspaces,
  };
}

/** The keys an export leaves out (see the module comment). */
function skipped(keys: TenantKeys): Set<string> {
  return new Set([keys.apiToken, keys.registry, keys.tokensLock]);
}

/** A key's type, from its name: every tenant key has one fixed type (lib/redis-keys.ts); null for the registry or a name that is not one of the tenant's. */
export function tenantKeyType(keys: TenantKeys, key: string): KeyType | null {
  const fixed: Record<string, KeyType> = {
    [keys.settings]: "string",
    [keys.providers]: "hash",
    [keys.groups]: "hash",
    [keys.machines]: "hash",
    [keys.officialUsage]: "hash",
    [keys.resets]: "hash",
    [keys.apiToken]: "string",
    [keys.apiTokenAudit]: "list",
    [keys.housekeepingLast]: "string",
    [keys.quotaRefusals]: "hash",
    [keys.tokens]: "hash",
    [keys.tokensLastUsed]: "hash",
    [keys.tokensAudit]: "list",
    [keys.manageAudit]: "list",
    [keys.tokensLock]: "string",
    [keys.trash]: "zset",
  };
  if (key in fixed) return fixed[key]!;
  if (key === keys.registry) return null;
  if (!key.startsWith(keys.prefix)) return null;
  const name = key.slice(keys.prefix.length);
  if (name.startsWith("events:") || name.startsWith("history:")) return "zset";
  if (name.startsWith("alltime:")) return "hash";
  if (name.startsWith("alert:")) return "string";
  if (name.startsWith("trash:")) return name.includes(":events:") ? "zset" : "string";
  return null;
}

/** Every key the workspace owns, read and decoded, under its name without the prefix. */
export async function exportWorkspaceKeys(store: TenantStore): Promise<Record<string, unknown>> {
  const { keys, redis } = store;
  const registered = ((await redis.smembers(keys.registry)) as unknown[]).map(String);
  const leaveOut = skipped(keys);
  const names = [...new Set([...fixedTenantKeys(keys), ...registered])]
    .filter((key) => key.startsWith(keys.prefix) && !leaveOut.has(key))
    .flatMap((key) => {
      const type = tenantKeyType(keys, key);
      return type ? [{ key, type }] : [];
    })
    .sort((a, b) => a.key.localeCompare(b.key));

  const raw: unknown[] = [];
  for (let i = 0; i < names.length; i += BATCH) {
    const reads = redis.pipeline();
    for (const { key, type } of names.slice(i, i + BATCH)) {
      if (type === "string") reads.get(key);
      else if (type === "hash") reads.hgetall(key);
      else if (type === "list") reads.lrange(key, 0, -1);
      else reads.zrange(key, 0, -1, { withScores: true });
    }
    raw.push(...(await reads.exec()));
  }

  const tokenIds = tokenIdsByHash(raw[names.findIndex(({ key }) => key === keys.tokens)]);
  const out: Record<string, unknown> = {};
  names.forEach(({ key, type }, index) => {
    const value = decode(type, raw[index]);
    if (value === null) return;
    const name = key.slice(keys.prefix.length);
    if (key === keys.settings) out[name] = maskSettings(value);
    else if (key === keys.tokens || key === keys.tokensLastUsed) out[name] = byTokenId(value, tokenIds);
    else out[name] = value;
  });
  return out;
}

/** A stored text: its JSON when it is JSON, the text itself otherwise. */
function parsed(raw: unknown): unknown {
  const text = String(raw);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A read's result in the export's shape; null for a key that does not exist (or is empty). */
function decode(type: KeyType, raw: unknown): unknown | null {
  if (raw === null || raw === undefined) return null;
  if (type === "string") return parsed(raw);
  if (type === "hash") {
    const record = toStringRecord(raw);
    const entries = Object.entries(record);
    return entries.length === 0 ? null : Object.fromEntries(entries.map(([field, value]) => [field, parsed(value)]));
  }
  const items = (raw as unknown[]).map(String);
  if (items.length === 0) return null;
  if (type === "list") return items.map(parsed);
  const entries: ZsetEntry[] = [];
  for (let i = 0; i + 1 < items.length; i += 2) entries.push({ member: parsed(items[i]), score: Number(items[i + 1]) });
  return entries;
}

/** sha256(token) → the token's id, from the raw `tokens` hash. */
function tokenIdsByHash(raw: unknown): Map<string, string> {
  const ids = new Map<string, string>();
  for (const [hash, value] of Object.entries(toStringRecord(raw ?? {}))) {
    const record = parsed(value);
    const id = record && typeof record === "object" ? (record as { id?: unknown }).id : undefined;
    if (typeof id === "string") ids.set(hash, id);
  }
  return ids;
}

/** A hash keyed by token hashes, keyed by the tokens' ids instead (an unknown hash: "unknown-N"). */
function byTokenId(value: unknown, ids: Map<string, string>): unknown {
  let unknown = 0;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([hash, entry]) => {
      const id = ids.get(hash);
      if (id) return [id, entry];
      unknown += 1;
      return [`unknown-${unknown}`, entry];
    }),
  );
}

/** The settings document with its webhook URL masked (lib/webhook.ts), as the settings page shows it. */
function maskSettings(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const doc = value as { alerts?: { webhookUrl?: unknown } };
  if (typeof doc.alerts?.webhookUrl !== "string") return value;
  return { ...doc, alerts: { ...doc.alerts, webhookUrl: maskWebhookUrl(doc.alerts.webhookUrl) } };
}

/** "usageratio-export-<login>-<YYYY-MM-DD>.json"; the login only when it is a plain GitHub login. */
export function accountExportFilename(login: string, now: Date): string {
  const safe = /^[A-Za-z0-9-]{1,39}$/.test(login) ? `-${login}` : "";
  return `usageratio-export${safe}-${now.toISOString().slice(0, 10)}.json`;
}

/** Whether an Accept-Encoding header allows gzip (and does not refuse it with q=0). */
export function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(";");
    if (coding !== "gzip" && coding !== "*") return false;
    const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

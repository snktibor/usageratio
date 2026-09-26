import {
  type ApiTokenStatus,
  AUDIT_LIMIT,
  type AuditAction,
  type AuditEntry,
  type AuditRecord,
  networkPrefix,
  parseAuditRecord,
  serializeAuditRecord,
  toAuditEntry,
} from "@/lib/api-token";
import { sessionTag } from "@/lib/auth";
import { log } from "@/lib/log";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { clientIp, currentHeaders, defer } from "@/lib/request-context";
import { keyFingerprint, openSecret, parseEncryptionKey, sealSecret } from "@/lib/secret-box";
import { safeEqual, sha256Hex } from "@/lib/security";

/**
 * The stored copy of the clients' API token, for the setup page's copy button.
 * See lib/redis-keys.ts for the two keys it lives under.
 *
 * The token that authenticates the clients stays the USAGE_API_TOKEN env var:
 * this copy only lets a signed-in browser put it on the clipboard. The
 * plaintext leaves this module through `revealApiToken` alone, and only after
 * that request is on the audit trail.
 *
 * Key rotation: the stored document is sealed with TOKEN_ENCRYPTION_KEY and
 * tagged with that key's fingerprint (`kid`). Opening also tries
 * TOKEN_ENCRYPTION_KEY_PREVIOUS, so a value sealed under the key being
 * retired still opens; whenever that happens (or the document predates `kid`
 * altogether) it is re-sealed with the current key in the background. Runbook:
 * set TOKEN_ENCRYPTION_KEY_PREVIOUS to the old key and TOKEN_ENCRYPTION_KEY to
 * the new one, redeploy, open the settings panel once (any read re-seals it),
 * then remove TOKEN_ENCRYPTION_KEY_PREVIOUS.
 */

/** Bound into every ciphertext: a value sealed for anything else does not open here. */
const CONTEXT = "usageratio/usage-api-token/v1";

export interface EncryptionKeys {
  /** From TOKEN_ENCRYPTION_KEY; null while it is missing or malformed. */
  current: Buffer | null;
  /** From TOKEN_ENCRYPTION_KEY_PREVIOUS, tried only to open an older document; null while unset. */
  previous: Buffer | null;
  /** `keyFingerprint(current)`; null alongside `current`. */
  currentKid: string | null;
}

const warned = new Set<string>();

function parseNamedKey(raw: string | undefined, name: string): Buffer | null {
  const key = parseEncryptionKey(raw);
  if (!key && raw?.trim() && !warned.has(name)) {
    warned.add(name);
    log.error("vault.bad_encryption_key", {
      name,
      rule: `${name} must be 32 bytes: 64 hex digits or base64 (openssl rand -base64 32)`,
    });
  }
  return key;
}

/** Both keys the vault knows about, from the environment. */
export function encryptionKeys(env: Record<string, string | undefined> = process.env): EncryptionKeys {
  const current = parseNamedKey(env.TOKEN_ENCRYPTION_KEY, "TOKEN_ENCRYPTION_KEY");
  const previous = parseNamedKey(env.TOKEN_ENCRYPTION_KEY_PREVIOUS, "TOKEN_ENCRYPTION_KEY_PREVIOUS");
  return { current, previous, currentKid: current ? keyFingerprint(current) : null };
}

/** The key from TOKEN_ENCRYPTION_KEY alone; null while it is missing or malformed. */
export function encryptionKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  return encryptionKeys(env).current;
}

/** `key` as the current key, plus whatever TOKEN_ENCRYPTION_KEY_PREVIOUS is set to. */
function mergeKeys(key: Buffer): EncryptionKeys {
  return { current: key, previous: encryptionKeys().previous, currentKid: keyFingerprint(key) };
}

type StoredToken =
  | { state: "empty" }
  | { state: "unreadable"; updatedAt: number | null }
  /** `needsReseal`: the document isn't sealed with the current key yet (rotation, or a pre-rotation document). */
  | { state: "stored"; token: string; updatedAt: number | null; needsReseal: boolean };

/** Tries `keys.current`, then `keys.previous`, guided by the document's `kid` when it names one. */
function openWithKeys(
  document: Record<string, unknown>,
  keys: EncryptionKeys,
): { token: string; openedWithCurrent: boolean; documentKid: string | null } | null {
  const kid = typeof document.kid === "string" ? document.kid : null;
  const previousKid = keys.previous ? keyFingerprint(keys.previous) : null;
  const tryOpen = (key: Buffer | null): string | null => {
    if (!key) return null;
    try {
      return openSecret(document, key, CONTEXT);
    } catch {
      return null;
    }
  };

  if (kid !== null && kid === keys.currentKid) {
    const token = tryOpen(keys.current);
    return token === null ? null : { token, openedWithCurrent: true, documentKid: kid };
  }
  if (kid !== null && kid === previousKid) {
    const token = tryOpen(keys.previous);
    return token === null ? null : { token, openedWithCurrent: false, documentKid: kid };
  }
  // No kid, or one that matches neither key on file: try both, current first.
  const currentToken = tryOpen(keys.current);
  if (currentToken !== null) return { token: currentToken, openedWithCurrent: true, documentKid: kid };
  const previousToken = tryOpen(keys.previous);
  return previousToken === null ? null : { token: previousToken, openedWithCurrent: false, documentKid: kid };
}

async function loadToken(keys: EncryptionKeys): Promise<StoredToken> {
  const raw = await getRedis().get<string>(KEYS.apiToken);
  if (raw === null || raw === undefined) return { state: "empty" };

  let document: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (typeof parsed === "object" && parsed !== null) document = parsed as Record<string, unknown>;
  } catch {
    // Unreadable JSON is reported like a failed decryption, below.
  }
  const updatedAt = typeof document.updatedAt === "number" ? document.updatedAt : null;
  const opened = openWithKeys(document, keys);
  if (!opened) return { state: "unreadable", updatedAt };
  const needsReseal = !(opened.openedWithCurrent && opened.documentKid === keys.currentKid);
  return { state: "stored", token: opened.token, updatedAt, needsReseal };
}

/** Re-seals `token` with the current key, in the background: called once a document opens with anything else. */
function scheduleReseal(token: string, keys: EncryptionKeys, updatedAt: number | null): void {
  const key = keys.current;
  if (!key) return;
  defer(async () => {
    const document = JSON.stringify({
      ...sealSecret(token, key, CONTEXT, keyFingerprint(key)),
      updatedAt: updatedAt ?? Date.now(),
    });
    await getRedis().set(KEYS.apiToken, document);
  });
}

/** Whether `token` is the one the clients authenticate with; null while USAGE_API_TOKEN is not set. */
function matchesServerToken(token: string): boolean | null {
  const serverToken = process.env.USAGE_API_TOKEN?.trim();
  return serverToken ? safeEqual(token, serverToken) : null;
}

/** What is stored, without the token itself. */
export async function loadApiTokenStatus(key: Buffer | null = encryptionKey()): Promise<ApiTokenStatus> {
  if (!key) return { state: "no_key" };
  const keys = mergeKeys(key);
  const stored = await loadToken(keys);
  if (stored.state !== "stored") return stored;
  if (stored.needsReseal) scheduleReseal(stored.token, keys, stored.updatedAt);
  return {
    state: "stored",
    updatedAt: stored.updatedAt,
    matchesServer: matchesServerToken(stored.token),
    keyId: keys.currentKid,
    needsReseal: stored.needsReseal,
  };
}

/** The salt audit IP hashes are keyed with: AUDIT_SALT, or sha256(TOKEN_ENCRYPTION_KEY) while that is not set. */
function auditSalt(env: Record<string, string | undefined> = process.env): string {
  return env.AUDIT_SALT?.trim() || sha256Hex(env.TOKEN_ENCRYPTION_KEY?.trim() ?? "");
}

/**
 * The address fields for a new audit record: the raw address only when
 * AUDIT_RAW_IP=1, otherwise a salted hash plus its network prefix. "unknown"
 * (an untrusted or missing proxy header, see lib/request-context.ts
 * `clientIp`) carries no data worth hashing, so it stays "unknown" on read.
 */
function auditIpFields(ip: string): Pick<AuditRecord, "ip" | "ipHash" | "ipPrefix"> {
  if (ip === "unknown") return { ip: null, ipHash: null, ipPrefix: null };
  if (process.env.AUDIT_RAW_IP?.trim() === "1") return { ip, ipHash: null, ipPrefix: null };
  return { ip: null, ipHash: sha256Hex(`${auditSalt()}${ip}`).slice(0, 12), ipPrefix: networkPrefix(ip) };
}

async function auditRecord(action: AuditAction, now: Date): Promise<string> {
  const requestHeaders = await currentHeaders();
  const header = (name: string, max: number) => (requestHeaders.get(name) ?? "").slice(0, max);
  return serializeAuditRecord({
    at: now.getTime(),
    action,
    userAgent: header("user-agent", 256),
    brands: header("sec-ch-ua", 256),
    platform: header("sec-ch-ua-platform", 64),
    session: await sessionTag(),
    ...auditIpFields((await clientIp()).slice(0, 64)),
  });
}

/** Encrypts and stores `token`, in one transaction with its audit entry. */
export async function saveApiToken(
  token: string,
  key: Buffer,
  now: Date,
): Promise<{ action: "created" | "updated"; status: ApiTokenStatus }> {
  const redis = getRedis();
  // A read before the transaction: two browsers saving in the same instant is not worth a script.
  const action = Number(await redis.exists(KEYS.apiToken)) === 1 ? "updated" : "created";
  const document = JSON.stringify({
    ...sealSecret(token, key, CONTEXT, keyFingerprint(key)),
    updatedAt: now.getTime(),
  });

  const tx = redis.multi();
  tx.set(KEYS.apiToken, document);
  tx.lpush(KEYS.apiTokenAudit, await auditRecord(action, now));
  tx.ltrim(KEYS.apiTokenAudit, 0, AUDIT_LIMIT - 1);
  await tx.exec();

  return {
    action,
    status: {
      state: "stored",
      updatedAt: now.getTime(),
      matchesServer: matchesServerToken(token),
      keyId: keyFingerprint(key),
      needsReseal: false,
    },
  };
}

/**
 * The stored token in plaintext, for the browser that asked. The request goes
 * on the audit trail first: if that write fails, the token is not handed out.
 */
export async function revealApiToken(
  key: Buffer,
  now: Date,
): Promise<{ state: "empty" } | { state: "unreadable" } | { state: "stored"; token: string }> {
  const keys = mergeKeys(key);
  const stored = await loadToken(keys);
  if (stored.state === "empty") return { state: "empty" };
  if (stored.state === "unreadable") return { state: "unreadable" };
  if (stored.needsReseal) scheduleReseal(stored.token, keys, stored.updatedAt);

  const tx = getRedis().multi();
  tx.lpush(KEYS.apiTokenAudit, await auditRecord("revealed", now));
  tx.ltrim(KEYS.apiTokenAudit, 0, AUDIT_LIMIT - 1);
  await tx.exec();
  return { state: "stored", token: stored.token };
}

/** The audit trail, newest first. Entries that do not parse are left out. */
export async function loadAuditTrail(): Promise<AuditEntry[]> {
  const raw = await getRedis().lrange<string>(KEYS.apiTokenAudit, 0, AUDIT_LIMIT - 1);
  return raw.flatMap((item) => {
    const record = parseAuditRecord(String(item));
    return record ? [toAuditEntry(record)] : [];
  });
}

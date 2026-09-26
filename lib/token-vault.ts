import { headers } from "next/headers";
import {
  type ApiTokenStatus,
  AUDIT_LIMIT,
  type AuditAction,
  type AuditClient,
  type AuditEntry,
  parseAuditRecord,
  serializeAuditRecord,
  toAuditEntry,
} from "@/lib/api-token";
import { clientIp, sessionTag } from "@/lib/auth";
import { getRedis } from "@/lib/redis";
import { openSecret, parseEncryptionKey, sealSecret } from "@/lib/secret-box";
import { safeEqual } from "@/lib/security";

/**
 * The stored copy of the clients' API token, for the setup page's copy button.
 *
 *   usage:api-token        STRING {"v":1,"iv","ct","tag","updatedAt"}: AES-256-GCM, key TOKEN_ENCRYPTION_KEY
 *   usage:api-token:audit  LIST   newest first, at most AUDIT_LIMIT entries:
 *                                 {"at","a","ua","ch","pf","ip","s"} (see lib/api-token.ts)
 *
 * The token that authenticates the clients stays the USAGE_API_TOKEN env var:
 * this copy only lets a signed-in browser put it on the clipboard. The
 * plaintext leaves this module through `revealApiToken` alone, and only after
 * that request is on the audit trail.
 */
const KEYS = {
  token: "usage:api-token",
  audit: "usage:api-token:audit",
};

/** Bound into every ciphertext: a value sealed for anything else does not open here. */
const CONTEXT = "usageratio/usage-api-token/v1";

let warnedKey = false;

/** The key from TOKEN_ENCRYPTION_KEY; null while it is missing or malformed. */
export function encryptionKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const key = parseEncryptionKey(env.TOKEN_ENCRYPTION_KEY);
  if (!key && env.TOKEN_ENCRYPTION_KEY?.trim() && !warnedKey) {
    warnedKey = true;
    console.error(
      "[usageratio] TOKEN_ENCRYPTION_KEY must be 32 bytes: 64 hex digits or base64 (openssl rand -base64 32).",
    );
  }
  return key;
}

type StoredToken =
  | { state: "empty" }
  | { state: "unreadable"; updatedAt: number | null }
  | { state: "stored"; token: string; updatedAt: number | null };

async function loadToken(key: Buffer): Promise<StoredToken> {
  const raw = await getRedis().get<string>(KEYS.token);
  if (raw === null || raw === undefined) return { state: "empty" };

  let document: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(String(raw));
    if (typeof parsed === "object" && parsed !== null) document = parsed as Record<string, unknown>;
  } catch {
    // Unreadable JSON is reported like a failed decryption, below.
  }
  const updatedAt = typeof document.updatedAt === "number" ? document.updatedAt : null;
  try {
    return { state: "stored", token: openSecret(document, key, CONTEXT), updatedAt };
  } catch {
    return { state: "unreadable", updatedAt };
  }
}

/** Whether `token` is the one the clients authenticate with; null while USAGE_API_TOKEN is not set. */
function matchesServerToken(token: string): boolean | null {
  const serverToken = process.env.USAGE_API_TOKEN?.trim();
  return serverToken ? safeEqual(token, serverToken) : null;
}

/** What is stored, without the token itself. */
export async function loadApiTokenStatus(key: Buffer | null = encryptionKey()): Promise<ApiTokenStatus> {
  if (!key) return { state: "no_key" };
  const stored = await loadToken(key);
  if (stored.state !== "stored") return stored;
  return { state: "stored", updatedAt: stored.updatedAt, matchesServer: matchesServerToken(stored.token) };
}

/** The browser making the current request. The texts are capped: they come from the client. */
async function currentClient(): Promise<AuditClient> {
  const requestHeaders = await headers();
  const header = (name: string, max: number) => (requestHeaders.get(name) ?? "").slice(0, max);
  return {
    userAgent: header("user-agent", 512),
    brands: header("sec-ch-ua", 256),
    platform: header("sec-ch-ua-platform", 64),
    ip: (await clientIp()).slice(0, 64),
    session: await sessionTag(),
  };
}

async function auditRecord(action: AuditAction, now: Date): Promise<string> {
  return serializeAuditRecord({ at: now.getTime(), action, ...(await currentClient()) });
}

/** Encrypts and stores `token`, in one transaction with its audit entry. */
export async function saveApiToken(
  token: string,
  key: Buffer,
  now: Date,
): Promise<{ action: "created" | "updated"; status: ApiTokenStatus }> {
  const redis = getRedis();
  // A read before the transaction: two browsers saving in the same instant is not worth a script.
  const action = Number(await redis.exists(KEYS.token)) === 1 ? "updated" : "created";
  const document = JSON.stringify({ ...sealSecret(token, key, CONTEXT), updatedAt: now.getTime() });

  const tx = redis.multi();
  tx.set(KEYS.token, document);
  tx.lpush(KEYS.audit, await auditRecord(action, now));
  tx.ltrim(KEYS.audit, 0, AUDIT_LIMIT - 1);
  await tx.exec();

  return {
    action,
    status: { state: "stored", updatedAt: now.getTime(), matchesServer: matchesServerToken(token) },
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
  const stored = await loadToken(key);
  if (stored.state === "empty") return { state: "empty" };
  if (stored.state === "unreadable") return { state: "unreadable" };

  const tx = getRedis().multi();
  tx.lpush(KEYS.audit, await auditRecord("revealed", now));
  tx.ltrim(KEYS.audit, 0, AUDIT_LIMIT - 1);
  await tx.exec();
  return { state: "stored", token: stored.token };
}

/** The audit trail, newest first. Entries that do not parse are left out. */
export async function loadAuditTrail(): Promise<AuditEntry[]> {
  const raw = await getRedis().lrange<string>(KEYS.audit, 0, AUDIT_LIMIT - 1);
  return raw.flatMap((item) => {
    const record = parseAuditRecord(String(item));
    return record ? [toAuditEntry(record)] : [];
  });
}

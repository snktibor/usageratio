import { randomBytes } from "node:crypto";
import { describeClient } from "@/lib/api-token";
import { clearCookie, hostCookieName, serializeCookie } from "@/lib/cookies";
import { getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { currentCookies, currentHeaders, defer, isHttpsRequest } from "@/lib/request-context";
import { sha256Hex } from "@/lib/security";
import { isTenantId, type TenantId } from "@/lib/tenant-id";

/**
 * Browser sessions in multi-tenant mode (the PIN sessions of a single-user
 * instance are lib/auth.ts). A session is a random 256-bit id in a host-only
 * cookie (`__Host-ur_session` over HTTPS: Secure, no Domain, Path=/, so it
 * never reaches demo. or the landing); Redis keeps only its hash. It names
 * the user and the tenant they are looking at; whether they may still look
 * at it is checked on every request (lib/tenant-context.ts), so removing a
 * member takes effect at once. Idle and absolute expiry are the PIN
 * sessions' (SESSION_IDLE_DAYS, SESSION_MAX_DAYS). Sudo is a GitHub sign-in
 * within the last SUDO_WINDOW_MS (`a`).
 */

const COOKIE_BASE = "ur_session";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEFAULT_IDLE_DAYS = 7;
const DEFAULT_MAX_DAYS = 30;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
export const SUDO_WINDOW_MS = 5 * 60 * 1000;

export interface UserSession {
  /** sha256 of the session id: the Redis key's suffix, also handy as a stable, non-secret tag. */
  hash: string;
  userId: string;
  /** The tenant this browser is looking at; null while the user belongs to none. */
  tenantId: TenantId | null;
  createdAt: number;
  seenAt: number;
  /** The last GitHub sign-in on this session (the sign-in itself, or a sudo round trip). */
  authAt: number;
  label: string;
}

interface StoredSession {
  v: 2;
  u: string;
  t: string | null;
  c: number;
  s: number;
  a: number;
  ua: string;
}

function days(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return (Number.isFinite(raw) && raw > 0 ? raw : fallback) * 86_400_000;
}

export async function sessionCookieName(): Promise<string> {
  return hostCookieName(COOKIE_BASE, await isHttpsRequest());
}

function parse(raw: unknown): StoredSession | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredSession>;
    if (value?.v !== 2 || typeof value.u !== "string" || typeof value.c !== "number" || typeof value.s !== "number")
      return null;
    return {
      v: 2,
      u: value.u,
      t: typeof value.t === "string" && isTenantId(value.t) ? value.t : null,
      c: value.c,
      s: value.s,
      a: typeof value.a === "number" ? value.a : 0,
      ua: typeof value.ua === "string" ? value.ua : "",
    };
  } catch {
    return null;
  }
}

async function clientLabel(): Promise<string> {
  const headers = await currentHeaders();
  const { browser, os } = describeClient(
    (headers.get("user-agent") ?? "").slice(0, 256),
    (headers.get("sec-ch-ua") ?? "").slice(0, 256),
    (headers.get("sec-ch-ua-platform") ?? "").slice(0, 64),
  );
  return [browser, os].filter(Boolean).join(" · ").slice(0, 64);
}

/**
 * Starts a session for `userId` looking at `tenantId`; returns the
 * `Set-Cookie` header for the response that carries it. A fresh id every
 * time: an id that existed before the sign-in never becomes signed in.
 */
export async function startUserSession(userId: string, tenantId: TenantId | null, now: Date): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  const hash = sha256Hex(id);
  const maxMs = days("SESSION_MAX_DAYS", DEFAULT_MAX_DAYS);
  const record: StoredSession = {
    v: 2,
    u: userId,
    t: tenantId,
    c: now.getTime(),
    s: now.getTime(),
    a: now.getTime(),
    ua: await clientLabel(),
  };
  const tx = getRedis().multi();
  tx.set(GLOBAL_KEYS.userSession(hash), JSON.stringify(record), { px: maxMs });
  tx.zadd(GLOBAL_KEYS.userSessions(userId), { score: now.getTime(), member: hash });
  await tx.exec();
  const secure = await isHttpsRequest();
  return serializeCookie(hostCookieName(COOKIE_BASE, secure), id, { maxAge: maxMs / 1000, secure });
}

/** The live session the request's cookie names; null without one, or once it has expired (it is then deleted). */
export async function currentUserSession(): Promise<UserSession | null> {
  const id = (await currentCookies()).get(await sessionCookieName())?.value;
  if (!id || !SESSION_ID_PATTERN.test(id)) return null;
  const hash = sha256Hex(id);
  const key = GLOBAL_KEYS.userSession(hash);
  const stored = parse(await getRedis().get(key));
  if (!stored) return null;

  const now = Date.now();
  const idleMs = days("SESSION_IDLE_DAYS", DEFAULT_IDLE_DAYS);
  const maxMs = days("SESSION_MAX_DAYS", DEFAULT_MAX_DAYS);
  if (now - stored.s > idleMs || now - stored.c > maxMs) {
    await removeSession(stored.u, hash);
    return null;
  }
  if (now - stored.s > REFRESH_INTERVAL_MS) {
    const ttl = Math.max(1000, maxMs - (now - stored.c));
    defer(async () => {
      await getRedis().set(key, JSON.stringify({ ...stored, s: now }), { px: ttl, xx: true });
    });
  }
  return {
    hash,
    userId: stored.u,
    tenantId: stored.t as TenantId | null,
    createdAt: stored.c,
    seenAt: stored.s,
    authAt: stored.a,
    label: stored.ua,
  };
}

/** Rewrites one field set of a live session, keeping its expiry. */
async function updateSession(hash: string, change: Partial<Pick<StoredSession, "t" | "a">>): Promise<boolean> {
  const key = GLOBAL_KEYS.userSession(hash);
  const stored = parse(await getRedis().get(key));
  if (!stored) return false;
  const result = await getRedis().set(key, JSON.stringify({ ...stored, ...change }), { keepTtl: true, xx: true });
  return result === "OK";
}

/** Records a fresh GitHub sign-in on the session (a sudo round trip). */
export async function markSessionAuthenticated(hash: string, now: Date): Promise<boolean> {
  return updateSession(hash, { a: now.getTime() });
}

/** Points the session at another tenant; the caller has checked the membership. */
export async function setSessionTenant(hash: string, tenantId: TenantId | null): Promise<boolean> {
  return updateSession(hash, { t: tenantId });
}

/** Whether the session had a GitHub sign-in within the sudo window. */
export function sessionHasSudo(session: UserSession, now = Date.now()): boolean {
  return now - session.authAt < SUDO_WINDOW_MS;
}

async function removeSession(userId: string, hash: string): Promise<void> {
  const tx = getRedis().multi();
  tx.del(GLOBAL_KEYS.userSession(hash));
  tx.zrem(GLOBAL_KEYS.userSessions(userId), hash);
  await tx.exec();
}

/** Ends this browser's session; returns the header that clears its cookie. */
export async function endUserSession(): Promise<string> {
  const session = await currentUserSession();
  if (session) await removeSession(session.userId, session.hash);
  return clearCookie(await sessionCookieName(), await isHttpsRequest());
}

/** Ends every session of `userId`, on every device. */
export async function endAllUserSessions(userId: string): Promise<number> {
  const hashes = ((await getRedis().zrange(GLOBAL_KEYS.userSessions(userId), 0, -1)) as unknown[]).map(String);
  if (hashes.length === 0) return 0;
  const tx = getRedis().multi();
  for (const hash of hashes) tx.del(GLOBAL_KEYS.userSession(hash));
  tx.del(GLOBAL_KEYS.userSessions(userId));
  await tx.exec();
  return hashes.length;
}

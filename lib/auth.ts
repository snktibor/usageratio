import { randomBytes } from "node:crypto";
import { isDemoMode } from "@/lib/demo/mode";
import { log } from "@/lib/log";
import { getRedis } from "@/lib/redis";
import { clientIp, currentCookies, defer, isHttpsRequest } from "@/lib/request-context";
import { safeEqual, sha256Hex } from "@/lib/security";

/**
 * Dashboard access: a PIN or passphrase (5-64 characters) checked on the
 * server, then a random session id in an HttpOnly cookie. Sessions live in
 * Redis, so logging out (or changing DASHBOARD_PIN) revokes them immediately.
 *
 * Guessing is throttled per IP address, with an escalating lockout for a
 * repeat offender; a separate, smaller global budget only applies to
 * addresses this browser has never logged in from before (no known-device
 * cookie), so a stranger spreading guesses across many IPs cannot lock the
 * owner out of their own dashboard.
 *
 * Sessions roll forward: `isAuthenticated` refreshes the "last seen" stamp
 * (at most once an hour) so an active owner is never logged out by
 * SESSION_IDLE_DAYS, while SESSION_MAX_DAYS is a hard ceiling from creation.
 *
 * A short-lived "sudo" flag on top of a session (`grantSudo` / `hasSudo`)
 * gates the one action that shows a secret in full: revealing the stored API
 * token for copying.
 */
const SESSION_COOKIE = "usageratio_session";
const DEVICE_COOKIE = "usageratio_device";
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** A guess or a configured PIN: 5-64 characters, none of them CR/LF/TAB. */
const PIN_PATTERN = /^[^\r\n\t]{5,64}$/;

export const IP_MAX_ATTEMPTS = 5;
const IP_WINDOW_SECONDS = 15 * 60;
/** How long a strike (a fully exhausted window) is remembered, for the next one to double the lockout. */
const STRIKES_TTL_SECONDS = 24 * 60 * 60;
const BASE_LOCKOUT_SECONDS = 15 * 60;
const MAX_LOCKOUT_SECONDS = 6 * 60 * 60;
const GLOBAL_MAX_ATTEMPTS = 30;
const GLOBAL_WINDOW_SECONDS = 60 * 60;
const GLOBAL_KEY = "usage:auth:global";
const DEVICE_TTL_SECONDS = 365 * 24 * 60 * 60;
const SUDO_TTL_SECONDS = 5 * 60;
const DEFAULT_SESSION_IDLE_DAYS = 7;
const DEFAULT_SESSION_MAX_DAYS = 30;
/** The session's "last seen" is refreshed no more often than this, to spare Redis writes. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: "malformed" | "misconfigured" }
  | { ok: false; reason: "invalid"; attemptsLeft: number }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number };

function configuredPin(): string | null {
  const pin = process.env.DASHBOARD_PIN?.trim() ?? "";
  return PIN_PATTERN.test(pin) ? pin : null;
}

/** What the login form needs to know about the configured PIN, without ever learning its length. */
export function pinShape(): { configured: boolean; numeric: boolean } {
  const pin = process.env.DASHBOARD_PIN?.trim() ?? "";
  const configured = PIN_PATTERN.test(pin);
  return { configured, numeric: configured && /^[0-9]+$/.test(pin) };
}

/**
 * The length to auto-submit at, only when the owner opted into that hint with
 * DASHBOARD_PIN_AUTOSUBMIT=1 (it would otherwise reveal the PIN's length to
 * anyone watching how many keystrokes it takes to submit).
 */
export function autoSubmitLength(): number | null {
  if (process.env.DASHBOARD_PIN_AUTOSUBMIT?.trim() !== "1") return null;
  const pin = configuredPin();
  return pin ? pin.length : null;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Idle timeout: no activity for this long logs the session out. Env SESSION_IDLE_DAYS, default 7. */
function sessionIdleSeconds(): number {
  return positiveIntEnv("SESSION_IDLE_DAYS", DEFAULT_SESSION_IDLE_DAYS) * 24 * 60 * 60;
}

/** Hard ceiling from creation, however active. Env SESSION_MAX_DAYS, default 30. */
function sessionMaxSeconds(): number {
  return positiveIntEnv("SESSION_MAX_DAYS", DEFAULT_SESSION_MAX_DAYS) * 24 * 60 * 60;
}

/** Bound to the PIN: changing DASHBOARD_PIN orphans every existing session. */
function sessionKey(sessionId: string, pin: string): string {
  return `usage:session:${sha256Hex(`${sessionId}:${pin}`)}`;
}

/** The sudo flag lives right next to the session it belongs to. */
function sudoKey(sessionId: string, pin: string): string {
  return `${sessionKey(sessionId, pin)}:sudo`;
}

function deviceKey(deviceId: string): string {
  return `usage:auth:device:${sha256Hex(deviceId)}`;
}

/** The per-IP counter's key fragment: never logged in full (see `logIpHash`). */
function ipHash(ip: string): string {
  return sha256Hex(ip).slice(0, 32);
}

/** A short, log-safe stand-in for the address: enough to correlate lines, not enough to dox anyone. */
function logIpHash(ip: string): string {
  return sha256Hex(ip).slice(0, 12);
}

/** Fixed-window counter: bumps `key` and reports how long until its window ends. */
async function countAttempt(key: string, windowSeconds: number): Promise<{ count: number; retryAfterSeconds: number }> {
  const redis = getRedis();
  const pipeline = redis.pipeline();
  pipeline.incr(key);
  pipeline.ttl(key);
  const [count, ttl] = (await pipeline.exec()).map(Number) as [number, number];

  // A fresh counter (or one that ever lost its expiry) starts its window now.
  if (ttl < 0) await redis.expire(key, windowSeconds);
  return { count, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
}

type IpLimiterResult = { ok: true; attemptsLeft: number } | { ok: false; retryAfterSeconds: number };

/**
 * Per-IP guess budget: `IP_MAX_ATTEMPTS` per 15-minute window. The attempt that
 * fills the window for the first time bumps a 24h "strikes" counter and
 * re-arms the window's own TTL to an escalating lockout
 * (`15min * 2^(strikes-1)`, capped at 6h) instead of the plain 15 minutes;
 * every attempt after that, until the lockout ends, reports that same TTL.
 * Shared by `attemptLogin` and `grantSudo`: guessing the PIN spends the same
 * budget whichever door it is aimed at.
 */
async function checkIpLimiter(hash: string): Promise<IpLimiterResult> {
  const key = `usage:auth:ip:${hash}`;
  const { count, retryAfterSeconds } = await countAttempt(key, IP_WINDOW_SECONDS);
  if (count <= IP_MAX_ATTEMPTS) return { ok: true, attemptsLeft: IP_MAX_ATTEMPTS - count };

  if (count === IP_MAX_ATTEMPTS + 1) {
    const strikes = await countAttempt(`${key}:strikes`, STRIKES_TTL_SECONDS);
    const lockoutSeconds = Math.min(BASE_LOCKOUT_SECONDS * 2 ** (strikes.count - 1), MAX_LOCKOUT_SECONDS);
    await getRedis().expire(key, lockoutSeconds);
    return { ok: false, retryAfterSeconds: lockoutSeconds };
  }
  return { ok: false, retryAfterSeconds };
}

/** The known-device cookie: not an auth factor, only an exemption from the global guess budget. */
async function isKnownDevice(): Promise<boolean> {
  const deviceId = (await currentCookies()).get(DEVICE_COOKIE)?.value;
  if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) return false;
  return Number(await getRedis().exists(deviceKey(deviceId))) === 1;
}

/** Checks the PIN and, when correct, starts a session (sets the cookie). */
export async function attemptLogin(pin: string): Promise<LoginResult> {
  const expected = configuredPin();
  if (!expected) {
    log.error("auth.pin_misconfigured", { rule: "DASHBOARD_PIN must be 5-64 characters (no CR, LF or TAB)" });
    return { ok: false, reason: "misconfigured" };
  }
  // Cannot be the PIN, so it is not a guess worth counting.
  if (!PIN_PATTERN.test(pin)) return { ok: false, reason: "malformed" };

  const redis = getRedis();
  const ip = await clientIp();
  const hash = ipHash(ip);
  const deviceKnown = await isKnownDevice();

  // Attempts are counted *before* the PIN is checked, so parallel guesses cannot outrun a limit.
  const limiter = await checkIpLimiter(hash);
  if (!limiter.ok) {
    log.warn("auth.rate_limited", { scope: "ip", retryAfterSeconds: limiter.retryAfterSeconds, ipHash: logIpHash(ip) });
    return { ok: false, reason: "rate_limited", retryAfterSeconds: limiter.retryAfterSeconds };
  }

  // The global budget only exists to stop guesses spread across many IPs; a browser this
  // owner has already logged in from does not need to share it.
  let globalCounted = false;
  if (!deviceKnown) {
    const overall = await countAttempt(GLOBAL_KEY, GLOBAL_WINDOW_SECONDS);
    globalCounted = true;
    if (overall.count > GLOBAL_MAX_ATTEMPTS) {
      log.warn("auth.rate_limited", {
        scope: "global",
        retryAfterSeconds: overall.retryAfterSeconds,
        ipHash: logIpHash(ip),
      });
      return { ok: false, reason: "rate_limited", retryAfterSeconds: overall.retryAfterSeconds };
    }
  }

  if (!safeEqual(pin, expected)) {
    log.warn("auth.login_failed", { ipHash: logIpHash(ip), attemptsLeft: limiter.attemptsLeft, deviceKnown });
    return { ok: false, reason: "invalid", attemptsLeft: limiter.attemptsLeft };
  }

  const sessionId = randomBytes(32).toString("base64url");
  const newDeviceId = randomBytes(32).toString("base64url");
  const now = Date.now();
  const maxSeconds = sessionMaxSeconds();

  const tx = redis.multi();
  tx.set(sessionKey(sessionId, expected), JSON.stringify({ c: now, s: now }), { ex: maxSeconds });
  tx.set(deviceKey(newDeviceId), "1", { ex: DEVICE_TTL_SECONDS });
  tx.del(`usage:auth:ip:${hash}`);
  tx.del(`usage:auth:ip:${hash}:strikes`);
  if (globalCounted) tx.decr(GLOBAL_KEY); // a successful login is not a failed guess
  await tx.exec();

  const cookies = await currentCookies();
  const secure = await isHttpsRequest();
  cookies.set(SESSION_COOKIE, sessionId, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: maxSeconds });
  cookies.set(DEVICE_COOKIE, newDeviceId, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_TTL_SECONDS,
  });

  log.info("auth.login_ok", { ipHash: logIpHash(ip), deviceKnown });
  return { ok: true };
}

/**
 * Grants sudo (5 minutes) on the current session after re-checking the PIN:
 * the gate in front of revealing the stored API token. Shares the per-IP
 * guess budget with `attemptLogin` and never touches the device cookie or
 * the global budget — a live session is already required to call this.
 */
export async function grantSudo(pin: string): Promise<LoginResult> {
  const expected = configuredPin();
  if (!expected) {
    log.error("auth.pin_misconfigured", { rule: "DASHBOARD_PIN must be 5-64 characters (no CR, LF or TAB)" });
    return { ok: false, reason: "misconfigured" };
  }
  if (!PIN_PATTERN.test(pin)) return { ok: false, reason: "malformed" };

  const ip = await clientIp();
  const hash = ipHash(ip);
  const limiter = await checkIpLimiter(hash);
  if (!limiter.ok) {
    log.warn("auth.rate_limited", { scope: "ip", retryAfterSeconds: limiter.retryAfterSeconds, ipHash: logIpHash(ip) });
    return { ok: false, reason: "rate_limited", retryAfterSeconds: limiter.retryAfterSeconds };
  }

  if (!safeEqual(pin, expected)) {
    log.warn("auth.login_failed", {
      ipHash: logIpHash(ip),
      attemptsLeft: limiter.attemptsLeft,
      deviceKnown: await isKnownDevice(),
    });
    return { ok: false, reason: "invalid", attemptsLeft: limiter.attemptsLeft };
  }

  const sessionId = (await currentCookies()).get(SESSION_COOKIE)?.value;
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) {
    // No live session to grant sudo on; the caller is expected to require one already.
    return { ok: false, reason: "invalid", attemptsLeft: limiter.attemptsLeft };
  }

  const tx = getRedis().multi();
  tx.set(sudoKey(sessionId, expected), "1", { ex: SUDO_TTL_SECONDS });
  tx.del(`usage:auth:ip:${hash}`);
  tx.del(`usage:auth:ip:${hash}:strikes`);
  await tx.exec();
  return { ok: true };
}

/** Whether the current session has sudo, granted by `grantSudo` within the last 5 minutes. */
export async function hasSudo(): Promise<boolean> {
  const pin = configuredPin();
  if (!pin) return false;
  const sessionId = (await currentCookies()).get(SESSION_COOKIE)?.value;
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return false;
  return Number(await getRedis().exists(sudoKey(sessionId, pin))) === 1;
}

interface SessionRecord {
  /** Created at, ms since epoch: the SESSION_MAX_DAYS ceiling counts from here. */
  c: number;
  /** Last seen at, ms since epoch: SESSION_IDLE_DAYS of silence past this logs the session out. */
  s: number;
}

function parseSessionRecord(raw: string): SessionRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Partial<SessionRecord>).c === "number" &&
      typeof (parsed as Partial<SessionRecord>).s === "number"
    ) {
      return parsed as SessionRecord;
    }
  } catch {
    // Falls through to null: an unreadable value is treated like no session.
  }
  return null;
}

/**
 * True only for a live session created with the current PIN. Throws if Redis
 * is unreachable. Rolling: touching the dashboard refreshes the "last seen"
 * stamp (at most once an hour) so an active owner never hits SESSION_IDLE_DAYS;
 * SESSION_MAX_DAYS from creation is a hard ceiling regardless of activity. A
 * legacy session (bare `"1"`, from before rolling sessions) is accepted as
 * freshly seen and upgraded to the new shape, so nobody is logged out by the deploy.
 */
export async function isAuthenticated(): Promise<boolean> {
  // The demo has no PIN: everyone sees the synthetic data, nobody can change it (lib/demo/mode.ts).
  if (isDemoMode()) return true;
  const pin = configuredPin();
  if (!pin) return false;
  const sessionId = (await currentCookies()).get(SESSION_COOKIE)?.value;
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return false;

  const key = sessionKey(sessionId, pin);
  const raw = await getRedis().get<string>(key);
  if (raw === null || raw === undefined) return false;

  const now = Date.now();
  const legacy = raw === "1";
  const record = legacy ? { c: now, s: now } : parseSessionRecord(String(raw));
  if (!record) {
    await getRedis().del(key); // unreadable value: fail closed rather than trust it
    return false;
  }

  const idleMs = sessionIdleSeconds() * 1000;
  const maxMs = sessionMaxSeconds() * 1000;
  if (now - record.s > idleMs || now - record.c > maxMs) {
    await getRedis().del(key);
    return false;
  }

  if (legacy || now - record.s > REFRESH_INTERVAL_MS) {
    const ttlSeconds = Math.max(1, Math.ceil((maxMs - (now - record.c)) / 1000));
    defer(async () => {
      await getRedis().set(key, JSON.stringify({ c: record.c, s: now }), { ex: ttlSeconds });
    });
  }

  return true;
}

/**
 * A short, stable name for the current browser session, for the audit trail:
 * a hash of the session id, never the id itself. Null without a session cookie.
 */
export async function sessionTag(): Promise<string | null> {
  const sessionId = (await currentCookies()).get(SESSION_COOKIE)?.value;
  return sessionId && SESSION_ID_PATTERN.test(sessionId) ? sha256Hex(sessionId).slice(0, 8) : null;
}

export async function endSession(): Promise<void> {
  if (isDemoMode()) return;
  const store = await currentCookies();
  const sessionId = store.get(SESSION_COOKIE)?.value;
  store.delete(SESSION_COOKIE);
  const pin = configuredPin();
  if (pin && sessionId && SESSION_ID_PATTERN.test(sessionId)) {
    const key = sessionKey(sessionId, pin);
    await getRedis().del(key, `${key}:sudo`);
  }
  log.info("auth.logout", {});
}

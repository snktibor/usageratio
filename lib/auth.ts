import { randomBytes } from "node:crypto";
import { isDemoMode } from "@/lib/demo/mode";
import { log } from "@/lib/log";
import { getRedis } from "@/lib/redis";
import { clientIp, currentCookies, isHttpsRequest } from "@/lib/request-context";
import { safeEqual, sha256Hex } from "@/lib/security";

/**
 * Dashboard access: a 5-digit PIN checked on the server, then a random
 * session id in an HttpOnly cookie. Sessions live in Redis, so logging out
 * (or changing DASHBOARD_PIN) revokes them immediately.
 *
 * A 5-digit PIN has only 100 000 combinations, so guessing is throttled
 * twice: per IP address, and globally against guesses spread over many IPs.
 */
const SESSION_COOKIE = "usageratio_session";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const IP_MAX_ATTEMPTS = 5;
const IP_WINDOW_SECONDS = 15 * 60;
const GLOBAL_MAX_ATTEMPTS = 30;
const GLOBAL_WINDOW_SECONDS = 60 * 60;

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: "malformed" | "misconfigured" }
  | { ok: false; reason: "invalid"; attemptsLeft: number }
  | { ok: false; reason: "rate_limited"; retryAfterSeconds: number };

function configuredPin(): string | null {
  const pin = process.env.DASHBOARD_PIN?.trim();
  return pin && /^\d{5}$/.test(pin) ? pin : null;
}

/** Bound to the PIN: changing DASHBOARD_PIN orphans every existing session. */
function sessionKey(sessionId: string, pin: string): string {
  return `usage:session:${sha256Hex(`${sessionId}:${pin}`)}`;
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

/** Checks the PIN and, when correct, starts a session (sets the cookie). */
export async function attemptLogin(pin: string): Promise<LoginResult> {
  const expected = configuredPin();
  if (!expected) {
    log.error("auth.pin_misconfigured", { rule: "DASHBOARD_PIN must be exactly 5 digits" });
    return { ok: false, reason: "misconfigured" };
  }
  // Cannot be the PIN, so it is not a guess worth counting.
  if (!/^\d{5}$/.test(pin)) return { ok: false, reason: "malformed" };

  const redis = getRedis();
  const ipKey = `usage:auth:ip:${sha256Hex(await clientIp()).slice(0, 32)}`;
  const globalKey = "usage:auth:global";

  // Attempts are counted *before* the PIN is checked, so parallel guesses cannot
  // outrun a limit. An address that is already locked out stops at its own
  // counter and adds nothing to the global one.
  const ip = await countAttempt(ipKey, IP_WINDOW_SECONDS);
  if (ip.count > IP_MAX_ATTEMPTS) {
    return { ok: false, reason: "rate_limited", retryAfterSeconds: ip.retryAfterSeconds };
  }
  const overall = await countAttempt(globalKey, GLOBAL_WINDOW_SECONDS);
  if (overall.count > GLOBAL_MAX_ATTEMPTS) {
    return { ok: false, reason: "rate_limited", retryAfterSeconds: overall.retryAfterSeconds };
  }

  if (!safeEqual(pin, expected)) {
    return { ok: false, reason: "invalid", attemptsLeft: Math.max(0, IP_MAX_ATTEMPTS - ip.count) };
  }

  const sessionId = randomBytes(32).toString("base64url");
  const tx = redis.multi();
  tx.set(sessionKey(sessionId, expected), "1", { ex: SESSION_TTL_SECONDS });
  tx.del(ipKey);
  tx.decr(globalKey); // a successful login is not a failed guess
  await tx.exec();

  (await currentCookies()).set(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    secure: await isHttpsRequest(),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return { ok: true };
}

/** True only for a live session created with the current PIN. Throws if Redis is unreachable. */
export async function isAuthenticated(): Promise<boolean> {
  // The demo has no PIN: everyone sees the synthetic data, nobody can change it (lib/demo/mode.ts).
  if (isDemoMode()) return true;
  const pin = configuredPin();
  if (!pin) return false;
  const sessionId = (await currentCookies()).get(SESSION_COOKIE)?.value;
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return false;
  return Number(await getRedis().exists(sessionKey(sessionId, pin))) === 1;
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
    await getRedis().del(sessionKey(sessionId, pin));
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attemptLogin, endSession, IP_MAX_ATTEMPTS, isAuthenticated, type LoginResult, sessionTag } from "@/lib/auth";
import { sha256Hex } from "@/lib/security";
import { useRedis } from "./helpers/redis-fixture";
import { fakeCookieJar, withRequest } from "./helpers/request";

/**
 * Characterization tests: what lib/auth.ts does today, pinned so the M2
 * hardening (longer PINs, known-device cookie, per-IP escalation, sudo mode,
 * rolling sessions) changes it knowingly.
 */

const PIN = "12345";
const SESSION_COOKIE = "usageratio_session";
const IP_WINDOW_SECONDS = 15 * 60;
const GLOBAL_WINDOW_SECONDS = 60 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const ipKey = (ip: string) => `usage:auth:ip:${sha256Hex(ip).slice(0, 32)}`;
const GLOBAL_KEY = "usage:auth:global";

/** One login attempt from `ip` (or an anonymous one), with a fresh cookie jar unless given. */
function login(pin: string, ip?: string, jar = fakeCookieJar(), headers: Record<string, string> = {}) {
  return withRequest(() => attemptLogin(pin), {
    headers: { ...(ip && { "x-forwarded-for": ip }), ...headers },
    cookies: jar,
  });
}

function expectInvalid(result: LoginResult, attemptsLeft: number) {
  expect(result).toEqual({ ok: false, reason: "invalid", attemptsLeft });
}

describe("attemptLogin", () => {
  const redis = useRedis();

  beforeEach(() => {
    vi.stubEnv("DASHBOARD_PIN", PIN);
    // Off Vercel: the forwarded headers are trusted by default, https is not assumed.
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_PROXY", "");
    vi.stubEnv("COOKIE_SECURE", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  describe("the configured PIN", () => {
    it("must be set", async () => {
      vi.stubEnv("DASHBOARD_PIN", "");
      expect(await login(PIN)).toEqual({ ok: false, reason: "misconfigured" });
    });

    it("must be exactly 5 digits (current rule; M2 allows 5–64 characters)", async () => {
      for (const configured of ["1234", "123456", "12a45", "abcde"]) {
        vi.stubEnv("DASHBOARD_PIN", configured);
        expect(await login(configured), configured).toEqual({ ok: false, reason: "misconfigured" });
      }
    });

    it("is trimmed", async () => {
      vi.stubEnv("DASHBOARD_PIN", "  12345 \n");
      expect(await login(PIN)).toEqual({ ok: true });
    });
  });

  describe("a malformed guess", () => {
    it("is refused without touching any counter", async () => {
      for (const guess of ["1234", "abcde", "", "123456", "12 45"]) {
        expect(await login(guess, "203.0.113.9"), guess).toEqual({ ok: false, reason: "malformed" });
      }
      const keys = Object.keys(redis.store?.dump() ?? {}).filter((key) => key.startsWith("usage:auth:"));
      expect(keys).toEqual([]);
    });
  });

  describe("the per-IP limit", () => {
    it(`allows ${IP_MAX_ATTEMPTS} wrong guesses, counting down, then locks the address out for the window`, async () => {
      const ip = "203.0.113.9";
      expectInvalid(await login("00000", ip), 4);
      expectInvalid(await login("00001", ip), 3);
      expectInvalid(await login("00002", ip), 2);
      expectInvalid(await login("00003", ip), 1);
      expectInvalid(await login("00004", ip), 0);

      const sixth = await login("00005", ip);
      expect(sixth.ok).toBe(false);
      if (sixth.ok || sixth.reason !== "rate_limited")
        throw new Error(`expected rate_limited, got ${JSON.stringify(sixth)}`);
      expect(sixth.retryAfterSeconds).toBeGreaterThan(0);
      expect(sixth.retryAfterSeconds).toBeLessThanOrEqual(IP_WINDOW_SECONDS);

      // Even the correct PIN is refused while the address is locked out.
      const correct = await login(PIN, ip);
      expect(correct).toMatchObject({ ok: false, reason: "rate_limited" });

      // The window starts with the first attempt; the global counter got the five counted guesses only.
      expect(redis.store?.ttl(ipKey(ip)) ?? IP_WINDOW_SECONDS).toBeLessThanOrEqual(IP_WINDOW_SECONDS);
      expect(await redis.store?.dump()[GLOBAL_KEY]?.value).toBe(redis.real ? undefined : "5");
    });

    it("forgets the address once its window has passed", async ({ skip }) => {
      if (redis.real) skip();
      const ip = "203.0.113.9";
      for (let i = 0; i < 6; i += 1) await login("00000", ip);
      expect(await login("00000", ip)).toMatchObject({ ok: false, reason: "rate_limited" });

      redis.store?.clock.advance(IP_WINDOW_SECONDS * 1000);
      expectInvalid(await login("00000", ip), 4);
    });

    it("keeps addresses apart", async () => {
      for (let i = 0; i < 5; i += 1) await login("00000", "203.0.113.9");
      expect(await login("00000", "203.0.113.9")).toMatchObject({ ok: false, reason: "rate_limited" });
      expectInvalid(await login("00000", "198.51.100.7"), 4);
    });

    it("takes the first address of x-forwarded-for, then x-real-ip, else one shared 'unknown' bucket", async () => {
      expectInvalid(await login("00000", "203.0.113.9, 10.0.0.1"), 4);
      expectInvalid(await login("00000", "203.0.113.9"), 3);
      expectInvalid(await login("00000", undefined, fakeCookieJar(), { "x-real-ip": "203.0.113.9" }), 2);
      expectInvalid(await login("00000"), 4); // no header at all: "unknown"
      expect(redis.store?.keys().filter((key) => key.startsWith("usage:auth:ip:"))).toEqual(
        redis.real ? undefined : [ipKey("203.0.113.9"), ipKey("unknown")].sort(),
      );
    });

    it("with TRUST_PROXY=0 every client shares the 'unknown' bucket (self-hosting without a proxy)", async () => {
      vi.stubEnv("TRUST_PROXY", "0");
      for (let i = 0; i < 5; i += 1) await login("00000", "203.0.113.9");
      // A different forwarded address is not believed: it hits the same counter.
      expect(await login("00000", "198.51.100.7")).toMatchObject({ ok: false, reason: "rate_limited" });
      expect(redis.store?.keys().filter((key) => key.startsWith("usage:auth:ip:"))).toEqual(
        redis.real ? undefined : [ipKey("unknown")],
      );
    });
  });

  describe("the global limit (current behaviour: a stranger can exhaust the global budget for everyone)", () => {
    it("locks every address out once 30 guesses failed within the hour, whoever made them", async () => {
      // Six addresses, five counted guesses each: the global counter reaches 30.
      for (let address = 1; address <= 6; address += 1) {
        for (let i = 0; i < 5; i += 1) expect((await login("00000", `203.0.113.${address}`)).ok).toBe(false);
      }
      expect(redis.store?.dump()[GLOBAL_KEY]?.value ?? "30").toBe("30");
      expect(redis.store?.ttl(GLOBAL_KEY) ?? GLOBAL_WINDOW_SECONDS).toBeLessThanOrEqual(GLOBAL_WINDOW_SECONDS);

      // A seventh, untouched address is refused on its very first try, even with the right PIN.
      const stranger = await login(PIN, "203.0.113.7");
      expect(stranger).toMatchObject({ ok: false, reason: "rate_limited" });
      if (stranger.ok || stranger.reason !== "rate_limited") throw new Error("unreachable");
      expect(stranger.retryAfterSeconds).toBeLessThanOrEqual(GLOBAL_WINDOW_SECONDS);
    });

    it("does not count the guesses an already locked-out address makes", async () => {
      for (let i = 0; i < 9; i += 1) await login("00000", "203.0.113.9");
      expect(redis.store?.dump()[GLOBAL_KEY]?.value ?? "5").toBe("5");
    });
  });

  describe("a correct PIN", () => {
    it("starts a 30-day session bound to the PIN, clears the address, refunds the global guess, sets the cookie", async () => {
      const ip = "203.0.113.9";
      await login("00000", ip);
      const jar = fakeCookieJar();
      expect(await login(PIN, ip, jar)).toEqual({ ok: true });

      expect(jar.sets).toHaveLength(1);
      const cookie = jar.sets[0]!;
      expect(cookie.name).toBe(SESSION_COOKIE);
      expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(cookie.options).toEqual({
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_TTL_SECONDS,
      });

      const sessionKey = `usage:session:${sha256Hex(`${cookie.value}:${PIN}`)}`;
      const dump = redis.store?.dump();
      if (dump) {
        expect(dump[sessionKey]).toEqual({ type: "string", value: "1", ttl: SESSION_TTL_SECONDS });
        expect(dump[ipKey(ip)]).toBeUndefined();
        // The success was counted first and refunded after; the earlier failed guess stays counted
        // (the address's own counter is wiped, the global one is not).
        expect(dump[GLOBAL_KEY]?.value).toBe("1");
        expect(redis.store?.ttl(GLOBAL_KEY)).toBeLessThanOrEqual(GLOBAL_WINDOW_SECONDS);
      }
    });

    it("marks the cookie Secure behind an https proxy, on Vercel, or with COOKIE_SECURE=true", async () => {
      const secureOf = (jar: ReturnType<typeof fakeCookieJar>) => jar.sets[0]?.options?.secure;

      const proxied = fakeCookieJar();
      await login(PIN, "203.0.113.1", proxied, { "x-forwarded-proto": "https" });
      expect(secureOf(proxied)).toBe(true);

      const vercel = fakeCookieJar();
      vi.stubEnv("VERCEL", "1");
      await login(PIN, "203.0.113.2", vercel);
      expect(secureOf(vercel)).toBe(true);
      vi.stubEnv("VERCEL", "");

      const forced = fakeCookieJar();
      vi.stubEnv("COOKIE_SECURE", "true");
      await login(PIN, "203.0.113.3", forced);
      expect(secureOf(forced)).toBe(true);

      const forcedOff = fakeCookieJar();
      vi.stubEnv("COOKIE_SECURE", "false");
      await login(PIN, "203.0.113.4", forcedOff, { "x-forwarded-proto": "https" });
      expect(secureOf(forcedOff)).toBe(false);
    });
  });

  describe("isAuthenticated / sessionTag / endSession", () => {
    it("recognises the session it issued, and only with the PIN it was issued under", async () => {
      const jar = fakeCookieJar();
      await login(PIN, "203.0.113.9", jar);
      const sessionId = jar.values[SESSION_COOKIE]!;

      expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(true);
      expect(await withRequest(() => isAuthenticated(), { cookies: fakeCookieJar() })).toBe(false);
      expect(await withRequest(() => isAuthenticated(), { cookies: fakeCookieJar({ [SESSION_COOKIE]: "nope" }) })).toBe(
        false,
      );
      const forged = fakeCookieJar({ [SESSION_COOKIE]: "A".repeat(43) });
      expect(await withRequest(() => isAuthenticated(), { cookies: forged })).toBe(false);

      // Changing DASHBOARD_PIN orphans every session; an unset one refuses everything.
      vi.stubEnv("DASHBOARD_PIN", "54321");
      expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(false);
      vi.stubEnv("DASHBOARD_PIN", "");
      expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(false);
      vi.stubEnv("DASHBOARD_PIN", PIN);
      expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(true);

      // The session's tag is a hash of the id, never the id.
      const tag = await withRequest(() => sessionTag(), { cookies: jar });
      expect(tag).toMatch(/^[0-9a-f]{8}$/);
      expect(tag).toBe(sha256Hex(sessionId).slice(0, 8));
      expect(await withRequest(() => sessionTag(), { cookies: fakeCookieJar() })).toBeNull();
      expect(await withRequest(() => sessionTag(), { cookies: fakeCookieJar({ [SESSION_COOKIE]: "x" }) })).toBeNull();
    });

    it("expires the session after 30 days", async ({ skip }) => {
      if (redis.real) skip();
      const jar = fakeCookieJar();
      await login(PIN, "203.0.113.9", jar);
      redis.store?.clock.advance(SESSION_TTL_SECONDS * 1000 - 1000);
      expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(true);
      redis.store?.clock.advance(1000);
      expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(false);
    });

    it("endSession deletes the key and the cookie, and is harmless without a session", async () => {
      const jar = fakeCookieJar();
      await login(PIN, "203.0.113.9", jar);
      await withRequest(() => endSession(), { cookies: jar });
      expect(jar.deleted).toEqual([SESSION_COOKIE]);
      expect(jar.values[SESSION_COOKIE]).toBeUndefined();
      expect(redis.store?.keys().filter((key) => key.startsWith("usage:session:")) ?? []).toEqual([]);

      const empty = fakeCookieJar();
      await withRequest(() => endSession(), { cookies: empty });
      expect(empty.deleted).toEqual([SESSION_COOKIE]);
    });
  });
});

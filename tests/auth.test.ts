import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attemptLogin,
  autoSubmitLength,
  endSession,
  grantSudo,
  hasSudo,
  IP_MAX_ATTEMPTS,
  isAuthenticated,
  type LoginResult,
  pinShape,
  sessionTag,
} from "@/lib/auth";
import { getRedis } from "@/lib/redis";
import { flushDeferred } from "@/lib/request-context";
import { sha256Hex } from "@/lib/security";
import { useRedis } from "./helpers/redis-fixture";
import { fakeCookieJar, withRequest } from "./helpers/request";

/**
 * Characterization + M2 tests: variable-length PIN/passphrase, an escalating
 * per-IP lockout in place of the old global one, a known-device exemption
 * from the (now narrower) global budget, rolling sessions, and sudo mode.
 */

const PIN = "12345";
const SESSION_COOKIE = "usageratio_session";
const DEVICE_COOKIE = "usageratio_device";
const IP_WINDOW_SECONDS = 15 * 60;
const GLOBAL_WINDOW_SECONDS = 60 * 60;
const SESSION_MAX_SECONDS = 30 * 24 * 60 * 60;
const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;
const DEVICE_TTL_SECONDS = 365 * 24 * 60 * 60;
const SUDO_TTL_SECONDS = 5 * 60;
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

const ipKey = (ip: string) => `usage:auth:ip:${sha256Hex(ip).slice(0, 32)}`;
const strikesKey = (ip: string) => `${ipKey(ip)}:strikes`;
const sessionKeyOf = (sessionId: string, pin: string) => `usage:session:${sha256Hex(`${sessionId}:${pin}`)}`;
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

describe("pinShape", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports configured/numeric, and never the length", () => {
    vi.stubEnv("DASHBOARD_PIN", "12345");
    expect(pinShape()).toEqual({ configured: true, numeric: true });

    vi.stubEnv("DASHBOARD_PIN", "correct horse battery staple");
    expect(pinShape()).toEqual({ configured: true, numeric: false });

    vi.stubEnv("DASHBOARD_PIN", "1234"); // too short
    expect(pinShape()).toEqual({ configured: false, numeric: false });

    vi.stubEnv("DASHBOARD_PIN", "x".repeat(65)); // too long
    expect(pinShape()).toEqual({ configured: false, numeric: false });

    vi.stubEnv("DASHBOARD_PIN", "");
    expect(pinShape()).toEqual({ configured: false, numeric: false });

    vi.stubEnv("DASHBOARD_PIN", "  12345  ");
    expect(pinShape()).toEqual({ configured: true, numeric: true }); // trimmed
  });
});

describe("autoSubmitLength", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is null unless the owner opts in with DASHBOARD_PIN_AUTOSUBMIT=1", () => {
    vi.stubEnv("DASHBOARD_PIN", "12345");
    vi.stubEnv("DASHBOARD_PIN_AUTOSUBMIT", "");
    expect(autoSubmitLength()).toBeNull();

    vi.stubEnv("DASHBOARD_PIN_AUTOSUBMIT", "1");
    expect(autoSubmitLength()).toBe(5);

    vi.stubEnv("DASHBOARD_PIN", "a longer passphrase");
    expect(autoSubmitLength()).toBe(19);

    vi.stubEnv("DASHBOARD_PIN", "1234"); // misconfigured: nothing to submit at
    expect(autoSubmitLength()).toBeNull();
  });
});

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
    it("must be 5 to 64 characters, with no CR, LF or TAB", async () => {
      for (const configured of ["1234", "x".repeat(65), "12\t45", "12\n45", "12\r45"]) {
        vi.stubEnv("DASHBOARD_PIN", configured);
        expect(await login(configured), JSON.stringify(configured)).toEqual({ ok: false, reason: "misconfigured" });
      }
    });

    it("accepts the 5 and 64 character boundaries, digits or not", async () => {
      vi.stubEnv("DASHBOARD_PIN", "12345");
      expect(await login("12345")).toEqual({ ok: true });

      vi.stubEnv("DASHBOARD_PIN", "x".repeat(64));
      expect(await login("x".repeat(64), "203.0.113.199")).toEqual({ ok: true });

      vi.stubEnv("DASHBOARD_PIN", "correct horse battery staple");
      expect(await login("correct horse battery staple", "203.0.113.198")).toEqual({ ok: true });
    });

    it("is trimmed", async () => {
      vi.stubEnv("DASHBOARD_PIN", "  12345 \n");
      expect(await login(PIN)).toEqual({ ok: true });
    });
  });

  describe("a malformed guess", () => {
    it("is refused without touching any counter", async () => {
      for (const guess of ["1234", "x".repeat(65), "abcde".slice(0, 4), "", "1\t234", "12\r45", "12\n45"]) {
        expect(await login(guess, "203.0.113.9"), JSON.stringify(guess)).toEqual({ ok: false, reason: "malformed" });
      }
      const keys = Object.keys(redis.store?.dump() ?? {}).filter((key) => key.startsWith("usage:auth:"));
      expect(keys).toEqual([]);
    });
  });

  describe("the per-IP limit", () => {
    it(`allows ${IP_MAX_ATTEMPTS} wrong guesses, counting down, then locks the address out for 15 minutes`, async () => {
      const ip = "203.0.113.9";
      expectInvalid(await login("00000", ip), 4);
      expectInvalid(await login("00001", ip), 3);
      expectInvalid(await login("00002", ip), 2);
      expectInvalid(await login("00003", ip), 1);
      expectInvalid(await login("00004", ip), 0);

      const sixth = await login("00005", ip);
      expect(sixth).toEqual({ ok: false, reason: "rate_limited", retryAfterSeconds: IP_WINDOW_SECONDS });

      // Even the correct PIN is refused while the address is locked out.
      const correct = await login(PIN, ip);
      expect(correct).toEqual({ ok: false, reason: "rate_limited", retryAfterSeconds: IP_WINDOW_SECONDS });

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
      expect(
        redis.store?.keys().filter((key) => key.startsWith("usage:auth:ip:") && !key.endsWith(":strikes")),
      ).toEqual(redis.real ? undefined : [ipKey("203.0.113.9"), ipKey("unknown")].sort());
    });

    it("with TRUST_PROXY=0 every client shares the 'unknown' bucket (self-hosting without a proxy)", async () => {
      vi.stubEnv("TRUST_PROXY", "0");
      for (let i = 0; i < 5; i += 1) await login("00000", "203.0.113.9");
      // A different forwarded address is not believed: it hits the same counter.
      expect(await login("00000", "198.51.100.7")).toMatchObject({ ok: false, reason: "rate_limited" });
      expect(
        redis.store?.keys().filter((key) => key.startsWith("usage:auth:ip:") && !key.endsWith(":strikes")),
      ).toEqual(redis.real ? undefined : [ipKey("unknown")]);
    });

    it("doubles the lockout for a repeat offender, capped at 6 hours, once a window fills", async () => {
      const ip = "203.0.113.30";
      for (let i = 0; i < 6; i += 1) await login("00000", ip);
      expect(await login("00000", ip)).toMatchObject({ retryAfterSeconds: 15 * 60 }); // strike 1: 15min * 2^0

      const advanceRedis = redis.store;
      if (!advanceRedis) return; // strikes escalation needs the fake clock (skip on real Redis)

      advanceRedis.clock.advance(15 * 60 * 1000 + 1000);
      for (let i = 0; i < 6; i += 1) await login("00000", ip);
      expect(await login("00000", ip)).toMatchObject({ retryAfterSeconds: 30 * 60 }); // strike 2: 15min * 2^1

      // Jump ahead to a high strike count directly, to prove the lockout is capped rather than unbounded.
      advanceRedis.clock.advance(30 * 60 * 1000 + 1000);
      await getRedis().set(strikesKey(ip), "10", { ex: 24 * 60 * 60 });
      for (let i = 0; i < 6; i += 1) await login("00000", ip);
      expect(await login("00000", ip)).toMatchObject({ retryAfterSeconds: 6 * 60 * 60 });
    });
  });

  describe("the global limit", () => {
    it("blocks a stranger (no known-device cookie) once 30 guesses failed across many addresses", async () => {
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

    it("does not apply to a request carrying a known-device cookie, even once exhausted", async () => {
      // Mint a known device on this browser first, while the global budget is still fresh.
      const jar = fakeCookieJar();
      expect(await login(PIN, "203.0.113.9", jar)).toEqual({ ok: true });

      // Exhaust the global budget from six other, unknown-device addresses.
      for (let address = 1; address <= 6; address += 1) {
        for (let i = 0; i < 5; i += 1) await login("00000", `198.51.100.${address}`);
      }
      // A fresh, unknown-device address is blocked by the exhausted global budget.
      expect(await login(PIN, "203.0.113.250")).toMatchObject({ ok: false, reason: "rate_limited" });

      // The already-known device, logging in again from a brand new IP, is unaffected by it.
      expect(await login(PIN, "203.0.113.251", jar)).toEqual({ ok: true });
    });
  });

  describe("a correct PIN", () => {
    it("starts a rolling session, mints a device cookie, clears the address, refunds the global guess", async () => {
      const ip = "203.0.113.9";
      await login("00000", ip);
      const jar = fakeCookieJar();
      const before = Date.now();
      expect(await login(PIN, ip, jar)).toEqual({ ok: true });

      expect(jar.sets).toHaveLength(2);
      const [sessionCookie, deviceCookie] = jar.sets;
      expect(sessionCookie!.name).toBe(SESSION_COOKIE);
      expect(sessionCookie!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(sessionCookie!.options).toEqual({
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: SESSION_MAX_SECONDS,
      });
      expect(deviceCookie!.name).toBe(DEVICE_COOKIE);
      expect(deviceCookie!.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(deviceCookie!.options).toEqual({
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
        maxAge: DEVICE_TTL_SECONDS,
      });

      const key = sessionKeyOf(sessionCookie!.value, PIN);
      const deviceRedisKey = `usage:auth:device:${sha256Hex(deviceCookie!.value)}`;
      const dump = redis.store?.dump();
      if (dump) {
        expect(dump[key]?.type).toBe("string");
        const record = JSON.parse(String(dump[key]?.value)) as { c: number; s: number };
        expect(record.c).toBeGreaterThanOrEqual(before);
        expect(record.s).toBe(record.c);
        expect(dump[key]?.ttl).toBeLessThanOrEqual(SESSION_MAX_SECONDS);
        expect(dump[deviceRedisKey]).toEqual({ type: "string", value: "1", ttl: DEVICE_TTL_SECONDS });
        expect(dump[ipKey(ip)]).toBeUndefined();
        expect(dump[strikesKey(ip)]).toBeUndefined();
        // The success was counted first and refunded after; the earlier failed guess stays counted
        // (the address's own counter is wiped, the global one is not).
        expect(dump[GLOBAL_KEY]?.value).toBe("1");
        expect(redis.store?.ttl(GLOBAL_KEY)).toBeLessThanOrEqual(GLOBAL_WINDOW_SECONDS);
      }
    });

    it("marks the cookies Secure behind an https proxy, on Vercel, or with COOKIE_SECURE=true", async () => {
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

  describe("logging", () => {
    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => vi.restoreAllMocks());

    it("never writes the PIN, guessed or configured, to the logs", async () => {
      await login("00000", "203.0.113.40"); // failed guess
      await login(PIN, "203.0.113.40"); // successful guess

      const lines = [
        ...(console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls,
        ...(console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls,
      ].map((call) => String(call[0]));
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.some((line) => line.includes("auth.login_failed"))).toBe(true);
      expect(lines.some((line) => line.includes("auth.login_ok"))).toBe(true);
      const text = lines.join("\n");
      expect(text).not.toContain("00000");
      expect(text).not.toContain(PIN);
    });
  });
});

describe("grantSudo / hasSudo", () => {
  const redis = useRedis();

  beforeEach(() => {
    vi.stubEnv("DASHBOARD_PIN", PIN);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_PROXY", "");
    vi.stubEnv("COOKIE_SECURE", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("grants sudo on the current session for 5 minutes, then expires", async ({ skip }) => {
    if (redis.real) skip();
    const jar = fakeCookieJar();
    await login(PIN, "203.0.113.20", jar);
    expect(await withRequest(() => hasSudo(), { cookies: jar })).toBe(false);

    const granted = await withRequest(() => grantSudo(PIN), {
      headers: { "x-forwarded-for": "203.0.113.20" },
      cookies: jar,
    });
    expect(granted).toEqual({ ok: true });
    expect(await withRequest(() => hasSudo(), { cookies: jar })).toBe(true);

    const sessionId = jar.values[SESSION_COOKIE]!;
    const key = `${sessionKeyOf(sessionId, PIN)}:sudo`;
    expect(redis.store?.ttl(key)).toBeLessThanOrEqual(SUDO_TTL_SECONDS);

    redis.store?.clock.advance(SUDO_TTL_SECONDS * 1000 + 1000);
    expect(await withRequest(() => hasSudo(), { cookies: jar })).toBe(false);
  });

  it("shares the per-IP guess budget with login, and needs a live session", async () => {
    const jar = fakeCookieJar();
    await login(PIN, "203.0.113.21", jar);

    const wrong = await withRequest(() => grantSudo("00000"), {
      headers: { "x-forwarded-for": "203.0.113.21" },
      cookies: jar,
    });
    expectInvalid(wrong, IP_MAX_ATTEMPTS - 1);
    expect(await withRequest(() => hasSudo(), { cookies: jar })).toBe(false);

    // The same address now has one fewer guess left for an ordinary login too.
    expectInvalid(await login("00000", "203.0.113.21"), IP_MAX_ATTEMPTS - 2);

    // A correct PIN with no session cookie at all cannot be granted sudo.
    const noSession = await withRequest(() => grantSudo(PIN), { headers: { "x-forwarded-for": "203.0.113.22" } });
    expectInvalid(noSession, IP_MAX_ATTEMPTS - 1);
  });

  it("clears the address's counter on a granted sudo, same as a successful login", async () => {
    const jar = fakeCookieJar();
    await login(PIN, "203.0.113.23", jar);
    await login("00000", "203.0.113.23"); // one failed guess against the same address

    const granted = await withRequest(() => grantSudo(PIN), {
      headers: { "x-forwarded-for": "203.0.113.23" },
      cookies: jar,
    });
    expect(granted).toEqual({ ok: true });
    expect(redis.store?.dump()[ipKey("203.0.113.23")]).toBeUndefined();
  });
});

describe("isAuthenticated / sessionTag / endSession", () => {
  const redis = useRedis();

  beforeEach(() => {
    vi.stubEnv("DASHBOARD_PIN", PIN);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_PROXY", "");
    vi.stubEnv("COOKIE_SECURE", "");
  });
  afterEach(() => vi.unstubAllEnvs());

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

  // The idle/max/refresh windows are measured with Date.now(), not the fake Redis clock
  // (that clock only paces the store's own TTL bookkeeping) — these two use vi's fake
  // timers to move real time forward instead of `redis.store.clock.advance`.
  it("idles out after SESSION_IDLE_DAYS with no activity at all", async ({ skip }) => {
    if (redis.real) skip();
    const jar = fakeCookieJar();
    await login(PIN, "203.0.113.9", jar);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + SESSION_IDLE_SECONDS * 1000 + 1000);
      expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    expect(redis.store?.keys().filter((key) => key.startsWith("usage:session:"))).toEqual([]);
  });

  it("rolls forward: activity refreshes 'last seen' (at most once an hour) via defer", async ({ skip }) => {
    if (redis.real) skip();
    const jar = fakeCookieJar();
    await login(PIN, "203.0.113.9", jar);
    const sessionId = jar.values[SESSION_COOKIE]!;
    const key = sessionKeyOf(sessionId, PIN);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + REFRESH_INTERVAL_MS + 1000);
      expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(true);
      await flushDeferred();

      const firstRefresh = redis.store?.dump()[key];
      const firstRecord = JSON.parse(String(firstRefresh?.value)) as { c: number; s: number };
      expect(firstRecord.s).toBeGreaterThan(firstRecord.c);
      expect(firstRefresh?.ttl).toBeLessThanOrEqual(SESSION_MAX_SECONDS);

      // Staying alive well past the ORIGINAL creation's idle window, thanks to that refresh
      // (and, being itself >1h since the last refresh, this check refreshes 's' again).
      vi.setSystemTime(Date.now() + (SESSION_IDLE_SECONDS * 1000 - REFRESH_INTERVAL_MS - 2000));
      expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(true);
      await flushDeferred();
      const secondRefresh = redis.store?.dump()[key];
      expect(secondRefresh?.value).not.toBe(firstRefresh?.value);

      // A check moments later (well under another hour since THAT refresh) does not write again.
      vi.setSystemTime(Date.now() + 1000);
      expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(true);
      await flushDeferred();
      expect(redis.store?.dump()[key]?.value).toBe(secondRefresh?.value);
    } finally {
      vi.useRealTimers();
    }
  });

  it("SESSION_MAX_DAYS is a hard ceiling from creation, however active", async ({ skip }) => {
    if (redis.real) skip();
    const jar = fakeCookieJar();
    await login(PIN, "203.0.113.9", jar);
    const sessionId = jar.values[SESSION_COOKIE]!;
    const key = sessionKeyOf(sessionId, PIN);

    const now = redis.store!.clock.now();
    // Created just over SESSION_MAX_DAYS ago, but "seen" a moment ago: idle alone would allow it.
    await getRedis().set(key, JSON.stringify({ c: now - (SESSION_MAX_SECONDS * 1000 + 1000), s: now - 1000 }));
    expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(false);
    expect(redis.store?.dump()[key]).toBeUndefined();
  });

  it("accepts and upgrades a legacy bare '1' session, without forcing a re-login", async ({ skip }) => {
    if (redis.real) skip();
    const sessionId = "A".repeat(43);
    const jar = fakeCookieJar({ [SESSION_COOKIE]: sessionId });
    const key = sessionKeyOf(sessionId, PIN);
    await getRedis().set(key, "1", { ex: SESSION_MAX_SECONDS });

    expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(true);
    await flushDeferred();

    const dump = redis.store?.dump()[key];
    expect(dump?.value).not.toBe("1");
    const record = JSON.parse(String(dump?.value)) as { c: number; s: number };
    expect(record.c).toBe(record.s);
    expect(dump?.ttl).toBeLessThanOrEqual(SESSION_MAX_SECONDS);

    // Still authenticated afterwards, with no cookie change: nobody was logged out by the upgrade.
    expect(await withRequest(() => isAuthenticated(), { cookies: jar })).toBe(true);
  });

  it("endSession deletes the session (and any sudo grant) and the cookie, harmless without a session", async () => {
    const jar = fakeCookieJar();
    await login(PIN, "203.0.113.9", jar);
    await withRequest(() => grantSudo(PIN), { headers: { "x-forwarded-for": "203.0.113.9" }, cookies: jar });

    await withRequest(() => endSession(), { cookies: jar });
    expect(jar.deleted).toEqual([SESSION_COOKIE]);
    expect(jar.values[SESSION_COOKIE]).toBeUndefined();
    expect(redis.store?.keys().filter((key) => key.startsWith("usage:session:")) ?? []).toEqual([]);

    const empty = fakeCookieJar();
    await withRequest(() => endSession(), { cookies: empty });
    expect(empty.deleted).toEqual([SESSION_COOKIE]);
  });
});

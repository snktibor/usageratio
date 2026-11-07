import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeCode, fetchGithubUser, githubConfig } from "@/lib/github";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { isMultiTenant, registrationMode } from "@/lib/registration";
import { safeLocale, safeReturnTo } from "@/lib/sign-in";
import {
  consumeSignupCode,
  createSignupCode,
  listSignupCodes,
  revokeSignupCode,
  signupCodeHash,
  signupCodeIsLive,
} from "@/lib/signup-codes";
import { currentUserSession, endAllUserSessions, startUserSession } from "@/lib/user-session";
import { useRedis } from "./helpers/redis-fixture";
import { fakeCookieJar, withRequest } from "./helpers/request";

const CONFIG = { clientId: "id", clientSecret: "secret", redirectUri: "https://app.example/api/auth/github/callback" };

describe("registrationMode", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is closed unless it says invite or open, and always closed in the demo", () => {
    expect(registrationMode({})).toBe("closed");
    expect(registrationMode({ REGISTRATION: " Invite " })).toBe("invite");
    expect(registrationMode({ REGISTRATION: "open" })).toBe("open");
    expect(registrationMode({ REGISTRATION: "everyone" })).toBe("closed");
    expect(isMultiTenant({ REGISTRATION: "closed" })).toBe(false);
    vi.stubEnv("DEMO_MODE", "1");
    expect(registrationMode({ REGISTRATION: "open" })).toBe("closed");
  });
});

describe("githubConfig", () => {
  it("needs the id, the secret and an https site URL (or http on a loopback host)", () => {
    const base = { GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" };
    expect(githubConfig({ ...base, NEXT_PUBLIC_SITE_URL: "https://app.example/some/path" })?.redirectUri).toBe(
      "https://app.example/api/auth/github/callback",
    );
    expect(githubConfig({ ...base, NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3000" })?.redirectUri).toBe(
      "http://127.0.0.1:3000/api/auth/github/callback",
    );
    expect(githubConfig({ ...base, NEXT_PUBLIC_SITE_URL: "http://app.example" })).toBeNull();
    expect(githubConfig({ ...base })).toBeNull();
    expect(githubConfig({ GITHUB_CLIENT_ID: "id", NEXT_PUBLIC_SITE_URL: "https://app.example" })).toBeNull();
  });
});

describe("talking to GitHub", () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (body: unknown, status = 200) =>
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));

  it("takes only a well-formed account", async () => {
    answer({ id: 42, login: "octo-cat" });
    expect(await fetchGithubUser("t")).toEqual({ id: 42, login: "octo-cat" });
    answer({ id: 43, login: "jdoe_acme" }); // an Enterprise Managed User
    expect(await fetchGithubUser("t")).toEqual({ id: 43, login: "jdoe_acme" });
    for (const bad of [
      { id: "42", login: "x" },
      { id: -1, login: "x" },
      { id: 1, login: "<b>" },
      { id: 1, login: "a b" },
    ]) {
      answer(bad);
      expect(await fetchGithubUser("t")).toBeNull();
    }
    answer({ id: 42, login: "octo" }, 401);
    expect(await fetchGithubUser("t")).toBeNull();
  });

  it("returns null for a refused code or an unreachable GitHub", async () => {
    answer({ error: "bad_verification_code" });
    expect(await exchangeCode(CONFIG, "c", "v")).toBeNull();
    answer({ access_token: "gho_x" }, 500);
    expect(await exchangeCode(CONFIG, "c", "v")).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(await exchangeCode(CONFIG, "c", "v")).toBeNull();
    expect(await fetchGithubUser("t")).toBeNull();
  });
});

describe("the allow-lists", () => {
  it("returns only to the sign-in pages, in a known locale", () => {
    expect(safeReturnTo("/settings")).toBe("/settings");
    expect(safeReturnTo("/setup")).toBe("/setup");
    for (const bad of ["https://evil.example", "//evil", "/api/export", "settings", 1, null]) {
      expect(safeReturnTo(bad)).toBe("/");
    }
    expect(safeLocale("hu")).toBe("hu");
    expect(safeLocale("../x")).toBe("en");
  });
});

describe("sign-up codes", () => {
  useRedis();
  const NOW = new Date("2026-11-07T10:00:00Z");

  it("are stored only as a hash, expire, are used once and can be revoked", async () => {
    const { id, code } = await createSignupCode("admin", NOW);
    const memory = getMemoryStoreForTests();
    if (memory) expect(JSON.stringify(memory.dump())).not.toContain(code);
    expect(await signupCodeIsLive(signupCodeHash(code))).toBe(true);
    if (memory) expect(memory.ttl(GLOBAL_KEYS.signupCode(signupCodeHash(code)))).toBe(14 * 86_400);

    expect(await consumeSignupCode(signupCodeHash(code), "github:1", NOW)).toBe(id);
    expect(await consumeSignupCode(signupCodeHash(code), "github:2", NOW)).toBeNull();
    expect((await listSignupCodes())[0]).toMatchObject({ id, usedBy: "github:1", usedAt: NOW.getTime() });
    // A used code is spent: revoking it changes nothing, and the record of its use stays.
    expect(await revokeSignupCode(id)).toBe(false);
    expect((await listSignupCodes()).map((entry) => entry.id)).toContain(id);

    const other = await createSignupCode("admin", NOW);
    expect(await revokeSignupCode(other.id)).toBe(true);
    expect(await signupCodeIsLive(signupCodeHash(other.code))).toBe(false);
    expect(await revokeSignupCode(other.id)).toBe(false);
  });
});

describe("user sessions", () => {
  useRedis();
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  async function sessionFrom(cookie: string) {
    const [pair] = cookie.split(";");
    const [name, value] = pair!.split("=");
    return withRequest(() => currentUserSession(), { cookies: fakeCookieJar({ [name!]: value! }) });
  }

  it("keeps only the id's hash, expires after the idle limit, and signs out everywhere", async () => {
    const cookie = await withRequest(() => startUserSession("u_AAAAAAAAAAAAAAAAAAAAAA", null, new Date()));
    expect(cookie).toMatch(/^ur_session=[A-Za-z0-9_-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
    const id = cookie.split(";")[0]!.split("=")[1]!;
    const memory = getMemoryStoreForTests();
    if (memory) expect(JSON.stringify(memory.dump())).not.toContain(id);
    expect((await sessionFrom(cookie))?.userId).toBe("u_AAAAAAAAAAAAAAAAAAAAAA");

    const second = await withRequest(() => startUserSession("u_AAAAAAAAAAAAAAAAAAAAAA", null, new Date()));
    expect(await endAllUserSessions("u_AAAAAAAAAAAAAAAAAAAAAA")).toBe(2);
    expect(await sessionFrom(cookie)).toBeNull();
    expect(await sessionFrom(second)).toBeNull();

    vi.stubEnv("SESSION_IDLE_DAYS", "1");
    const idle = await withRequest(() => startUserSession("u_BBBBBBBBBBBBBBBBBBBBBB", null, new Date()));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 86_400_000);
    expect(await sessionFrom(idle)).toBeNull();
  });
});

describe("GETDEL on the memory store", () => {
  useRedis();
  it("hands the value back once", async () => {
    await getRedis().set("k", "v");
    expect(await getRedis().getdel("k")).toBe("v");
    expect(await getRedis().getdel("k")).toBeNull();
  });
});

describe("signing out in multi-tenant mode", () => {
  useRedis();
  afterEach(() => vi.unstubAllEnvs());

  it("expires the __Host- cookie with Secure, so the browser actually drops it, and tags the audit by session", async () => {
    vi.stubEnv("REGISTRATION", "open");
    vi.stubEnv("COOKIE_SECURE", "1");
    const cookie = await withRequest(() => startUserSession("u_AAAAAAAAAAAAAAAAAAAAAA", null, new Date()));
    const id = cookie.split(";")[0]!.split("=")[1]!;
    const jar = fakeCookieJar({ "__Host-ur_session": id });
    const { endSession, sessionTag } = await import("@/lib/auth");
    expect(await withRequest(() => sessionTag(), { cookies: jar })).toMatch(/^[0-9a-f]{8}$/);
    await withRequest(() => endSession(), { cookies: jar });
    expect(jar.sets.at(-1)).toMatchObject({
      name: "__Host-ur_session",
      value: "",
      options: { secure: true, maxAge: 0 },
    });
    expect(
      await withRequest(() => currentUserSession(), { cookies: fakeCookieJar({ "__Host-ur_session": id }) }),
    ).toBeNull();
  });

  it("forgets sessions past their maximum lifetime in the user's list", async () => {
    const userId = "u_CCCCCCCCCCCCCCCCCCCCCC";
    await getRedis().zadd(GLOBAL_KEYS.userSessions(userId), { score: Date.now() - 40 * 86_400_000, member: "old" });
    await withRequest(() => startUserSession(userId, null, new Date()));
    const members = (await getRedis().zrange(GLOBAL_KEYS.userSessions(userId), 0, -1)) as string[];
    expect(members).toHaveLength(1);
    expect(members).not.toContain("old");
  });
});

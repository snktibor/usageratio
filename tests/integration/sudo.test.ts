import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as revealPost } from "@/app/api/api-token/reveal/route";
import { GET as sudoGet, POST as sudoPost } from "@/app/api/auth/sudo/route";
import { attemptLogin } from "@/lib/auth";
import { encryptionKey, loadAuditTrail, saveApiToken } from "@/lib/token-vault";
import { useRedis } from "../helpers/redis-fixture";
import { type FakeCookieJar, fakeCookieJar, withRequest } from "../helpers/request";

/**
 * /api/auth/sudo and /api/api-token/reveal together: the reveal endpoint
 * hands out the stored API token only with a live sudo grant on top of the
 * PIN session, and that grant itself is guarded by the same PIN and per-IP
 * limiter as login.
 */

const PIN = "12345";
const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const SERVER_TOKEN = "0123456789abcdef0123456789abcdef";
const ORIGIN = { origin: "http://localhost", host: "localhost" };

function sudoRequest(body: unknown, extraHeaders: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/auth/sudo", {
    method: "POST",
    headers: { ...ORIGIN, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function revealRequest(extraHeaders: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/api-token/reveal", {
    method: "POST",
    headers: { ...ORIGIN, ...extraHeaders },
  });
}

describe("sudo mode: /api/auth/sudo + /api/api-token/reveal", () => {
  useRedis();

  beforeEach(() => {
    vi.stubEnv("DASHBOARD_PIN", PIN);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_PROXY", "");
    vi.stubEnv("COOKIE_SECURE", "");
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", KEY_B64);
  });
  afterEach(() => vi.unstubAllEnvs());

  /** A signed-in session (its cookie jar) with an API token already stored. */
  async function signedInJar(): Promise<FakeCookieJar> {
    const jar = fakeCookieJar();
    const result = await withRequest(() => attemptLogin(PIN), {
      headers: { "x-forwarded-for": "203.0.113.9" },
      cookies: jar,
    });
    if (!result.ok) throw new Error(`login failed: ${JSON.stringify(result)}`);
    const key = encryptionKey();
    if (!key) throw new Error("the test encryption key did not parse");
    await withRequest(() => saveApiToken(SERVER_TOKEN, key, new Date()));
    return jar;
  }

  it("403s the reveal without sudo, then 200s with the token (and an audit entry) once granted", async () => {
    const jar = await signedInJar();

    const blocked = await withRequest(() => revealPost(revealRequest()), { cookies: jar });
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toBe("sudo_required");

    const granted = await withRequest(() => sudoPost(sudoRequest({ pin: PIN })), { cookies: jar });
    expect(granted.status).toBe(204);

    const revealed = await withRequest(() => revealPost(revealRequest()), { cookies: jar });
    expect(revealed.status).toBe(200);
    expect((await revealed.json()).token).toBe(SERVER_TOKEN);

    const audit = await loadAuditTrail();
    expect(audit[0]).toMatchObject({ action: "revealed" });
  });

  it("answers 401 sudo_invalid with attemptsLeft for a wrong PIN", async () => {
    const jar = await signedInJar();
    const response = await withRequest(
      () => sudoPost(sudoRequest({ pin: "00000" }, { "x-forwarded-for": "203.0.113.99" })),
      { cookies: jar },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "sudo_invalid", attemptsLeft: 4 });

    // No grant happened: the reveal is still blocked.
    const stillBlocked = await withRequest(() => revealPost(revealRequest()), { cookies: jar });
    expect(stillBlocked.status).toBe(403);
  });

  it("answers 403 for a foreign Origin, and 401 without a session at all", async () => {
    const jar = await signedInJar();
    const foreign = sudoRequest({ pin: PIN }, { origin: "https://evil.example" });
    expect((await withRequest(() => sudoPost(foreign), { cookies: jar })).status).toBe(403);

    const noSession = await withRequest(() => sudoPost(sudoRequest({ pin: PIN })));
    expect(noSession.status).toBe(401);
  });

  it("GET reports whether the configured PIN is numeric, behind the session", async () => {
    const jar = await signedInJar();
    const ok = await withRequest(() => sudoGet(new Request("http://localhost/api/auth/sudo", { headers: ORIGIN })), {
      cookies: jar,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ numeric: true });

    const anon = await withRequest(() => sudoGet(new Request("http://localhost/api/auth/sudo", { headers: ORIGIN })));
    expect(anon.status).toBe(401);
  });
});

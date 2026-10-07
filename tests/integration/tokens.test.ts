import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as deleteTokenRoute } from "@/app/api/tokens/[id]/route";
import { GET as getTokens, POST as postTokens } from "@/app/api/tokens/route";
import { POST as postUsage } from "@/app/api/usage/route";
import { getRedis, toStringRecord } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { sha256Hex } from "@/lib/security";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

/**
 * /api/tokens (GET, POST) and /api/tokens/[id] (DELETE): the settings panel's
 * per-machine tokens, and the way they authenticate POST /api/usage
 * end-to-end (lib/tokens.ts, requireBearer in lib/api.ts).
 */

const ORIGIN = { origin: "http://localhost", host: "localhost" };
const PIN = "12345";
const SERVER_TOKEN = "0123456789abcdef0123456789abcdef";

function request(url: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Request(url, {
    method: options.method,
    body: options.body,
    headers: {
      ...ORIGIN,
      ...(options.body !== undefined && { "content-type": "application/json" }),
      ...options.headers,
    },
  });
}

/** Grants sudo directly on the session the cookie carries, as the settings panel would after POST /api/auth/sudo. */
async function grantSudo(cookie: string): Promise<void> {
  const sessionId = cookie.split("=")[1]!;
  await getRedis().set(`usage:session:${sha256Hex(`${sessionId}:${PIN}`)}:sudo`, "1", { ex: 300 });
}

describe("GET /api/tokens", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 401 without a session", async () => {
    const response = await getTokens(request("http://localhost/api/tokens"));
    expect(response.status).toBe(401);
  });

  it("answers 200 with the issued tokens, and never the plaintext or its hash", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const created = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "Mac Studio", machineId: "mac-studio" }),
        headers: { cookie },
      }),
    );
    const { id, token } = (await created.json()) as { id: string; token: string };

    const response = await getTokens(request("http://localhost/api/tokens", { headers: { cookie } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { tokens: Record<string, unknown>[] };
    expect(body.tokens).toEqual([
      {
        id,
        label: "Mac Studio",
        machineId: "mac-studio",
        scope: "ingest",
        createdAt: expect.any(Number),
        lastUsedAt: null,
        revokedAt: null,
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toContain(sha256Hex(token));
  });
});

describe("POST /api/tokens", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 403 for a foreign origin before checking the session", async () => {
    const response = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "x" }),
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("forbidden_origin");
  });

  it("answers 401 without a session", async () => {
    const response = await postTokens(
      request("http://localhost/api/tokens", { method: "POST", body: JSON.stringify({ label: "x" }) }),
    );
    expect(response.status).toBe(401);
  });

  it("answers 403 sudo_required with a session but no sudo grant, and creates nothing", async () => {
    const cookie = await seedSession(PIN);
    const response = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "x" }),
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("sudo_required");
    expect(await getRedis().hlen(KEYS.tokens)).toBe(0);
  });

  it("answers 400 for a missing or too-long label, or an invalid machineId", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);

    const empty = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "" }),
        headers: { cookie },
      }),
    );
    expect(empty.status).toBe(400);

    const tooLong = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "a".repeat(65) }),
        headers: { cookie },
      }),
    );
    expect(tooLong.status).toBe(400);

    const badMachine = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "ok", machineId: "" }),
        headers: { cookie },
      }),
    );
    expect(badMachine.status).toBe(400);

    const badScope = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "ok", scope: "admin" }),
        headers: { cookie },
      }),
    );
    expect(badScope.status).toBe(400);

    const boundRead = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "ok", scope: "read", machineId: "mac-studio" }),
        headers: { cookie },
      }),
    );
    expect(boundRead.status).toBe(400);
  });

  it("issues a read token, listed with its scope", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const created = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "Menu bar", scope: "read" }),
        headers: { cookie },
      }),
    );
    expect(created.status).toBe(201);

    const response = await getTokens(request("http://localhost/api/tokens", { headers: { cookie } }));
    const body = (await response.json()) as { tokens: Record<string, unknown>[] };
    expect(body.tokens).toEqual([expect.objectContaining({ label: "Menu bar", scope: "read", machineId: null })]);
  });

  it("answers 201 with a fresh id and token, storing only the token's hash", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const response = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "Mac Studio" }),
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { id: string; token: string };
    expect(body.id).toMatch(/^tk_[A-Z2-7]{8}$/);
    expect(body.token).toMatch(/^ur_[A-Za-z0-9_-]{43}$/);

    expect(await getRedis().hexists(KEYS.tokens, sha256Hex(body.token))).toBe(1);
  });

  it("answers 422 too_many_tokens once the cap is reached", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    for (let i = 0; i < 100; i++) {
      const response = await postTokens(
        request("http://localhost/api/tokens", {
          method: "POST",
          body: JSON.stringify({ label: `token ${i}` }),
          headers: { cookie },
        }),
      );
      expect(response.status).toBe(201);
    }
    const refused = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "one too many" }),
        headers: { cookie },
      }),
    );
    expect(refused.status).toBe(422);
    const body = await refused.json();
    expect(body.error).toBe("too_many_tokens");
    expect(body.limit).toBe(100);
  });
});

describe("DELETE /api/tokens/[id]", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  async function issueToken(cookie: string, label = "Mac Studio"): Promise<{ id: string; token: string }> {
    const response = await postTokens(
      request("http://localhost/api/tokens", { method: "POST", body: JSON.stringify({ label }), headers: { cookie } }),
    );
    return (await response.json()) as { id: string; token: string };
  }

  it("answers 401 without a session", async () => {
    const response = await deleteTokenRoute(request("http://localhost/api/tokens/tk_ghost001", { method: "DELETE" }), {
      params: Promise.resolve({ id: "tk_ghost001" }),
    });
    expect(response.status).toBe(401);
  });

  it("answers 403 sudo_required with a session but no sudo grant, and does not revoke", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const { id } = await issueToken(cookie);
    // A fresh session, no sudo grant of its own, for the delete attempt.
    const plainCookie = await seedSession(PIN);
    const response = await deleteTokenRoute(
      request(`http://localhost/api/tokens/${id}`, { method: "DELETE", headers: { cookie: plainCookie } }),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("sudo_required");

    const stored = toStringRecord(await getRedis().hgetall(KEYS.tokens));
    const record = JSON.parse(Object.values(stored)[0]!) as { revokedAt: number | null };
    expect(record.revokedAt).toBeNull();
  });

  it("answers 404 for an id nothing was ever issued with", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const response = await deleteTokenRoute(
      request("http://localhost/api/tokens/tk_ghost001", { method: "DELETE", headers: { cookie } }),
      { params: Promise.resolve({ id: "tk_ghost001" }) },
    );
    expect(response.status).toBe(404);
  });

  it("answers 200 and revokes it, idempotently", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const { id, token } = await issueToken(cookie);

    const first = await deleteTokenRoute(
      request(`http://localhost/api/tokens/${id}`, { method: "DELETE", headers: { cookie } }),
      {
        params: Promise.resolve({ id }),
      },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    const second = await deleteTokenRoute(
      request(`http://localhost/api/tokens/${id}`, { method: "DELETE", headers: { cookie } }),
      { params: Promise.resolve({ id }) },
    );
    expect(second.status).toBe(200);

    // The revoked token no longer authenticates POST /api/usage.
    vi.stubEnv("USAGE_API_TOKEN", SERVER_TOKEN);
    const usageResponse = await postUsage(
      new Request("http://localhost/api/usage", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          machineId: "mac",
          groupId: "Personal",
          providers: { claude: 100 },
          timestamp: new Date().toISOString(),
        }),
      }),
    );
    expect(usageResponse.status).toBe(401);
  });
});

describe("A per-machine token authenticating POST /api/usage", () => {
  useRedis();
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_PIN", PIN);
    vi.stubEnv("USAGE_API_TOKEN", SERVER_TOKEN);
  });
  afterEach(() => vi.unstubAllEnvs());

  function usageRequest(bearer: string, body: Record<string, unknown>) {
    return new Request("http://localhost/api/usage", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        machineId: "mac-studio",
        groupId: "Personal",
        providers: { claude: 100 },
        timestamp: new Date().toISOString(),
        ...body,
      }),
    });
  }

  it("an unbound token authenticates a report for any machine", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const created = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "any machine" }),
        headers: { cookie },
      }),
    );
    const { token } = (await created.json()) as { token: string };

    const response = await postUsage(usageRequest(token, {}));
    expect(response.status).toBe(201);
  });

  it("a machine-bound token authenticates only its own machine, 403 machine_mismatch otherwise", async () => {
    const cookie = await seedSession(PIN);
    await grantSudo(cookie);
    const created = await postTokens(
      request("http://localhost/api/tokens", {
        method: "POST",
        body: JSON.stringify({ label: "mac studio", machineId: "mac-studio" }),
        headers: { cookie },
      }),
    );
    const { token } = (await created.json()) as { token: string };

    const own = await postUsage(usageRequest(token, { machineId: "mac-studio" }));
    expect(own.status).toBe(201);

    const other = await postUsage(usageRequest(token, { machineId: "other-machine" }));
    expect(other.status).toBe(403);
    expect((await other.json()).error).toBe("machine_mismatch");
  });
});

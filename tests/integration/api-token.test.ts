import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as auditGet } from "@/app/api/api-token/audit/route";
import { GET, PUT } from "@/app/api/api-token/route";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

const URL = "http://localhost/api/api-token";
const ORIGIN = { origin: "http://localhost", host: "localhost" };
const PIN = "12345";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("hex");
const SERVER_TOKEN = "0123456789abcdef0123456789abcdef";

function get(headers: Record<string, string> = {}): Request {
  return new Request(URL, { headers });
}

function put(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: "PUT", body, headers: { "content-type": "application/json", ...headers } });
}

describe("GET|PUT /api/api-token", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("GET answers 401 without a session", async () => {
    const response = await GET(get());
    expect(response.status).toBe(401);
  });

  it("GET answers 200 with the token's status", async () => {
    const cookie = await seedSession(PIN);
    const response = await GET(get({ cookie }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status.state).toBe("no_key");
  });

  it("PUT answers 403 for a foreign Origin, and 401 without a session", async () => {
    const foreign = await PUT(
      put(JSON.stringify({ token: SERVER_TOKEN }), { origin: "https://evil.example", host: "localhost" }),
    );
    expect(foreign.status).toBe(403);

    const unauthenticated = await PUT(put(JSON.stringify({ token: SERVER_TOKEN }), ORIGIN));
    expect(unauthenticated.status).toBe(401);
  });

  it("PUT answers 500 encryption_key_missing while TOKEN_ENCRYPTION_KEY is not set", async () => {
    const cookie = await seedSession(PIN);
    const response = await PUT(put(JSON.stringify({ token: SERVER_TOKEN }), { ...ORIGIN, cookie }));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("encryption_key_missing");
  });

  it("PUT answers 400 invalid_token for a token that is too short", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", ENCRYPTION_KEY);
    const cookie = await seedSession(PIN);
    const response = await PUT(put(JSON.stringify({ token: "short" }), { ...ORIGIN, cookie }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_token");
  });

  it("PUT answers 413 for a body over 2 KiB", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", ENCRYPTION_KEY);
    const cookie = await seedSession(PIN);
    const response = await PUT(put(JSON.stringify({ token: "x".repeat(3000) }), { ...ORIGIN, cookie }));
    expect(response.status).toBe(413);
    expect((await response.json()).maxBytes).toBe(2_048);
  });

  it("PUT stores the token (created, then updated) and the audit trail records both", async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", ENCRYPTION_KEY);
    vi.stubEnv("USAGE_API_TOKEN", SERVER_TOKEN);
    const cookie = await seedSession(PIN);

    const created = await PUT(put(JSON.stringify({ token: SERVER_TOKEN }), { ...ORIGIN, cookie }));
    expect(created.status).toBe(200);
    const createdBody = await created.json();
    expect(createdBody.ok).toBe(true);
    expect(createdBody.action).toBe("created");
    expect(createdBody.status.state).toBe("stored");
    expect(createdBody.status.matchesServer).toBe(true);

    const updated = await PUT(put(JSON.stringify({ token: "another-token-of-16-chars" }), { ...ORIGIN, cookie }));
    expect(updated.status).toBe(200);
    expect((await updated.json()).action).toBe("updated");

    const audit = await auditGet(get({ cookie }));
    expect(audit.status).toBe(200);
    const auditBody = await audit.json();
    expect(auditBody.entries.map((entry: { action: string }) => entry.action)).toEqual(["updated", "created"]);
    expect(typeof auditBody.currentSession).toBe("string");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/usage/route";
import { MAX_GROUPS } from "@/lib/settings";
import { createToken, revokeToken } from "@/lib/tokens";
import { useRedis } from "../helpers/redis-fixture";

const URL = "http://localhost/api/usage";
const SERVER_TOKEN = "0123456789abcdef0123456789abcdef";
const AUTH = { authorization: `Bearer ${SERVER_TOKEN}` };

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: "POST", body: JSON.stringify(body), headers: { ...AUTH, ...headers } });
}

function validReport(overrides: Record<string, unknown> = {}) {
  return {
    machineId: "mac",
    groupId: "Personal",
    providers: { claude: 1000 },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("POST|GET /api/usage", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("USAGE_API_TOKEN", SERVER_TOKEN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 401 for a missing or wrong Bearer token", async () => {
    const missing = await POST(post(validReport(), { authorization: "" }));
    expect(missing.status).toBe(401);
    expect((await missing.json()).error).toBe("unauthorized");

    const wrong = await POST(post(validReport(), { authorization: "Bearer wrong-token-of-16-chars" }));
    expect(wrong.status).toBe(401);
  });

  it("answers 500 server_misconfigured while USAGE_API_TOKEN is too short", async () => {
    vi.stubEnv("USAGE_API_TOKEN", "short");
    const response = await POST(post(validReport()));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("server_misconfigured");
  });

  it("answers 413 for a declared body over 64 KiB", async () => {
    const response = await POST(post(validReport(), { "content-length": "999999" }));
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toBe("payload_too_large");
    expect(body.maxBytes).toBe(65_536);
  });

  it("answers 400 invalid_json for a body that is not JSON", async () => {
    const response = await POST(new Request(URL, { method: "POST", body: "{oops", headers: AUTH }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_json");
  });

  it("answers 400 invalid_payload with details for a structurally wrong report", async () => {
    const response = await POST(post({ machineId: "", groupId: "Personal", providers: {}, timestamp: "not-a-date" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_payload");
    expect(body.details.length).toBeGreaterThan(0);
  });

  it("stores a fresh report as 201, and the identical retry as 200 duplicate", async () => {
    const report = validReport();
    const first = await POST(post(report));
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.ok).toBe(true);
    expect(firstBody.duplicate).toBe(false);
    expect(firstBody.groupRegistered).toBe(true);
    expect(first.headers.get("x-request-id")).toBeTruthy();

    const second = await POST(post(report));
    expect(second.status).toBe(200);
    expect((await second.json()).duplicate).toBe(true);
  });

  it("answers 422 too_many_groups once the registry cap would be exceeded", async () => {
    for (let i = 0; i < MAX_GROUPS; i++) {
      const response = await POST(post(validReport({ groupId: `Group ${i}`, providers: {} })));
      expect(response.status).toBe(201);
    }
    const refused = await POST(post(validReport({ groupId: "One Too Many", providers: {} })));
    expect(refused.status).toBe(422);
    const body = await refused.json();
    expect(body.error).toBe("too_many_groups");
    expect(body.limit).toBe(MAX_GROUPS);
  });

  it("answers 429 per token+machine once the ingest rate limit is exceeded", async () => {
    const report = validReport();
    let last: Response | undefined;
    for (let i = 0; i < 61; i++) last = await POST(post(report));
    expect(last?.status).toBe(429);
    const body = await last?.json();
    expect(body.error).toBe("rate_limited");
    expect(typeof body.retryAfterSeconds).toBe("number");
    expect(last?.headers.get("retry-after")).toBeTruthy();
  });

  it("answers 429 once repeated 401s exceed the per-IP limit", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 61; i++) {
      last = await POST(post(validReport(), { authorization: "Bearer wrong-token-of-16-chars" }));
    }
    expect(last?.status).toBe(429);
    expect((await last!.json()).error).toBe("rate_limited");
  });

  it("GET answers 200 with the current cycle", async () => {
    const response = await GET(new Request(URL, { headers: AUTH }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.tokenMode).toBe("string");
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.cycle.start).toBeTruthy();
    expect(body.cycle.end).toBeTruthy();
    expect(body.cycle.sinceDate).toBeTruthy();
    expect(body.cycle.timeZone).toBeTruthy();
  });

  describe("per-machine tokens (lib/tokens.ts), alongside the master USAGE_API_TOKEN", () => {
    it("accepts an unbound per-machine token exactly like the master token", async () => {
      const issued = await createToken("laptop", null, new Date());
      if (!issued.ok) throw new Error("unreachable");
      const response = await POST(post(validReport(), { authorization: `Bearer ${issued.token}` }));
      expect(response.status).toBe(201);
    });

    it("answers 401 once that token is revoked", async () => {
      const issued = await createToken("laptop", null, new Date());
      if (!issued.ok) throw new Error("unreachable");
      await revokeToken(issued.id, new Date());
      const response = await POST(post(validReport(), { authorization: `Bearer ${issued.token}` }));
      expect(response.status).toBe(401);
    });

    it("a machine-bound token reports for its own machine, 403 machine_mismatch for another", async () => {
      const issued = await createToken("desktop", "mac-studio", new Date());
      if (!issued.ok) throw new Error("unreachable");
      const auth = { authorization: `Bearer ${issued.token}` };

      const own = await POST(post(validReport({ machineId: "mac-studio" }), auth));
      expect(own.status).toBe(201);

      const other = await POST(post(validReport({ machineId: "other-machine" }), auth));
      expect(other.status).toBe(403);
      expect((await other.json()).error).toBe("machine_mismatch");
    });
  });
});

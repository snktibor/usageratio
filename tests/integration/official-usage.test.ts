import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT } from "@/app/api/official-usage/route";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

const URL = "http://localhost/api/official-usage";
const ORIGIN = { origin: "http://localhost", host: "localhost" };
const PIN = "12345";

function put(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: "PUT", body, headers: { "content-type": "application/json", ...headers } });
}

describe("PUT /api/official-usage", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 403 for a foreign Origin", async () => {
    const response = await PUT(
      put(JSON.stringify({ providerId: "claude", subLimitId: null, raw: "45", cycleStartMs: 0 }), {
        origin: "https://evil.example",
        host: "localhost",
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("forbidden_origin");
  });

  it("answers 401 without a session", async () => {
    const response = await PUT(
      put(JSON.stringify({ providerId: "claude", subLimitId: null, raw: "45", cycleStartMs: 0 }), ORIGIN),
    );
    expect(response.status).toBe(401);
  });

  it("answers 400 invalid_payload for a bad body", async () => {
    const cookie = await seedSession(PIN);
    const response = await PUT(put(JSON.stringify({ providerId: "", raw: "45" }), { ...ORIGIN, cookie }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_payload");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("sets the field and answers 200 with the entered-at time", async () => {
    const cookie = await seedSession(PIN);
    const before = Date.now();
    const response = await PUT(
      put(JSON.stringify({ providerId: "claude", subLimitId: null, raw: "45.5", cycleStartMs: 1_758_326_400_000 }), {
        ...ORIGIN,
        cookie,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(typeof body.enteredAt).toBe("number");
    expect(body.enteredAt).toBeGreaterThanOrEqual(before);
  });

  it("clears the field with an empty raw value", async () => {
    const cookie = await seedSession(PIN);
    await PUT(
      put(JSON.stringify({ providerId: "claude", subLimitId: null, raw: "45", cycleStartMs: 1_758_326_400_000 }), {
        ...ORIGIN,
        cookie,
      }),
    );
    const response = await PUT(
      put(JSON.stringify({ providerId: "claude", subLimitId: null, raw: "", cycleStartMs: 1_758_326_400_000 }), {
        ...ORIGIN,
        cookie,
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  });
});

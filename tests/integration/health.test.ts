import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";
import { useRedis } from "../helpers/redis-fixture";

describe("GET /api/health", () => {
  const redis = useRedis();

  it("answers 200 with the version and the store's state, and echoes a request id", async () => {
    const response = await GET(new Request("http://localhost/api/health", { headers: { "x-request-id": "req-1" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBe("req-1");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.store).toBe("ok");
    expect(body.storage).toBe("redis"); // storageKind() reads the env, and the test injects the client instead
    expect(typeof body.version).toBe("string");
    expect(typeof body.latencyMs).toBe("number");
    expect(Object.keys(body).sort()).toEqual(["commit", "latencyMs", "ok", "storage", "store", "time", "version"]);
  });

  it("answers 503 when the store does not answer", async ({ skip }) => {
    if (redis.real) skip();
    redis.store?.failNext("PING", "connection refused");
    const response = await GET(new Request("http://localhost/api/health"));
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.store).toBe("unavailable");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as cronHousekeeping } from "@/app/api/cron/housekeeping/route";
import { POST as postHousekeeping } from "@/app/api/housekeeping/route";
import { getRedis } from "@/lib/redis";
import { sha256Hex } from "@/lib/security";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

const CRON_SECRET = "0123456789abcdef0123456789abcdef";

function cronRequest(options: { search?: string; authorization?: string } = {}) {
  return new Request(`http://localhost/api/cron/housekeeping${options.search ?? ""}`, {
    headers: options.authorization === undefined ? {} : { authorization: options.authorization },
  });
}

describe("GET /api/cron/housekeeping", () => {
  useRedis();

  beforeEach(() => {
    vi.stubEnv("CRON_SECRET", CRON_SECRET);
    vi.stubEnv("DEMO_MODE", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("answers 500 server_misconfigured when CRON_SECRET is missing or too short", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const missing = await cronHousekeeping(cronRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(missing.status).toBe(500);
    expect((await missing.json()).error).toBe("server_misconfigured");

    vi.stubEnv("CRON_SECRET", "short");
    const tooShort = await cronHousekeeping(cronRequest({ authorization: "Bearer short" }));
    expect(tooShort.status).toBe(500);
    expect((await tooShort.json()).error).toBe("server_misconfigured");
  });

  it("answers 401 for a missing or wrong bearer token, and never runs housekeeping", async () => {
    await getRedis().hset("usage:providers", { orphan: "1" });

    const missing = await cronHousekeeping(cronRequest());
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="usage"');

    const wrong = await cronHousekeeping(cronRequest({ authorization: "Bearer nope" }));
    expect(wrong.status).toBe(401);

    // Neither attempt touched the store.
    expect(await getRedis().hexists("usage:providers", "orphan")).toBe(1);
  });

  it("answers 200 with the report, and actually prunes on a real run", async () => {
    const staleMs = Date.now() - 100 * 86_400_000;
    await getRedis().hset("usage:machines", { "claude:old": JSON.stringify({ g: "team", ts: staleMs, t: 1 }) });

    const response = await cronHousekeeping(cronRequest({ authorization: `Bearer ${CRON_SECRET}` }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { report: { machines: { removed: number; ids: string[] } } };
    expect(body.report.machines).toEqual({ removed: 1, ids: ["claude:old"] });
    expect(await getRedis().hexists("usage:machines", "claude:old")).toBe(0);
  });

  it("?dryRun=1 reports what would happen without deleting it", async () => {
    const staleMs = Date.now() - 100 * 86_400_000;
    await getRedis().hset("usage:machines", { "claude:old": JSON.stringify({ g: "team", ts: staleMs, t: 1 }) });

    const response = await cronHousekeeping(
      cronRequest({ search: "?dryRun=1", authorization: `Bearer ${CRON_SECRET}` }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { report: { machines: { removed: number }; dryRun: boolean } };
    expect(body.report.machines.removed).toBe(1);
    expect(body.report.dryRun).toBe(true);
    expect(await getRedis().hexists("usage:machines", "claude:old")).toBe(1);
  });
});

describe("POST /api/housekeeping", () => {
  useRedis();

  afterEach(() => vi.unstubAllEnvs());

  it("answers 401 without a session", async () => {
    // No DASHBOARD_PIN configured: isAuthenticated() answers false without needing a real cookie store.
    vi.stubEnv("DASHBOARD_PIN", "");
    vi.stubEnv("DEMO_MODE", "");
    await getRedis().hset("usage:providers", { orphan: "1" });

    const response = await postHousekeeping(new Request("http://localhost/api/housekeeping", { method: "POST" }));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("unauthorized");
    // Refused before touching the store.
    expect(await getRedis().hexists("usage:providers", "orphan")).toBe(1);
  });

  it("reports on a dry run with the session alone, but deletes only after a fresh PIN confirmation (sudo)", async () => {
    vi.stubEnv("DASHBOARD_PIN", "12345");
    vi.stubEnv("DEMO_MODE", "");
    const cookie = await seedSession("12345");
    const sessionId = cookie.split("=")[1]!;
    const request = (search = "") =>
      new Request(`http://localhost/api/housekeeping${search}`, {
        method: "POST",
        headers: { cookie, origin: "http://localhost", host: "localhost" },
      });

    expect((await postHousekeeping(request("?dryRun=1"))).status).toBe(200);

    const refused = await postHousekeeping(request());
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe("sudo_required");

    await getRedis().set(`usage:session:${sha256Hex(`${sessionId}:12345`)}:sudo`, "1", { ex: 300 });
    const allowed = await postHousekeeping(request());
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).report).toBeDefined();
  });
});

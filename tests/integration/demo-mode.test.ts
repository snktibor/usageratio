import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT as putOfficialUsage } from "@/app/api/official-usage/route";
import { PUT as putSettings } from "@/app/api/settings/route";
import { POST as postUsage } from "@/app/api/usage/route";
import { useRedis } from "../helpers/redis-fixture";

const ORIGIN = { origin: "http://localhost", host: "localhost", "content-type": "application/json" };

describe("demo mode", () => {
  useRedis();
  beforeEach(() => {
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("USAGE_API_TOKEN", "0123456789abcdef0123456789abcdef");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses every write with 403 demo_read_only", async () => {
    const settings = await putSettings(
      new Request("http://localhost/api/settings", { method: "PUT", headers: ORIGIN, body: "{}" }),
    );
    expect(settings.status).toBe(403);
    expect((await settings.json()).error).toBe("demo_read_only");

    const official = await putOfficialUsage(
      new Request("http://localhost/api/official-usage", { method: "PUT", headers: ORIGIN, body: "{}" }),
    );
    expect(official.status).toBe(403);

    const usage = await postUsage(
      new Request("http://localhost/api/usage", {
        method: "POST",
        headers: { authorization: "Bearer 0123456789abcdef0123456789abcdef" },
        body: JSON.stringify({
          machineId: "m",
          groupId: "g",
          providers: { claude: 1 },
          timestamp: new Date().toISOString(),
        }),
      }),
    );
    expect(usage.status).toBe(403);
    expect((await usage.json()).error).toBe("demo_read_only");
  });
});

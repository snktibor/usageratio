import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getStatus } from "@/app/api/status/route";
import { GET as getCycle, POST as postUsage } from "@/app/api/usage/route";
import { getConfig } from "@/lib/config";
import { getRedis } from "@/lib/redis";
import { serializeSettings, settingsFromConfig, type UsageSettings } from "@/lib/settings";
import type { StatusPayload } from "@/lib/status";
import { useRedis } from "../helpers/redis-fixture";
import { KEYS } from "../helpers/tenant";

/**
 * 2026-10-31: Claude's own window reset at 11:00 UTC, the shared reset
 * (Saturday 13:00 on the wall clock) only at 12:00 UTC. For that hour the
 * earliest cycle is still the old week: a client that does not trim each
 * provider to its own start (`cycle.providers`, added on 2026-10-09) reads
 * Claude from there and sends the whole old week into the new one.
 */

const TOKEN = "0123456789abcdef0123456789abcdef";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const CLAUDE_START = Date.parse("2026-10-31T11:00:00Z");
const API = "http://localhost/api/usage";

describe("a client that reads a provider from before its own cycle", () => {
  useRedis();
  beforeEach(async () => {
    vi.stubEnv("USAGE_API_TOKEN", TOKEN);
    vi.stubEnv("TOKEN_MODE", "snapshot");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-31T11:00:20Z"));
    const settings: UsageSettings = {
      ...settingsFromConfig(getConfig()),
      period: "weekly",
      reset: { weekday: 6, monthDay: 1, hour: 13, minute: 0, timeZone: "Europe/Budapest" },
      resetOverrides: {
        claude: {
          weekday: 6,
          monthDay: 1,
          hour: 12,
          minute: 0,
          source: "report",
          anchorMs: Date.parse("2026-10-31T11:00:00Z"),
        },
      },
    };
    await getRedis().set(KEYS.settings, serializeSettings(settings, new Date()));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("is told the old week as the earliest cycle in the hour between the two resets", async () => {
    await getRedis().hset(KEYS.providers, { claude: Date.now() });
    const { cycle } = await (await getCycle(new Request(API, { headers: AUTH }))).json();
    expect(cycle.sinceDate).toBe("2026-10-24");
    expect(cycle.providers.claude.start).toBe(new Date(CLAUDE_START).toISOString());
  });

  it("does not count that total in the new week", async () => {
    await getRedis().hset(KEYS.providers, { claude: Date.now() });
    const days = {
      "2026-10-26": { providers: { claude: 300_000_000 } },
      "2026-10-31": { providers: { claude: 7_000_000 } },
    };
    const report = (tokens: number, timestamp: string, body: object = {}) =>
      postUsage(
        new Request(API, {
          method: "POST",
          headers: { ...AUTH, "content-type": "application/json" },
          body: JSON.stringify({
            machineId: "RAZER-BLADE-16",
            groupId: "patyesz",
            providers: { claude: tokens },
            timestamp,
            ...body,
          }),
        }),
      );
    expect((await report(307_000_000, "2026-10-31T11:00:20Z", { days })).status).toBe(201);
    vi.setSystemTime(new Date("2026-10-31T12:00:20Z"));
    expect((await report(5_000_000, "2026-10-31T12:00:20Z")).status).toBe(201);

    const response = await getStatus(new Request("http://localhost/api/status", { headers: AUTH }));
    const claude = ((await response.json()) as StatusPayload).providers.find((p) => p.id === "claude")!;
    expect(claude.cycle.start).toBe(new Date(CLAUDE_START).toISOString());
    expect(claude.tokens).toBe(5_000_000);
  });

  it("still counts a client that trimmed the provider to its own cycle", async () => {
    await getRedis().hset(KEYS.providers, { claude: Date.now() });
    const response = await postUsage(
      new Request(API, {
        method: "POST",
        headers: { ...AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          machineId: "mac",
          groupId: "tibusz",
          providers: { claude: 7_000_000 },
          timestamp: "2026-10-31T11:00:20Z",
          // A day before the provider's cycle stays in the report at 0 (clients/shared/ccusage-providers.cjs).
          days: { "2026-10-26": { providers: { claude: 0 } }, "2026-10-31": { providers: { claude: 7_000_000 } } },
        }),
      }),
    );
    expect(response.status).toBe(201);
    vi.setSystemTime(new Date("2026-10-31T11:30:00Z"));
    const status = await getStatus(new Request("http://localhost/api/status", { headers: AUTH }));
    const claude = ((await status.json()) as StatusPayload).providers.find((p) => p.id === "claude")!;
    expect(claude.tokens).toBe(7_000_000);
  });
});

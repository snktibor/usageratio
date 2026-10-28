import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postOfficial } from "@/app/api/official-usage/report/route";
import { GET as getStatus } from "@/app/api/status/route";
import { getConfig } from "@/lib/config";
import { ingestReport } from "@/lib/ingest";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { serializeSettings, settingsFromConfig, type UsageSettings } from "@/lib/settings";
import type { StatusPayload } from "@/lib/status";
import { createToken } from "@/lib/tokens";
import { useRedis } from "../helpers/redis-fixture";

/**
 * 2026-10-24, as it happened: Budapest left summer time the next night, and
 * Claude's window resets every Saturday 11:00 UTC. The own reset was stored
 * as "Saturday 13:00" on the wall clock; a machine reported its running total
 * of the old week at 10:03 UTC; the window's next reset (11:00 UTC, 12:00 in
 * winter) then moved the cycle's start to 10:00 UTC, an hour before the old
 * one ended, and that total landed in the new week.
 */

const SERVER_TOKEN = "0123456789abcdef0123456789abcdef";
const OLD_START = Date.parse("2026-10-17T11:00:00Z");
const OLD_END = Date.parse("2026-10-24T11:00:00Z");
const NEXT_END = Date.parse("2026-10-31T11:00:00Z");

describe("a provider's own reset across a DST shift", () => {
  useRedis();
  beforeEach(() => {
    vi.stubEnv("USAGE_API_TOKEN", SERVER_TOKEN);
    vi.stubEnv("TOKEN_MODE", "snapshot");
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const at = (iso: string) => {
    const now = new Date(iso);
    vi.setSystemTime(now);
    return now;
  };
  const ingest = async (tokens: number, iso: string) => {
    const now = at(iso);
    const stored = await ingestReport(
      { machineId: "zsiga-mac", groupId: "zsiga", providers: { claude: tokens }, timestamp: now.toISOString() },
      now,
    );
    if (!stored.ok) throw new Error(JSON.stringify(stored));
  };
  const claudeOf = async () => {
    const response = await getStatus(
      new Request("http://localhost/api/status", { headers: { authorization: `Bearer ${SERVER_TOKEN}` } }),
    );
    return ((await response.json()) as StatusPayload).providers.find((provider) => provider.id === "claude")!;
  };

  it("starts the new week where the old one ended, and leaves the old week's total out of it", async () => {
    const settings: UsageSettings = {
      ...settingsFromConfig(getConfig()),
      period: "weekly",
      reset: { weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "Europe/Budapest" },
      // Stored before the instant existed.
      resetOverrides: { claude: { weekday: 6, monthDay: 1, hour: 13, minute: 0, source: "report" } },
    };
    await getRedis().set(KEYS.settings, serializeSettings(settings, new Date(OLD_START)));

    await ingest(3_736_784_569, "2026-10-24T10:03:57Z");

    const now = at("2026-10-24T11:20:00Z");
    const created = await createToken("menu bar", null, now, "official");
    if (!created.ok) throw new Error("token not created");
    const answer = await postOfficial(
      new Request("http://localhost/api/official-usage/report", {
        method: "POST",
        body: JSON.stringify({
          providerId: "claude",
          usedPercent: 1,
          resetsAtMs: NEXT_END,
          observedAtMs: now.getTime(),
        }),
        headers: { "content-type": "application/json", authorization: `Bearer ${created.token}` },
      }),
    );
    expect(answer.status).toBe(200);
    const stored = JSON.parse((await getRedis().get<string>(KEYS.settings)) as string);
    expect(stored.resetOverrides.claude).toMatchObject({ hour: 12, source: "report", anchorMs: NEXT_END });

    await ingest(120_000_000, "2026-10-24T12:01:44Z");

    at("2026-10-28T11:00:00Z");
    const claude = await claudeOf();
    expect(claude.cycle.start).toBe(new Date(OLD_END).toISOString());
    expect(claude.cycle.end).toBe(new Date(NEXT_END).toISOString());
    expect(claude.tokens).toBe(120_000_000);
  });
});

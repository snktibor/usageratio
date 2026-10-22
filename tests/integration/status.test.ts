import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/status/route";
import { POST as postUsage } from "@/app/api/usage/route";
import { getConfig } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import { ingestReport } from "@/lib/ingest";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { serializeSettings, settingsFromConfig, type UsageSettings } from "@/lib/settings";
import type { StatusPayload } from "@/lib/status";
import { createToken } from "@/lib/tokens";
import { saveResets } from "@/lib/usage-store";
import { useRedis } from "../helpers/redis-fixture";

/**
 * GET /api/status: the menu bar app's view of the current cycle
 * (lib/status.ts), and the "read" tokens it is meant to be called with.
 */

/** The contract with the macOS app, whose own tests decode the same file (clients/macos/Tests). */
const FIXTURE = JSON.parse(readFileSync("clients/tests/fixtures/status-v1.json", "utf8")) as StatusPayload;

const keys = (value: object) => Object.keys(value).sort();

const URL = "http://localhost/api/status";
const SERVER_TOKEN = "0123456789abcdef0123456789abcdef";
const AUTH = { authorization: `Bearer ${SERVER_TOKEN}` };

function get(headers: Record<string, string> = AUTH): Request {
  return new Request(URL, { headers });
}

async function seedSettings(overrides: Partial<UsageSettings>): Promise<void> {
  const settings: UsageSettings = { ...settingsFromConfig(getConfig()), ...overrides };
  await getRedis().set(KEYS.settings, serializeSettings(settings, new Date()));
}

async function report(
  tokens: number,
  headers: Record<string, string> = AUTH,
  models?: Record<string, number>,
): Promise<Response> {
  const body = {
    machineId: "mac",
    groupId: "Personal",
    providers: { claude: tokens },
    ...(models && { models: { claude: models } }),
    timestamp: new Date().toISOString(),
  };
  return postUsage(new Request("http://localhost/api/usage", { method: "POST", body: JSON.stringify(body), headers }));
}

describe("GET /api/status", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("USAGE_API_TOKEN", SERVER_TOKEN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 401 without a valid Bearer token", async () => {
    expect((await GET(get({}))).status).toBe(401);
    expect((await GET(get({ authorization: "Bearer wrong-token-of-16-chars" }))).status).toBe(401);
  });

  it("states the measured usage against the token limit", async () => {
    await seedSettings({ useTokenLimits: true, limits: { claude: 10_000 } });
    expect((await report(2500)).status).toBe(201);

    const response = await GET(get());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as StatusPayload;
    expect(body.v).toBe(1);
    expect(body.cycle.period).toBe("weekly");
    const claude = body.providers.find((provider) => provider.id === "claude");
    expect(claude).toMatchObject({
      label: expect.any(String),
      percent: 25,
      source: "estimate",
      estimatedPercent: 25,
      tokens: 2500,
      limit: 10_000,
      status: expect.stringMatching(/^(good|warning|critical)$/),
      subLimits: [],
    });
    expect(claude?.lastReportAt).not.toBeNull();
    expect(claude?.pace).not.toBeNull();

    // Every field the app decodes is there, and nothing it does not know of.
    const sample = FIXTURE.providers[0]!;
    expect(keys(body)).toEqual(keys(FIXTURE));
    expect(keys(body.cycle)).toEqual(keys(FIXTURE.cycle));
    expect(keys(claude!)).toEqual(keys(sample));
    expect(keys(claude!.pace!)).toEqual(keys(sample.pace!));
    expect(keys(claude!.groups[0]!)).toEqual(keys(sample.groups[0]!));
    expect(keys(claude!.machines[0]!)).toEqual(keys(sample.machines[0]!));
    expect(claude!.groups).toEqual([{ id: "Personal", percent: 25, tokens: 2500 }]);
    expect(claude!.machines).toEqual([
      { id: "mac", groupId: "Personal", percent: 25, tokens: 2500, lastReportAt: expect.any(String) },
    ]);
  });

  it("lets an official reading of this cycle lead, as the dashboard does", async () => {
    await seedSettings({ useTokenLimits: true, limits: { claude: 10_000 } });
    await report(2500);
    const cycle = getCycle(new Date(), getConfig().reset);
    await getRedis().hset(KEYS.officialUsage, {
      claude: JSON.stringify({ raw: "40", enteredAt: Date.now(), cycleStartMs: cycle.start.getTime() }),
    });

    const body = (await (await GET(get())).json()) as StatusPayload;
    const claude = body.providers.find((provider) => provider.id === "claude");
    expect(claude).toMatchObject({ percent: 40, source: "official", estimatedPercent: 25 });
    // The breakdown is restated by the official reading too: the one machine carries all 40%.
    expect(claude?.machines[0]).toMatchObject({ id: "mac", percent: 40, tokens: 4000 });
    expect(claude?.groups[0]).toMatchObject({ id: "Personal", percent: 40 });
  });

  it("states the pace of the last hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Wednesday 12:00 UTC: the default cycle started Monday 00:00, 60 h ago.
      vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
      await seedSettings({ useTokenLimits: true, limits: { claude: 10_000 } });
      await report(2500);

      const body = (await (await GET(get())).json()) as StatusPayload;
      const claude = body.providers.find((provider) => provider.id === "claude")!;
      // All of it in the last hour: 60 times the cycle's average, and 7,500 left at 2,500 an hour.
      expect(claude.pace?.recent).toEqual({
        since: "2026-09-23T11:00:00.000Z",
        until: "2026-09-23T12:00:00.000Z",
        changed: true,
        ratio: 60,
        runOutAt: "2026-09-23T15:00:00.000Z",
      });
      expect(keys(claude.pace!.recent!)).toEqual(keys(FIXTURE.providers[0]!.pace!.recent!));
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a provider with its own reset its own cycle", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
      await seedSettings({
        useTokenLimits: true,
        limits: { claude: 10_000, openai: 10_000 },
        resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
      });
      await report(2500);
      await postUsage(
        new Request("http://localhost/api/usage", {
          method: "POST",
          body: JSON.stringify({
            machineId: "mac",
            groupId: "Personal",
            providers: { openai: 1000 },
            timestamp: new Date().toISOString(),
          }),
          headers: AUTH,
        }),
      );
      await getRedis().hset(KEYS.officialUsage, {
        claude: JSON.stringify({
          raw: "41",
          enteredAt: Date.now(),
          cycleStartMs: Date.parse("2026-09-17T09:00:00Z"),
        }),
      });

      const body = (await (await GET(get())).json()) as StatusPayload;
      const claude = body.providers.find((provider: { id: string }) => provider.id === "claude")!;
      const openai = body.providers.find((provider: { id: string }) => provider.id === "openai")!;
      expect(claude.cycle).toEqual({ start: "2026-09-17T09:00:00.000Z", end: "2026-09-24T09:00:00.000Z" });
      expect(openai.cycle).toEqual({ start: "2026-09-21T00:00:00.000Z", end: "2026-09-28T00:00:00.000Z" });
      expect(body.cycle.start).toBe("2026-09-21T00:00:00.000Z");
      expect(claude.source).toBe("official");
      expect(claude.percent).toBe(41);
    } finally {
      vi.useRealTimers();
    }
  });

  it("states a separate sub-limit against its own budget", async () => {
    await seedSettings({
      useTokenLimits: true,
      limits: { claude: 10_000 },
      subLimits: {
        claude: [{ id: "fable", name: "Fable", models: ["fable"], mode: "separate", sharePercent: 100, limit: 2000 }],
      },
    });
    await report(3000, AUTH, { "claude-fable-5-1": 1000, "claude-sonnet-5-5": 2000 });

    const body = (await (await GET(get())).json()) as StatusPayload;
    const claude = body.providers.find((provider) => provider.id === "claude")!;
    expect(claude.subLimits).toEqual([
      { id: "fable", name: "Fable", percent: 50, source: "measured", status: expect.any(String) },
    ]);
    expect(keys(claude.subLimits[0]!)).toEqual(keys(FIXTURE.providers[0]!.subLimits[0]!));
    // A separate sub-limit's tokens are not the provider's.
    expect(claude.percent).toBe(20);
  });

  it("has no percentage with the token limits off and no official reading", async () => {
    await seedSettings({ useTokenLimits: false });
    await report(2500);

    const body = (await (await GET(get())).json()) as StatusPayload;
    expect(body.providers.find((provider) => provider.id === "claude")).toMatchObject({
      percent: null,
      source: null,
      estimatedPercent: null,
      limit: null,
      status: null,
      pace: null,
      tokens: 2500,
    });
    const claude = body.providers.find((provider) => provider.id === "claude");
    expect(claude?.machines[0]?.percent).toBeNull();
  });

  it("serves a read token, which POST /api/usage refuses with 403 read_only_token", async () => {
    const created = await createToken("Menu bar", null, new Date(), "read");
    if (!created.ok) throw new Error("token not created");
    const headers = { authorization: `Bearer ${created.token}` };

    expect((await GET(get(headers))).status).toBe(200);
    const refused = await report(100, headers);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe("read_only_token");
  });

  it("serves an official token too, which may also report (the menu bar app's one token)", async () => {
    const created = await createToken("Menu bar", null, new Date(), "official");
    if (!created.ok) throw new Error("token not created");
    const headers = { authorization: `Bearer ${created.token}` };

    expect((await GET(get(headers))).status).toBe(200);
    expect((await report(100, headers)).status).toBe(201);
  });
});

describe("GET /api/status after a keep reset", () => {
  useRedis();
  const NOW = new Date("2026-09-23T12:00:00Z");
  const S = Date.parse("2026-09-21T00:00:00Z");
  const R = Date.parse("2026-09-23T08:00:00Z");

  beforeEach(async () => {
    vi.stubEnv("USAGE_API_TOKEN", SERVER_TOKEN);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await seedSettings({ useTokenLimits: false, resetOverrides: {} });
    const stored = await ingestReport(
      { machineId: "mac", groupId: "Personal", providers: { claude: 5000 }, timestamp: NOW.toISOString() },
      NOW,
    );
    if (!stored.ok) throw new Error(JSON.stringify(stored));
    await saveResets("claude", {
      v: 1,
      events: [
        {
          id: "r",
          atMs: R,
          kind: "keep",
          cycleStartMs: S,
          before: 80,
          beforeAtMs: null,
          source: "manual",
          recordedAtMs: R,
        },
      ],
      autoOffCycleStartMs: null,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const claudeOf = async () =>
    ((await (await GET(get())).json()) as StatusPayload).providers.find((p) => p.id === "claude");

  it("reads the figure tagged with the reset as the current one", async () => {
    await getRedis().hset(KEYS.officialUsage, {
      claude: JSON.stringify({ raw: "7", enteredAt: R + 3_600_000, cycleStartMs: R }),
    });
    expect((await claudeOf())?.source).toBe("official");
  });

  it("no longer reads the figure from before the reset as current", async () => {
    await getRedis().hset(KEYS.officialUsage, {
      claude: JSON.stringify({ raw: "80", enteredAt: R - 3_600_000, cycleStartMs: S }),
    });
    expect((await claudeOf())?.source).not.toBe("official");
  });
});

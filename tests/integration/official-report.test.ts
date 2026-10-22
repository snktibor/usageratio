import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/official-usage/report/route";
import { GET as getStatus } from "@/app/api/status/route";
import { getConfig } from "@/lib/config";
import { parseStoredOfficialEntry } from "@/lib/official-usage";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { serializeSettings, settingsFromConfig, type UsageSettings } from "@/lib/settings";
import type { StatusPayload } from "@/lib/status";
import { createToken, type TokenScope } from "@/lib/tokens";
import { loadIndexes, loadResets, registerProviders, saveResets } from "@/lib/usage-store";
import { useRedis } from "../helpers/redis-fixture";

/**
 * POST /api/official-usage/report: a provider's own weekly percentage, from an
 * "official" token (lib/official-report.ts decides what to do with it).
 */

const URL = "http://localhost/api/official-usage/report";
// Wednesday 2026-09-23 12:00 UTC; the shared reset is Monday 00:00 UTC.
const NOW = new Date("2026-09-23T12:00:00Z");
const OBSERVED = Date.parse("2026-09-23T11:50:00Z");

const body = (overrides: Record<string, unknown> = {}) => ({
  providerId: "claude",
  usedPercent: 41.24,
  resetsAtMs: Date.parse("2026-09-24T09:00:00Z"),
  observedAtMs: OBSERVED,
  ...overrides,
});

function post(payload: unknown, token?: string): Request {
  return new Request(URL, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
  });
}

async function tokenOf(scope: TokenScope): Promise<string> {
  const created = await createToken(`${scope} token`, null, NOW, scope);
  if (!created.ok) throw new Error("token not created");
  return created.token;
}

async function seedSettings(period: "weekly" | "monthly"): Promise<void> {
  const base = settingsFromConfig(getConfig());
  const settings: UsageSettings = {
    ...base,
    period,
    reset: { weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
    resetOverrides: {},
  };
  await getRedis().set(KEYS.settings, serializeSettings(settings, NOW));
}

describe("POST /api/official-usage/report", () => {
  useRedis();
  beforeEach(() => {
    vi.stubEnv("USAGE_API_TOKEN", "0123456789abcdef0123456789abcdef");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("answers 401 without a token, and 403 official_scope_required for an ingest or read token", async () => {
    await seedSettings("weekly");
    expect((await POST(post(body()))).status).toBe(401);
    for (const scope of ["ingest", "read"] as const) {
      const response = await POST(post(body(), await tokenOf(scope)));
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("official_scope_required");
    }
  });

  it("refuses a monthly dashboard with 409 period_not_weekly and writes nothing", async () => {
    await seedSettings("monthly");
    const response = await POST(post(body(), await tokenOf("official")));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("period_not_weekly");
    expect(await getRedis().hlen(KEYS.officialUsage)).toBe(0);
  });

  it("moves the reset, stores the figure for the new cycle, and the status shows it", async () => {
    await seedSettings("weekly");
    // The status lists providers that have reported tokens.
    await registerProviders(["claude"], Date.parse("2026-09-01T00:00:00Z"));
    const token = await tokenOf("official");
    const response = await POST(post(body(), token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      saved: true,
      cycleChanged: true,
      reset: { weekday: 4, hour: 9, minute: 0 },
      detectedReset: null,
    });

    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings)) as string);
    expect(settings.resetOverrides.claude).toEqual({
      weekday: 4,
      monthDay: 1,
      hour: 9,
      minute: 0,
      source: "report",
    });
    const stored = await getRedis().hget<unknown>(KEYS.officialUsage, "claude");
    expect(typeof stored === "string" ? JSON.parse(stored) : stored).toEqual({
      raw: "41.2",
      enteredAt: OBSERVED,
      cycleStartMs: Date.parse("2026-09-17T09:00:00Z"),
      resetsAtMs: Date.parse("2026-09-24T09:00:00Z"),
    });

    const status = (await (
      await getStatus(new Request("http://localhost/api/status", { headers: { authorization: `Bearer ${token}` } }))
    ).json()) as StatusPayload;
    const claude = status.providers.find((provider) => provider.id === "claude");
    expect(claude).toMatchObject({ percent: 41.2, source: "official" });
    expect(claude?.cycle.start).toBe("2026-09-17T09:00:00.000Z");
  });

  it("does nothing the second time", async () => {
    await seedSettings("weekly");
    const token = await tokenOf("official");
    await POST(post(body(), token));
    const again = await POST(post(body(), token));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      ok: true,
      saved: false,
      cycleChanged: false,
      reset: null,
      detectedReset: null,
    });
  });

  it("detects a keep reset from two readings of the same window, and records it", async () => {
    await seedSettings("weekly");
    const token = await tokenOf("official");
    await registerProviders(["claude"], NOW.getTime());
    // The first reading aligns Claude to its window (Thursday 09:00) and is stored with its window.
    expect((await POST(post(body({ usedPercent: 62 }), token))).status).toBe(200);

    const observedAtMs = Date.parse("2026-09-23T11:55:00Z");
    const response = await POST(post(body({ usedPercent: 2, observedAtMs }), token));
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer).toMatchObject({ ok: true, saved: true, cycleChanged: false, reset: null });
    expect(answer.detectedReset).toMatchObject({ kind: "keep", atMs: observedAtMs });

    const resets = await loadResets();
    expect(resets.claude?.events).toEqual([
      expect.objectContaining({ id: answer.detectedReset.id, before: 62, source: "report" }),
    ]);
    const stored = parseStoredOfficialEntry((await loadIndexes()).officialUsage.claude!);
    expect(stored).toMatchObject({ view: { raw: "2" }, cycleStartMs: observedAtMs });
  });

  it("detects a Codex restart from a window that jumped a week past R, and records it", async () => {
    await seedSettings("weekly");
    const token = await tokenOf("official");
    await registerProviders(["openai"], NOW.getTime());
    const S = Date.parse("2026-09-21T00:00:00Z");
    const E = Date.parse("2026-09-28T00:00:00Z");
    const R = Date.parse("2026-09-23T08:00:00Z");
    // The first reading is of openai's current cycle (the shared one): nothing moves.
    const first = await POST(
      post(
        body({
          providerId: "openai",
          usedPercent: 90,
          resetsAtMs: E,
          observedAtMs: Date.parse("2026-09-22T12:00:00Z"),
        }),
        token,
      ),
    );
    expect(await first.json()).toMatchObject({ saved: true, cycleChanged: false, detectedReset: null });

    const observedAtMs = Date.parse("2026-09-23T11:55:00Z");
    const response = await POST(
      post(body({ providerId: "openai", usedPercent: 1, resetsAtMs: R + 7 * 86_400_000, observedAtMs }), token),
    );
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer).toMatchObject({
      ok: true,
      saved: true,
      cycleChanged: true,
      reset: { weekday: 3, hour: 8, minute: 0 },
    });
    expect(answer.detectedReset).toEqual({ id: expect.any(String), kind: "restart", atMs: R });

    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings)) as string);
    expect(settings.resetOverrides.openai).toEqual({ weekday: 3, monthDay: 23, hour: 8, minute: 0, source: "reset" });
    expect((await loadResets()).openai?.events).toEqual([
      expect.objectContaining({
        id: answer.detectedReset.id,
        kind: "restart",
        atMs: R,
        cycleStartMs: S,
        before: 90,
        source: "report",
        previousOverride: null,
      }),
    ]);
    const stored = parseStoredOfficialEntry((await loadIndexes()).officialUsage.openai!);
    expect(stored).toMatchObject({ view: { raw: "1", enteredAt: observedAtMs }, cycleStartMs: R });
  });

  it("ignores a reading whose window ends elsewhere while detection is off for the cycle, and moves nothing", async () => {
    await seedSettings("weekly");
    const token = await tokenOf("official");
    await registerProviders(["openai"], NOW.getTime());
    const off = { v: 1 as const, events: [], autoOffCycleStartMs: Date.parse("2026-09-21T00:00:00Z") };
    await saveResets("openai", off);

    const response = await POST(post(body({ providerId: "openai" }), token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      saved: false,
      cycleChanged: false,
      reset: null,
      detectedReset: null,
    });

    const settings = JSON.parse((await getRedis().get<string>(KEYS.settings)) as string);
    expect(settings.resetOverrides).toEqual({});
    expect(await getRedis().hlen(KEYS.officialUsage)).toBe(0);
    expect((await loadResets()).openai).toEqual(off);
  });

  it("answers 409 stale_reading for a window that already reset", async () => {
    await seedSettings("weekly");
    const response = await POST(
      post(body({ resetsAtMs: Date.parse("2026-09-23T11:55:00Z") }), await tokenOf("official")),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("stale_reading");
  });

  it("answers 400 invalid_payload with details for a malformed body", async () => {
    await seedSettings("weekly");
    const response = await POST(post({ providerId: "!!" }, await tokenOf("official")));
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error).toBe("invalid_payload");
    expect(Array.isArray(payload.details)).toBe(true);
  });

  it("refuses in demo mode", async () => {
    vi.stubEnv("DEMO_MODE", "1");
    const response = await POST(post(body()));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("demo_read_only");
  });
});

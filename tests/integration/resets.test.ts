import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, POST, PUT } from "@/app/api/resets/route";
import { getConfig } from "@/lib/config";
import { type CycleSummary, serializeCycleSummary } from "@/lib/history";
import { parseStoredOfficialEntry } from "@/lib/official-usage";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { saveDetectedReset } from "@/lib/reset-store";
import { emptyResets, restartOverride } from "@/lib/resets";
import { ownResetOf, resolveConfig, serializeSettings, settingsFromConfig } from "@/lib/settings";
import { loadIndexes, loadRawSettings, loadResets, registerProviders, saveResets } from "@/lib/usage-store";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

/** /api/resets: a provider's usage resets in the current cycle (lib/reset-recording.ts, lib/reset-store.ts). */

const URL = "http://localhost/api/resets";
const ORIGIN = { origin: "http://localhost", host: "localhost" };
const PIN = "12345";
// Wednesday 2026-09-23 12:00 UTC; the shared reset is Monday 00:00 UTC.
const NOW = new Date("2026-09-23T12:00:00Z");
const S = Date.parse("2026-09-21T00:00:00Z");
const E = Date.parse("2026-09-28T00:00:00Z");
const R = Date.parse("2026-09-22T14:00:00Z");
const WEEK = 7 * 86_400_000;

function send(method: "POST" | "PUT" | "DELETE", body: unknown, headers: Record<string, string>): Request {
  return new Request(URL, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

const handlers = { POST, PUT, DELETE };
async function call(method: "POST" | "PUT" | "DELETE", body: unknown, cookie: string) {
  const response = await handlers[method](send(method, body, { ...ORIGIN, cookie }));
  return { status: response.status, body: await response.json() };
}

async function ownReset(providerId: string) {
  return ownResetOf(resolveConfig(getConfig(), await loadRawSettings()), providerId);
}

async function officialEntry(field: string) {
  const raw = (await loadIndexes()).officialUsage[field];
  return raw ? parseStoredOfficialEntry(raw) : null;
}

describe("/api/resets", () => {
  useRedis();
  let cookie = "";
  beforeEach(async () => {
    vi.stubEnv("DASHBOARD_PIN", PIN);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await getRedis().set(
      KEYS.settings,
      serializeSettings({ ...settingsFromConfig(getConfig()), resetOverrides: {} }, NOW),
    );
    await registerProviders(["claude", "openai"], NOW.getTime());
    cookie = await seedSession(PIN);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("refuses a foreign origin, a missing session and demo mode", async () => {
    const body = { providerId: "claude", atMs: R };
    expect((await POST(send("POST", body, { origin: "https://evil.example", host: "localhost", cookie }))).status).toBe(
      403,
    );
    expect((await POST(send("POST", body, ORIGIN))).status).toBe(401);
    vi.stubEnv("DEMO_MODE", "1");
    const demo = await POST(send("POST", body, { ...ORIGIN, cookie }));
    expect(demo.status).toBe(403);
    expect((await demo.json()).error).toBe("demo_read_only");
  });

  it("answers 400 for a bad body and 404 for an unknown provider", async () => {
    expect((await call("POST", { providerId: "claude", atMs: R + 1 }, cookie)).status).toBe(400);
    const unknown = await call("POST", { providerId: "gemini", atMs: R }, cookie);
    expect(unknown).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it("records a keep reset and answers with the cycle's resets", async () => {
    const { status, body } = await call("POST", { providerId: "claude", atMs: R, before: 80 }, cookie);
    expect(status).toBe(200);
    expect(body.cycle).toEqual({ startMs: S, endMs: E });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      atMs: R,
      kind: "keep",
      before: 80,
      beforeAtMs: null,
      source: "manual",
      cycleStartMs: S,
    });
    expect((await loadResets()).claude?.events).toEqual(body.events);
  });

  it("takes the before-figure from the stored figure read before the reset, and leaves that figure in its segment", async () => {
    const enteredAt = R - 600_000;
    await getRedis().hset(KEYS.officialUsage, { claude: JSON.stringify({ raw: "62", enteredAt, cycleStartMs: S }) });
    const { body } = await call("POST", { providerId: "claude", atMs: R }, cookie);
    expect(body.events[0]).toMatchObject({ before: 62, beforeAtMs: enteredAt });
    expect((await officialEntry("claude"))?.cycleStartMs).toBe(S);
  });

  it("stores the figure given for after the reset in the new segment", async () => {
    await call("POST", { providerId: "claude", atMs: R, before: 80, afterRaw: "3" }, cookie);
    expect(await officialEntry("claude")).toEqual({ view: { raw: "3", enteredAt: R }, cycleStartMs: R });
  });

  it("refuses a moment outside the cycle and a reset's minute twice", async () => {
    expect((await call("POST", { providerId: "claude", atMs: S }, cookie)).body.error).toBe("outside_cycle");
    await call("POST", { providerId: "claude", atMs: R }, cookie);
    const again = await call("POST", { providerId: "claude", atMs: R }, cookie);
    expect(again).toMatchObject({ status: 409, body: { error: "duplicate_reset" } });
  });

  it("records a restart for Codex: a new cycle starts at R, and deleting it puts the old one back", async () => {
    const recorded = await call("POST", { providerId: "openai", atMs: R, before: 90 }, cookie);
    expect(recorded.body.cycle).toEqual({ startMs: R, endMs: R + WEEK });
    expect(recorded.body.events[0]).toMatchObject({ kind: "restart", cycleStartMs: S, previousOverride: null });
    expect(await ownReset("openai")).toEqual({ weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" });

    const deleted = await call("DELETE", { providerId: "openai", id: recorded.body.events[0].id }, cookie);
    expect(deleted.body).toEqual({ ok: true, events: [], cycle: { startMs: S, endMs: E } });
    expect(await ownReset("openai")).toBeNull();
  });

  it("removes the archived summary of the cycle a deleted restart cut short", async () => {
    const summary: CycleSummary = {
      v: 1,
      start: S,
      end: R,
      total: 5,
      limit: null,
      official: null,
      groups: {},
      machines: 1,
      models: {},
      subLimits: {},
      archivedAt: R,
    };
    await getRedis().zadd(KEYS.history("openai"), { score: S, member: serializeCycleSummary(summary) });
    const recorded = await call("POST", { providerId: "openai", atMs: R }, cookie);
    expect(await getRedis().zcard(KEYS.history("openai"))).toBe(1);

    await call("DELETE", { providerId: "openai", id: recorded.body.events[0].id }, cookie);
    expect(await getRedis().zcard(KEYS.history("openai"))).toBe(0);
  });

  it("retags a figure entered after the reset into the new segment", async () => {
    await getRedis().hset(KEYS.officialUsage, {
      claude: JSON.stringify({ raw: "5", enteredAt: R + 60_000, cycleStartMs: S }),
    });
    await call("POST", { providerId: "claude", atMs: R }, cookie);
    expect(await officialEntry("claude")).toEqual({ view: { raw: "5", enteredAt: R + 60_000 }, cycleStartMs: R });
  });

  it("edits a keep reset", async () => {
    const { body } = await call("POST", { providerId: "claude", atMs: R, before: 80 }, cookie);
    const edited = await call(
      "PUT",
      { providerId: "claude", id: body.events[0].id, atMs: R + 3_600_000, before: 70 },
      cookie,
    );
    expect(edited.status).toBe(200);
    expect(edited.body.events[0]).toMatchObject({ atMs: R + 3_600_000, before: 70 });
  });

  it("reverts only a detected reset: its figure comes back and detection stops for the cycle", async () => {
    const manual = await call("POST", { providerId: "claude", atMs: R, before: 80 }, cookie);
    const refused = await call("DELETE", { providerId: "claude", id: manual.body.events[0].id, revert: true }, cookie);
    expect(refused).toMatchObject({ status: 409, body: { error: "not_revertable" } });

    const beforeAtMs = R + 3_600_000 - 600_000;
    await saveResets("claude", {
      v: 1,
      events: [
        {
          id: "detected",
          atMs: R + 3_600_000,
          kind: "keep",
          cycleStartMs: S,
          before: 62,
          beforeAtMs,
          source: "report",
          recordedAtMs: R + 3_600_000,
        },
      ],
      autoOffCycleStartMs: null,
    });
    const reverted = await call("DELETE", { providerId: "claude", id: "detected", revert: true }, cookie);
    expect(reverted.status).toBe(200);
    expect(await officialEntry("claude")).toEqual({ view: { raw: "62", enteredAt: beforeAtMs }, cycleStartMs: S });
    expect((await loadResets()).claude?.autoOffCycleStartMs).toBe(S);
  });
});

describe("saveDetectedReset", () => {
  useRedis();

  it("writes the event, the provider's own reset and the retag together", async () => {
    await getRedis().hset(KEYS.officialUsage, {
      openai: JSON.stringify({ raw: "3", enteredAt: R + 60_000, cycleStartMs: S }),
    });
    const providerIds = ["claude", "openai"];
    const indexes = await loadIndexes();
    const config = resolveConfig(getConfig(), indexes.settings, providerIds);
    const override = restartOverride(R, config.reset.timeZone);

    const event = await saveDetectedReset({
      providerId: "openai",
      config,
      resets: emptyResets(),
      reset: {
        atMs: R,
        kind: "restart",
        cycleStartMs: S,
        before: 90,
        beforeAtMs: R - 60_000,
        source: "report",
        recordedAtMs: NOW.getTime(),
        previousOverride: null,
      },
      override,
      rawSettings: indexes.settings,
      providerIds,
      rawOfficialUsage: indexes.officialUsage,
      now: NOW,
    });

    expect((await loadResets()).openai?.events).toEqual([event]);
    expect(await ownReset("openai")).toEqual(override);
    expect(await officialEntry("openai")).toEqual({ view: { raw: "3", enteredAt: R + 60_000 }, cycleStartMs: R });
  });
});

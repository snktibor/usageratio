import { createTranslator } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateAlerts, sendTestAlert } from "@/lib/alerts";
import type { AlertsConfig } from "@/lib/config";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import en from "@/messages/en.json";
import { useRedis } from "./helpers/redis-fixture";

/**
 * `getTranslations` (next-intl/server) resolves its config through the
 * Next.js build plugin, which is not present under plain Vitest (see
 * tests/integration/setup.test.ts for the same stand-in). lib/alerts.ts only
 * ever asks for one locale/namespace pair per call, so a translator built
 * from the real English messages stands in for it here.
 */
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as "Alerts" }),
}));

function alertsConfig(overrides: Partial<AlertsConfig> = {}): AlertsConfig {
  return {
    webhookUrl: "https://hooks.example.com/x",
    thresholds: [50, 80, 100],
    perProvider: true,
    format: "generic",
    locale: "en",
    ...overrides,
  };
}

const CYCLE = { startMs: 1_700_000_000_000, endMs: 1_700_604_800_000, timeZone: "UTC" };

function mockFetch(status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(new Response(null, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

function bodyOf(fetchSpy: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const init = fetchSpy.mock.calls[call]![1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe("evaluateAlerts", () => {
  useRedis();
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does nothing without a webhook URL", async () => {
    const fetchSpy = mockFetch();
    await evaluateAlerts({
      providerId: "claude",
      label: "Claude",
      usedFraction: 0.9,
      cycle: CYCLE,
      settings: alertsConfig({ webhookUrl: null }),
      now: new Date(),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does nothing while no threshold is crossed", async () => {
    const fetchSpy = mockFetch();
    await evaluateAlerts({
      providerId: "claude",
      label: "Claude",
      usedFraction: 0.3,
      cycle: CYCLE,
      settings: alertsConfig(),
      now: new Date(),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fires once per threshold per cycle", async () => {
    const fetchSpy = mockFetch();
    const params = {
      providerId: "claude",
      label: "Claude",
      usedFraction: 0.55,
      cycle: CYCLE,
      settings: alertsConfig(),
      now: new Date(),
    };
    await evaluateAlerts(params);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await evaluateAlerts(params);
    await evaluateAlerts(params);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("claims the threshold in Redis with a ~70 day TTL", async () => {
    mockFetch();
    await evaluateAlerts({
      providerId: "claude",
      label: "Claude",
      usedFraction: 0.55,
      cycle: CYCLE,
      settings: alertsConfig(),
      now: new Date(),
    });
    const key = KEYS.alert("claude", CYCLE.startMs, 50);
    expect(await getRedis().get(key)).toBe("1");
    const ttl = await getRedis().ttl(key);
    expect(ttl).toBeGreaterThan(69 * 86_400);
    expect(ttl).toBeLessThanOrEqual(70 * 86_400);
  });

  it("fires again once usage crosses a higher threshold in the same cycle", async () => {
    const fetchSpy = mockFetch();
    const base = { providerId: "claude", label: "Claude", cycle: CYCLE, settings: alertsConfig(), now: new Date() };
    await evaluateAlerts({ ...base, usedFraction: 0.55 });
    await evaluateAlerts({ ...base, usedFraction: 0.85 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(bodyOf(fetchSpy, 0).threshold).toBe(50);
    expect(bodyOf(fetchSpy, 1).threshold).toBe(80);
  });

  it("sends only the highest of several thresholds crossed at once", async () => {
    const fetchSpy = mockFetch();
    await evaluateAlerts({
      providerId: "claude",
      label: "Claude",
      usedFraction: 1.5,
      cycle: CYCLE,
      settings: alertsConfig(),
      now: new Date(),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetchSpy).threshold).toBe(100);
  });

  it("a new cycle fires the same threshold again", async () => {
    const fetchSpy = mockFetch();
    const base = {
      providerId: "claude",
      label: "Claude",
      usedFraction: 0.55,
      settings: alertsConfig(),
      now: new Date(),
    };
    await evaluateAlerts({ ...base, cycle: CYCLE });
    const nextCycle = { startMs: CYCLE.endMs, endMs: CYCLE.endMs + 604_800_000, timeZone: "UTC" };
    await evaluateAlerts({ ...base, cycle: nextCycle });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("sends only once when two concurrent calls cross the same threshold", async () => {
    const fetchSpy = mockFetch();
    const params = {
      providerId: "claude",
      label: "Claude",
      usedFraction: 0.55,
      cycle: CYCLE,
      settings: alertsConfig(),
      now: new Date(),
    };
    await Promise.all([evaluateAlerts(params), evaluateAlerts(params)]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("evaluates each provider on its own key", async () => {
    const fetchSpy = mockFetch();
    const base = { label: "Claude", usedFraction: 0.55, cycle: CYCLE, settings: alertsConfig(), now: new Date() };
    await evaluateAlerts({ ...base, providerId: "claude" });
    await evaluateAlerts({ ...base, providerId: "deepseek" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  describe("payload formats", () => {
    it("generic: a structured JSON body with the provider, threshold and cycle", async () => {
      const fetchSpy = mockFetch();
      await evaluateAlerts({
        providerId: "claude",
        label: "Claude",
        usedFraction: 0.85,
        cycle: CYCLE,
        settings: alertsConfig({ format: "generic" }),
        now: new Date(),
      });
      const payload = bodyOf(fetchSpy);
      expect(payload).toMatchObject({
        event: "usageratio.threshold",
        provider: "claude",
        label: "Claude",
        threshold: 80,
        cycle: { start: new Date(CYCLE.startMs).toISOString(), end: new Date(CYCLE.endMs).toISOString() },
      });
      expect(payload.usedPercent).toBeCloseTo(85, 1);
    });

    it("slack: a text field with the label and threshold", async () => {
      const fetchSpy = mockFetch();
      await evaluateAlerts({
        providerId: "claude",
        label: "Claude",
        usedFraction: 0.85,
        cycle: CYCLE,
        settings: alertsConfig({ format: "slack" }),
        now: new Date(),
      });
      const payload = bodyOf(fetchSpy);
      expect(typeof payload.text).toBe("string");
      expect(payload.text).toContain("Claude");
      expect(payload.text).toContain("80");
      expect(payload.content).toBeUndefined();
    });

    it("discord: a content field with the label and threshold", async () => {
      const fetchSpy = mockFetch();
      await evaluateAlerts({
        providerId: "claude",
        label: "Claude",
        usedFraction: 0.85,
        cycle: CYCLE,
        settings: alertsConfig({ format: "discord" }),
        now: new Date(),
      });
      const payload = bodyOf(fetchSpy);
      expect(typeof payload.content).toBe("string");
      expect(payload.content).toContain("Claude");
      expect(payload.text).toBeUndefined();
    });
  });

  it("never throws when the webhook fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    await expect(
      evaluateAlerts({
        providerId: "claude",
        label: "Claude",
        usedFraction: 0.9,
        cycle: CYCLE,
        settings: alertsConfig(),
        now: new Date(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("sendTestAlert", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sends a sample message and returns the webhook result", async () => {
    const fetchSpy = mockFetch();
    const result = await sendTestAlert({ webhookUrl: "https://hooks.example.com/x", format: "slack", locale: "en" });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(typeof bodyOf(fetchSpy).text).toBe("string");
  });

  it("reports a failed test webhook", async () => {
    mockFetch(500);
    const result = await sendTestAlert({ webhookUrl: "https://hooks.example.com/x", format: "generic", locale: "en" });
    expect(result).toEqual({ ok: false, status: 500, error: "webhook responded 500" });
  });
});

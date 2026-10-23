import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as postAlertsTest } from "@/app/api/alerts/test/route";
import { PUT as putOfficialUsage } from "@/app/api/official-usage/route";
import { POST as postUsage } from "@/app/api/usage/route";
import { checkIngestAlerts, checkOfficialUsageAlerts } from "@/lib/alerts";
import { getConfig } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import { ingestReport } from "@/lib/ingest";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { flushDeferred } from "@/lib/request-context";
import { serializeSettings, settingsFromConfig, type UsageSettings } from "@/lib/settings";
import { saveResets } from "@/lib/usage-store";
import en from "@/messages/en.json";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

/** See tests/alerts.test.ts: `getTranslations` needs Next's plugin, absent under plain Vitest. */
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as "Alerts" }),
}));

const ORIGIN = { origin: "http://localhost", host: "localhost" };
const PIN = "12345";
const SERVER_TOKEN = "0123456789abcdef0123456789abcdef";

async function seedSettings(overrides: Partial<UsageSettings>): Promise<void> {
  const settings: UsageSettings = { ...settingsFromConfig(getConfig()), ...overrides };
  await getRedis().set("usage:settings", serializeSettings(settings, new Date()));
}

function mockFetch(status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(new Response(null, { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("threshold alerts, wired into the routes", () => {
  useRedis();
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("PUT /api/official-usage", () => {
    it("sends a webhook once the typed percentage crosses a threshold, while the token limits are off", async () => {
      const config = getConfig();
      const cycle = getCycle(new Date(), config.reset);
      await seedSettings({
        useTokenLimits: false,
        alerts: {
          webhookUrl: "https://hooks.example.com/x",
          thresholds: [50, 80],
          perProvider: true,
          format: "generic",
          locale: "en",
        },
      });
      const fetchSpy = mockFetch();
      const cookie = await seedSession(PIN);
      vi.stubEnv("DASHBOARD_PIN", PIN);

      const response = await putOfficialUsage(
        new Request("http://localhost/api/official-usage", {
          method: "PUT",
          body: JSON.stringify({
            providerId: "claude",
            subLimitId: null,
            raw: "85",
            cycleStartMs: cycle.start.getTime(),
          }),
          headers: { "content-type": "application/json", ...ORIGIN, cookie },
        }),
      );
      expect(response.status).toBe(200);
      await flushDeferred();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://hooks.example.com/x");
      const payload = JSON.parse(String((init as RequestInit).body));
      expect(payload).toMatchObject({ provider: "claude", threshold: 80 });
    });

    it("does not alert for a figure typed for a cycle that has since rolled over", async () => {
      const config = getConfig();
      const cycle = getCycle(new Date(), config.reset);
      await seedSettings({
        useTokenLimits: false,
        alerts: {
          webhookUrl: "https://hooks.example.com/x",
          thresholds: [50],
          perProvider: true,
          format: "generic",
          locale: "en",
        },
      });
      const fetchSpy = mockFetch();
      const cookie = await seedSession(PIN);
      vi.stubEnv("DASHBOARD_PIN", PIN);

      const response = await putOfficialUsage(
        new Request("http://localhost/api/official-usage", {
          method: "PUT",
          body: JSON.stringify({
            providerId: "claude",
            subLimitId: null,
            raw: "85",
            cycleStartMs: cycle.start.getTime() - 604_800_000, // the previous cycle
          }),
          headers: { "content-type": "application/json", ...ORIGIN, cookie },
        }),
      );
      expect(response.status).toBe(200);
      await flushDeferred();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("judges a figure against the provider's own cycle when its reset differs from the shared one", async () => {
      await seedSettings({
        useTokenLimits: false,
        alerts: {
          webhookUrl: "https://hooks.example.com/x",
          thresholds: [90],
          perProvider: true,
          format: "generic",
          locale: "en",
        },
        resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
      });
      const fetchSpy = mockFetch();
      const now = new Date("2026-09-23T12:00:00Z");
      const cycleStartMs = Date.parse("2026-09-17T09:00:00Z");

      await checkOfficialUsageAlerts({ providerId: "claude", subLimitId: null, raw: "95", cycleStartMs }, now);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(await getRedis().exists(KEYS.alert("claude", cycleStartMs, 90))).toBe(1);
    });

    it("does not alert from the official figure while the token limits are on", async () => {
      const config = getConfig();
      const cycle = getCycle(new Date(), config.reset);
      await seedSettings({
        useTokenLimits: true,
        alerts: {
          webhookUrl: "https://hooks.example.com/x",
          thresholds: [50],
          perProvider: true,
          format: "generic",
          locale: "en",
        },
      });
      const fetchSpy = mockFetch();
      const cookie = await seedSession(PIN);
      vi.stubEnv("DASHBOARD_PIN", PIN);

      await putOfficialUsage(
        new Request("http://localhost/api/official-usage", {
          method: "PUT",
          body: JSON.stringify({
            providerId: "claude",
            subLimitId: null,
            raw: "85",
            cycleStartMs: cycle.start.getTime(),
          }),
          headers: { "content-type": "application/json", ...ORIGIN, cookie },
        }),
      );
      await flushDeferred();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/usage", () => {
    beforeEach(() => vi.stubEnv("USAGE_API_TOKEN", SERVER_TOKEN));

    it("sends a webhook once measured tokens cross a threshold, while the token limits are on", async () => {
      await seedSettings({
        useTokenLimits: true,
        limits: { claude: 1000 },
        alerts: {
          webhookUrl: "https://hooks.example.com/x",
          thresholds: [50, 80],
          perProvider: true,
          format: "generic",
          locale: "en",
        },
      });
      const fetchSpy = mockFetch();

      const response = await postUsage(
        new Request("http://localhost/api/usage", {
          method: "POST",
          body: JSON.stringify({
            machineId: "mac",
            groupId: "Personal",
            providers: { claude: 900 },
            timestamp: new Date().toISOString(),
          }),
          headers: { authorization: `Bearer ${SERVER_TOKEN}` },
        }),
      );
      expect(response.status).toBe(201);
      await flushDeferred();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, init] = fetchSpy.mock.calls[0]!;
      const payload = JSON.parse(String((init as RequestInit).body));
      expect(payload).toMatchObject({ provider: "claude", threshold: 80 });
    });
  });

  describe("after a keep reset", () => {
    const NOW = new Date("2026-09-23T12:00:00Z");
    const S = Date.parse("2026-09-21T00:00:00Z");
    const R = Date.parse("2026-09-23T08:00:00Z");
    const resetDoc = {
      v: 1 as const,
      events: [
        {
          id: "r",
          atMs: R,
          kind: "keep" as const,
          cycleStartMs: S,
          before: 95,
          beforeAtMs: null,
          source: "manual" as const,
          recordedAtMs: R,
        },
      ],
      autoOffCycleStartMs: null,
    };
    const alerts = {
      webhookUrl: "https://hooks.example.com/x",
      thresholds: [50, 90],
      perProvider: true,
      format: "generic" as const,
      locale: "en",
    };

    it("fires the thresholds again for the new segment's figure", async () => {
      await seedSettings({ useTokenLimits: false, resetOverrides: {}, alerts });
      await saveResets("claude", resetDoc);
      const fetchSpy = mockFetch();

      await checkOfficialUsageAlerts({ providerId: "claude", subLimitId: null, raw: "92", cycleStartMs: R }, NOW);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(await getRedis().exists(KEYS.alert("claude", R, 90))).toBe(1);
    });

    it("ignores a figure tagged with an earlier segment", async () => {
      await seedSettings({ useTokenLimits: false, resetOverrides: {}, alerts });
      await saveResets("claude", resetDoc);
      const fetchSpy = mockFetch();

      await checkOfficialUsageAlerts({ providerId: "claude", subLimitId: null, raw: "92", cycleStartMs: S }, NOW);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("measures the tokens of the segment only", async () => {
      await seedSettings({ useTokenLimits: true, limits: { claude: 1000 }, resetOverrides: {}, alerts });
      await saveResets("claude", resetDoc);
      const fetchSpy = mockFetch();
      const store = async (tokens: number, iso: string) => {
        const at = new Date(iso);
        const result = await ingestReport(
          { machineId: "mac", groupId: "Personal", providers: { claude: tokens }, timestamp: iso },
          at,
        );
        if (!result.ok) throw new Error(JSON.stringify(result));
        return result.report;
      };
      await store(900, "2026-09-23T07:00:00Z");
      const last = await store(1000, "2026-09-23T11:00:00Z");

      // 1000 since the cycle start would be 100%; since the reset it is 100 tokens, 10%.
      await checkIngestAlerts(last, NOW);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/alerts/test", () => {
    beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));

    const VALID_BODY = { webhookUrl: "https://hooks.example.com/x", format: "slack", locale: "en" };

    function post(body: unknown, headers: Record<string, string> = {}): Request {
      return new Request("http://localhost/api/alerts/test", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json", ...headers },
      });
    }

    it("answers 403 for a foreign Origin", async () => {
      const response = await postAlertsTest(post(VALID_BODY, { origin: "https://evil.example", host: "localhost" }));
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("forbidden_origin");
    });

    it("answers 401 without a session", async () => {
      const response = await postAlertsTest(post(VALID_BODY, ORIGIN));
      expect(response.status).toBe(401);
    });

    it("answers 400 invalid_payload for a disallowed webhook URL", async () => {
      const cookie = await seedSession(PIN);
      const response = await postAlertsTest(
        post({ ...VALID_BODY, webhookUrl: "https://localhost/x" }, { ...ORIGIN, cookie }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("invalid_payload");
    });

    it("answers 400 invalid_payload for an unknown format", async () => {
      const cookie = await seedSession(PIN);
      const response = await postAlertsTest(post({ ...VALID_BODY, format: "teams" }, { ...ORIGIN, cookie }));
      expect(response.status).toBe(400);
    });

    it("answers 400 invalid_payload for an unsupported locale", async () => {
      const cookie = await seedSession(PIN);
      const response = await postAlertsTest(post({ ...VALID_BODY, locale: "xx" }, { ...ORIGIN, cookie }));
      expect(response.status).toBe(400);
    });

    it("sends the sample message and answers 200", async () => {
      const cookie = await seedSession(PIN);
      mockFetch(200);
      const response = await postAlertsTest(post(VALID_BODY, { ...ORIGIN, cookie }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ ok: true, status: 200 });
    });

    it("answers 502 webhook_failed when the webhook responds with an error status", async () => {
      const cookie = await seedSession(PIN);
      mockFetch(500);
      const response = await postAlertsTest(post(VALID_BODY, { ...ORIGIN, cookie }));
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error).toBe("webhook_failed");
      expect(body.status).toBe(500);
      expect(body.detail).toBe("webhook responded 500");
    });

    it("throttles to one attempt per 10 seconds", async () => {
      const cookie = await seedSession(PIN);
      mockFetch(200);
      const first = await postAlertsTest(post(VALID_BODY, { ...ORIGIN, cookie }));
      expect(first.status).toBe(200);
      const second = await postAlertsTest(post(VALID_BODY, { ...ORIGIN, cookie }));
      expect(second.status).toBe(429);
      expect((await second.json()).error).toBe("rate_limited");
    });
  });
});

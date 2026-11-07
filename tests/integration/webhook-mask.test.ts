import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as testAlert } from "@/app/api/alerts/test/route";
import { GET as getSettings, PUT as putSettings } from "@/app/api/settings/route";
import { getConfig } from "@/lib/config";
import { addMember } from "@/lib/members";
import { getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { storedWebhookUrl } from "@/lib/settings";
import { tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { loadIndexes } from "@/lib/usage-store";
import { startUserSession } from "@/lib/user-session";
import { createTenantFor, findOrCreateGithubUser } from "@/lib/users";
import en from "@/messages/en.json";
import { useRedis } from "../helpers/redis-fixture";
import { withRequest } from "../helpers/request";

/**
 * The alert webhook URL in a multi-tenant workspace (the design's decision 3):
 * nobody reads it back, its owner included, since a member who could would
 * be able to post into the owner's Slack. The settings answer it masked; the
 * mask sent back unchanged keeps it, an edited mask is refused, a new URL
 * replaces it; "send test" with the mask goes to the stored URL. A
 * single-user instance keeps showing it in full.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as "Alerts" }),
}));

const ORIGIN = { origin: "http://localhost", host: "localhost" };
const SECRET_URL = "https://hooks.slack.com/services/T000/B000/secretpart4f2a";
const MASK = "https://hooks.slack.com/…••••4f2a";

interface Person {
  tenantId: TenantId;
  cookie: string;
}

async function person(githubId: number, login: string, tenant?: TenantId): Promise<Person> {
  const now = new Date();
  const { userId } = await findOrCreateGithubUser({ id: githubId, login }, now);
  const tenantId = tenant ?? (await createTenantFor(userId, login, now));
  if (tenant) await addMember(tenant, userId, "u_owner", now);
  const header = await withRequest(() => startUserSession(userId, tenantId, now));
  return { tenantId, cookie: header.split(";")[0]! };
}

function request(path: string, as: Person, init: { method?: string; body?: unknown } = {}) {
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...ORIGIN,
      cookie: as.cookie,
      "x-usageratio-tenant": as.tenantId,
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}

function settingsBody(webhookUrl: string | null) {
  return {
    period: "weekly",
    useTokenLimits: false,
    limits: { claude: 500_000 },
    reset: { weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
    resetOverrides: {},
    resetModes: {},
    showRemaining: true,
    costEstimate: false,
    hiddenProviders: [],
    excludedProviders: {},
    subLimits: {},
    alerts: { webhookUrl, thresholds: [50, 80, 100], perProvider: true, format: "slack", locale: "en" },
    groups: [],
    removedGroups: [],
  };
}

async function shownUrl(as: Person): Promise<{ url: string | null; masked: boolean | undefined; raw: string }> {
  const response = await getSettings(request("/api/settings", as));
  const raw = await response.text();
  const body = JSON.parse(raw) as { settings: { alerts: { webhookUrl: string | null } }; webhookMasked?: boolean };
  return { url: body.settings.alerts.webhookUrl, masked: body.webhookMasked, raw };
}

async function stored(tenantId: TenantId): Promise<string | null> {
  return storedWebhookUrl((await loadIndexes(tenantStore(tenantId))).settings, getConfig());
}

describe("the alert webhook URL in a multi-tenant workspace", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("REGISTRATION", "invite"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is never read back, by the owner or a member, and the mask sent back keeps it", async () => {
    const owner = await person(1, "alice");
    const member = await person(2, "bob", owner.tenantId);
    const saved = await putSettings(request("/api/settings", owner, { method: "PUT", body: settingsBody(SECRET_URL) }));
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain("secretpart");

    for (const who of [owner, member]) {
      const shown = await shownUrl(who);
      expect(shown).toMatchObject({ url: MASK, masked: true });
      expect(shown.raw).not.toContain("secretpart");
    }

    // The member saves the whole form, the mask untouched: the URL stays.
    expect(
      (await putSettings(request("/api/settings", member, { method: "PUT", body: settingsBody(MASK) }))).status,
    ).toBe(200);
    expect(await stored(owner.tenantId)).toBe(SECRET_URL);

    // An edited mask is no URL; a new URL replaces the old one; null turns alerts off.
    const edited = await putSettings(
      request("/api/settings", member, { method: "PUT", body: settingsBody("https://hooks.slack.com/…••••4f2b") }),
    );
    expect(edited.status).toBe(400);
    expect(await stored(owner.tenantId)).toBe(SECRET_URL);
    await putSettings(
      request("/api/settings", member, { method: "PUT", body: settingsBody("https://new.example/hook") }),
    );
    expect(await stored(owner.tenantId)).toBe("https://new.example/hook");
    // The old mask now names nothing.
    expect(
      (await putSettings(request("/api/settings", owner, { method: "PUT", body: settingsBody(MASK) }))).status,
    ).toBe(400);
  });

  it("sends the test message to the stored URL when the page sends its mask", async () => {
    const owner = await person(1, "alice");
    await putSettings(request("/api/settings", owner, { method: "PUT", body: settingsBody(SECRET_URL) }));
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const sent = await testAlert(
      request("/api/alerts/test", owner, { method: "POST", body: { webhookUrl: MASK, format: "slack", locale: "en" } }),
    );
    expect(sent.status).toBe(200);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(SECRET_URL);

    await getRedis().del(GLOBAL_KEYS.rateLimit.alertsTest);
    const edited = await testAlert(
      request("/api/alerts/test", owner, {
        method: "POST",
        body: { webhookUrl: "https://hooks.slack.com/…••••0000", format: "slack", locale: "en" },
      }),
    );
    expect(edited.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stays in full on a single-user instance", async () => {
    vi.stubEnv("REGISTRATION", "closed");
    vi.stubEnv("DASHBOARD_PIN", "12345");
    const { seedSession } = await import("../helpers/session");
    const cookie = await seedSession("12345");
    const pin = (method: string, body?: unknown) =>
      new Request("http://localhost/api/settings", {
        method,
        headers: { ...ORIGIN, cookie, ...(body !== undefined && { "content-type": "application/json" }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    expect((await putSettings(pin("PUT", settingsBody(SECRET_URL)))).status).toBe(200);
    const body = (await (await getSettings(pin("GET"))).json()) as {
      settings: { alerts: { webhookUrl: string | null } };
      webhookMasked?: boolean;
    };
    expect(body.settings.alerts.webhookUrl).toBe(SECRET_URL);
    expect(body.webhookMasked).toBeUndefined();
  });
});

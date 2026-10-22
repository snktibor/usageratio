import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "@/app/api/settings/route";
import { ingestReport } from "@/lib/ingest";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

const URL = "http://localhost/api/settings";
const ORIGIN = { origin: "http://localhost", host: "localhost" };
const PIN = "12345";

const VALID_UPDATE = {
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
  alerts: { webhookUrl: null, thresholds: [50, 80, 100], perProvider: true, format: "generic", locale: "en" },
  groups: [],
  removedGroups: [],
};

function get(headers: Record<string, string> = {}): Request {
  return new Request(URL, { headers });
}

function put(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL, { method: "PUT", body, headers: { "content-type": "application/json", ...headers } });
}

describe("PUT|GET /api/settings", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("GET answers 401 without a session", async () => {
    const response = await GET(get());
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toBe("unauthorized");
    expect(body.requestId).toBeTruthy();
  });

  it("PUT answers 403 for a foreign Origin, before even checking the session", async () => {
    const response = await PUT(
      put(JSON.stringify(VALID_UPDATE), { origin: "https://evil.example", host: "localhost" }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("forbidden_origin");
  });

  it("PUT answers 401 without a session", async () => {
    const response = await PUT(put(JSON.stringify(VALID_UPDATE), ORIGIN));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("unauthorized");
  });

  it("PUT answers 415 for a non-JSON Content-Type", async () => {
    const cookie = await seedSession(PIN);
    const response = await PUT(
      new Request(URL, { method: "PUT", body: "{}", headers: { ...ORIGIN, cookie, "content-type": "text/plain" } }),
    );
    expect(response.status).toBe(415);
    expect((await response.json()).error).toBe("unsupported_media_type");
  });

  it("PUT answers 413 for a body over 16 KiB", async () => {
    const cookie = await seedSession(PIN);
    const huge = JSON.stringify({ ...VALID_UPDATE, padding: "x".repeat(20_000) });
    const response = await PUT(put(huge, { ...ORIGIN, cookie }));
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toBe("payload_too_large");
    expect(body.maxBytes).toBe(16_384);
  });

  it("PUT answers 400 invalid_payload with details for a structurally wrong body", async () => {
    const cookie = await seedSession(PIN);
    const response = await PUT(put(JSON.stringify({ ...VALID_UPDATE, period: "yearly" }), { ...ORIGIN, cookie }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_payload");
    expect(body.details).toEqual(expect.arrayContaining([expect.stringContaining("period")]));
  });

  it("PUT answers 409 and saves nothing when a removed group still has stored reports", async () => {
    const cookie = await seedSession(PIN);
    const ingested = await ingestReport(
      { machineId: "mac", groupId: "Work", providers: { claude: 100 }, timestamp: new Date().toISOString() },
      new Date(),
    );
    expect(ingested.ok).toBe(true);

    const response = await PUT(
      put(JSON.stringify({ ...VALID_UPDATE, removedGroups: ["Work"] }), { ...ORIGIN, cookie }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("groups_have_reports");
    expect(body.groups).toEqual(["Work"]);
  });

  it("PUT saves and answers 200; GET then reflects the stored document", async () => {
    const cookie = await seedSession(PIN);
    const update = { ...VALID_UPDATE, limits: { claude: 750_000 }, groups: [{ id: "Work", color: "#3987e5" }] };
    const putResponse = await PUT(put(JSON.stringify(update), { ...ORIGIN, cookie }));
    expect(putResponse.status).toBe(200);
    const putBody = await putResponse.json();
    const { groups, removedGroups, ...settings } = update;
    expect(putBody).toEqual({ ok: true, settings });

    const getResponse = await GET(get({ cookie }));
    expect(getResponse.status).toBe(200);
    const getBody = await getResponse.json();
    expect(getBody.settings.limits).toEqual({ claude: 750_000 });
    expect(getBody.timeZone).toBe("UTC");
    expect(getBody.groups).toEqual(expect.arrayContaining([expect.objectContaining({ id: "Work" })]));
  });
});

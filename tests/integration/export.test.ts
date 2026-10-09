import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/export/route";
import { getConfig } from "@/lib/config";
import { ingestReport } from "@/lib/ingest";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { serializeSettings, settingsFromConfig } from "@/lib/settings";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

const PIN = "12345";

function get(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/export?${query}`, { headers });
}

describe("GET /api/export", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 401 without a session", async () => {
    const response = await GET(get("format=csv"));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("unauthorized");
  });

  it("answers 400 invalid_payload for a bad or missing format", async () => {
    const cookie = await seedSession(PIN);
    const response = await GET(get("format=xml", { cookie }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("invalid_payload");
    expect(body.details).toEqual(expect.arrayContaining([expect.stringContaining("format")]));
  });

  it("answers 404 for a provider nothing ever reported", async () => {
    const cookie = await seedSession(PIN);
    const response = await GET(get("format=json&provider=nobody", { cookie }));
    expect(response.status).toBe(404);
  });

  it("streams the current cycle's reports as CSV, with the download headers", async () => {
    const cookie = await seedSession(PIN);
    const now = new Date();
    const ingested = await ingestReport(
      {
        machineId: "mac",
        groupId: "Work",
        providers: { claude: 500 },
        models: { claude: { "claude-sonnet-4-5-20250929": 500 } },
        timestamp: now.toISOString(),
      },
      now,
    );
    expect(ingested.ok).toBe(true);

    const response = await GET(get("format=csv&cycle=current", { cookie }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="usageratio-all-\d{4}-\d{2}-\d{2}\.csv"$/,
    );

    const csv = await response.text();
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("provider,groupId,machineId,timestamp,tokens,checkpoint,models,costUsd");
    expect(lines.some((line) => line.startsWith("claude,Work,mac,"))).toBe(true);
    expect(csv).toContain(JSON.stringify({ "claude-sonnet-4-5-20250929": 500 }).replace(/"/g, '""'));
  });

  it("streams the current cycle's reports as JSON, scoped to one provider", async () => {
    const cookie = await seedSession(PIN);
    const now = new Date();
    await ingestReport(
      { machineId: "mac", groupId: "Work", providers: { claude: 500, openai: 300 }, timestamp: now.toISOString() },
      now,
    );

    const response = await GET(get("format=json&provider=claude", { cookie }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="usageratio-claude-\d{4}-\d{2}-\d{2}\.json"$/,
    );

    const body = await response.json();
    expect(typeof body.generatedAt).toBe("string");
    expect(typeof body.timeZone).toBe("string");
    expect(body.cycle).toEqual({ start: expect.any(String), end: expect.any(String) });
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].id).toBe("claude");
    expect(body.providers[0].events).toEqual([
      expect.objectContaining({ provider: "claude", groupId: "Work", machineId: "mac", tokens: 500 }),
    ]);
    expect(Array.isArray(body.providers[0].history)).toBe(true);
  });

  it("answers only the previous cycle's reports when cycle=previous is asked for", async () => {
    const cookie = await seedSession(PIN);
    const now = new Date();
    // A report from the current cycle must not leak into the previous cycle's export.
    await ingestReport(
      { machineId: "mac", groupId: "Work", providers: { claude: 500 }, timestamp: now.toISOString() },
      now,
    );

    const response = await GET(get("format=json&provider=claude&cycle=previous", { cookie }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.providers[0].events).toEqual([]);
  });

  it("windows each provider by its own cycle", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
      const cookie = await seedSession(PIN);
      // The shared reset is Monday 00:00 UTC; Claude's is Thursday 09:00.
      const settings = {
        ...settingsFromConfig(getConfig()),
        resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
      };
      await getRedis().set(KEYS.settings, serializeSettings(settings, new Date()));
      for (const at of ["2026-09-16T12:00:00Z", "2026-09-18T12:00:00Z", "2026-09-22T12:00:00Z"]) {
        const when = new Date(at);
        const ingested = await ingestReport(
          { machineId: "mac", groupId: "Work", providers: { claude: 500, openai: 300 }, timestamp: at },
          when,
        );
        expect(ingested.ok).toBe(true);
      }

      const response = await GET(get("format=json", { cookie }));
      const body = await response.json();
      const claude = body.providers.find((provider: { id: string }) => provider.id === "claude");
      const openai = body.providers.find((provider: { id: string }) => provider.id === "openai");
      expect(claude.cycle.start).toBe("2026-09-17T09:00:00.000Z");
      expect(claude.events.map((event: { timestamp: string }) => event.timestamp)).toEqual([
        "2026-09-18T12:00:00.000Z",
        "2026-09-22T12:00:00.000Z",
      ]);
      expect(openai.cycle.start).toBe("2026-09-21T00:00:00.000Z");
      expect(openai.events).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

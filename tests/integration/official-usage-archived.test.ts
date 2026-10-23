import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT } from "@/app/api/official-usage/archived/route";
import type { CycleSummary } from "@/lib/history";
import { archiveCycle, loadHistory } from "@/lib/usage-store";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

const URL = "http://localhost/api/official-usage/archived";
const ORIGIN = { origin: "http://localhost", host: "localhost" };
const PIN = "12345";
const START = Date.parse("2026-09-28T00:00:00Z");
const END = Date.parse("2026-10-05T00:00:00Z");

const SUMMARY: CycleSummary = {
  v: 1,
  start: START,
  end: END,
  total: 5_000_000,
  limit: null,
  official: 82,
  groups: { work: 5_000_000 },
  machines: 2,
  models: {},
  subLimits: {},
  archivedAt: END,
};

function put(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("PUT /api/official-usage/archived", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 403 for a foreign Origin", async () => {
    const response = await PUT(
      put(
        { providerId: "claude", raw: "100", cycleStartMs: START },
        { origin: "https://evil.example", host: "localhost" },
      ),
    );
    expect(response.status).toBe(403);
  });

  it("answers 401 without a session", async () => {
    const response = await PUT(put({ providerId: "claude", raw: "100", cycleStartMs: START }, ORIGIN));
    expect(response.status).toBe(401);
  });

  it("answers 400 invalid_payload for a figure above 100", async () => {
    const cookie = await seedSession(PIN);
    const response = await PUT(put({ providerId: "claude", raw: "120", cycleStartMs: START }, { ...ORIGIN, cookie }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_payload");
  });

  it("answers 404 for a cycle with no archived summary", async () => {
    const cookie = await seedSession(PIN);
    const response = await PUT(put({ providerId: "claude", raw: "100", cycleStartMs: START }, { ...ORIGIN, cookie }));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("not_found");
  });

  it("corrects the archived figure: 82% → 100%", async () => {
    await archiveCycle("claude", SUMMARY);
    const cookie = await seedSession(PIN);
    const response = await PUT(put({ providerId: "claude", raw: "100", cycleStartMs: START }, { ...ORIGIN, cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await loadHistory(["claude"])).claude).toEqual([{ ...SUMMARY, official: 100 }]);
  });

  it("corrects one segment of a cycle with keep resets, and answers 404 for a segment it does not have", async () => {
    const MID = START + 3 * 86_400_000;
    await archiveCycle("claude", {
      ...SUMMARY,
      official: 100,
      segments: [
        { start: START, end: MID, official: 80, total: 3_000_000, groups: { work: 3_000_000 } },
        { start: MID, end: END, official: 20, total: 2_000_000, groups: { work: 2_000_000 } },
      ],
    });
    const cookie = await seedSession(PIN);

    const ok = await PUT(
      put({ providerId: "claude", raw: "44", cycleStartMs: START, segmentStartMs: MID }, { ...ORIGIN, cookie }),
    );
    expect(ok.status).toBe(200);
    const [stored] = (await loadHistory(["claude"])).claude ?? [];
    expect(stored?.official).toBe(124);
    expect(stored?.segments?.map((segment) => segment.official)).toEqual([80, 44]);

    const missing = await PUT(
      put({ providerId: "claude", raw: "44", cycleStartMs: START, segmentStartMs: MID + 1 }, { ...ORIGIN, cookie }),
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("not_found");
  });
});

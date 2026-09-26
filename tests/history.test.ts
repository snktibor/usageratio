import { describe, expect, it } from "vitest";
import type { UsageEvent } from "@/lib/aggregate";
import {
  type CycleSummary,
  HISTORY_RETENTION,
  HISTORY_TOP_MODELS,
  officialPercentForCycle,
  parseCycleSummary,
  serializeCycleSummary,
  summarizeCycle,
} from "@/lib/history";
import { serializeOfficialEntry } from "@/lib/official-usage";
import { getRedis } from "@/lib/redis";
import type { SubLimit } from "@/lib/sub-limits";
import { archiveCycle, loadHistory, loadNewestArchivedStarts } from "@/lib/usage-store";
import { useRedis } from "./helpers/redis-fixture";

const HOUR = 3_600_000;
const WINDOW = { startMs: 0, endMs: 7 * 24 * HOUR };

describe("summarizeCycle", () => {
  it("measures total, groups, machines and the model breakdown the way the live dashboard does", () => {
    const events: UsageEvent[] = [
      {
        machineId: "mac",
        groupId: "Work",
        tokens: 700,
        ts: HOUR,
        models: { "claude-opus-4-5-20251101": 500, "claude-sonnet-4-5-20250929": 200 },
      },
      { machineId: "pc", groupId: "Personal", tokens: 300, ts: 2 * HOUR, models: { "claude-opus-4-5-20251101": 300 } },
    ];

    const summary = summarizeCycle({
      events,
      window: WINDOW,
      mode: "snapshot",
      limit: 1000,
      official: 62.5,
      subLimits: [],
      archivedAt: WINDOW.endMs,
    });

    expect(summary.v).toBe(1);
    expect(summary.start).toBe(WINDOW.startMs);
    expect(summary.end).toBe(WINDOW.endMs);
    expect(summary.total).toBe(1000);
    expect(summary.limit).toBe(1000);
    expect(summary.official).toBe(62.5);
    expect(summary.groups).toEqual({ Work: 700, Personal: 300 });
    expect(summary.machines).toBe(2);
    // "claude-opus-4-5" merges the two dated reports of the same model; "claude-sonnet-4-5" is the lighter one.
    expect(summary.models).toEqual({ "claude-opus-4-5": 800, "claude-sonnet-4-5": 200 });
    expect(summary.subLimits).toEqual({});
  });

  it("keeps only the heaviest HISTORY_TOP_MODELS models", () => {
    const models: Record<string, number> = {};
    for (let i = 0; i < HISTORY_TOP_MODELS + 5; i += 1) models[`model-${i}`] = i + 1; // model-(N-1) is heaviest
    const events: UsageEvent[] = [
      { machineId: "mac", groupId: "Work", tokens: Object.values(models).reduce((a, b) => a + b, 0), ts: HOUR, models },
    ];

    const summary = summarizeCycle({
      events,
      window: WINDOW,
      mode: "snapshot",
      limit: null,
      official: null,
      subLimits: [],
      archivedAt: 0,
    });

    expect(Object.keys(summary.models)).toHaveLength(HISTORY_TOP_MODELS);
    // The heaviest models are model-(N-1) downwards.
    const total = HISTORY_TOP_MODELS + 5;
    for (let rank = 0; rank < HISTORY_TOP_MODELS; rank += 1) {
      expect(summary.models[`model-${total - 1 - rank}`]).toBe(total - rank);
    }
  });

  it("splits a separate sub-limit's tokens out of the total, and reports them under subLimits", () => {
    const subLimits: SubLimit[] = [
      { id: "fable", name: "Fable", models: ["fable"], mode: "separate", sharePercent: 100, limit: 200 },
    ];
    const events: UsageEvent[] = [
      {
        machineId: "mac",
        groupId: "Work",
        tokens: 900,
        ts: HOUR,
        models: { "claude-sonnet-4-5": 700, "claude-fable-5-1": 200 },
      },
    ];

    const summary = summarizeCycle({
      events,
      window: WINDOW,
      mode: "snapshot",
      limit: null,
      official: null,
      subLimits,
      archivedAt: 0,
    });

    expect(summary.total).toBe(700);
    expect(summary.subLimits).toEqual({ fable: 200 });
    // The model breakdown still lists both: it looks at every report as sent, sub-limit split or not.
    expect(summary.models).toEqual({ "claude-sonnet-4-5": 700, "claude-fable-5-1": 200 });
  });

  it("has no machines, groups or models for an empty cycle", () => {
    const summary = summarizeCycle({
      events: [],
      window: WINDOW,
      mode: "snapshot",
      limit: null,
      official: null,
      subLimits: [],
      archivedAt: 0,
    });
    expect(summary.total).toBe(0);
    expect(summary.machines).toBe(0);
    expect(summary.groups).toEqual({});
    expect(summary.models).toEqual({});
  });
});

describe("serializeCycleSummary / parseCycleSummary", () => {
  const summary: CycleSummary = {
    v: 1,
    start: 0,
    end: WINDOW.endMs,
    total: 100,
    limit: 500,
    official: 42,
    groups: { Work: 100 },
    machines: 1,
    models: { "claude-sonnet-4-5": 100 },
    subLimits: {},
    archivedAt: 123,
  };

  it("round-trips a summary byte for byte", () => {
    expect(parseCycleSummary(serializeCycleSummary(summary))).toEqual(summary);
  });

  it("reads null limit and official back as null, not missing", () => {
    const withoutFigures = { ...summary, limit: null, official: null };
    expect(parseCycleSummary(serializeCycleSummary(withoutFigures))).toEqual(withoutFigures);
  });

  it("reads damaged or foreign JSON as null rather than throwing", () => {
    expect(parseCycleSummary("not json")).toBeNull();
    expect(parseCycleSummary("null")).toBeNull();
    expect(parseCycleSummary(JSON.stringify({ ...summary, v: 2 }))).toBeNull();
    expect(parseCycleSummary(JSON.stringify({ ...summary, groups: { Work: "100" } }))).toBeNull();
    expect(parseCycleSummary(JSON.stringify({ ...summary, total: "not a number" }))).toBeNull();
  });
});

describe("officialPercentForCycle", () => {
  const FIELD = "claude";

  it("picks the entry whose own cycle matches, and ignores every other cycle's", () => {
    const raw = {
      [FIELD]: serializeOfficialEntry({ raw: "62.5", enteredAt: 1000, cycleStartMs: 7 * HOUR }),
    };
    expect(officialPercentForCycle(raw, "claude", 7 * HOUR)).toBe(62.5);
    // The very same field, but for a different cycle's start: not this one's figure.
    expect(officialPercentForCycle(raw, "claude", 0)).toBeNull();
    expect(officialPercentForCycle(raw, "claude", 14 * HOUR)).toBeNull();
  });

  it("is null without a stored entry, or for a provider that has none", () => {
    expect(officialPercentForCycle({}, "claude", 0)).toBeNull();
    const raw = { [FIELD]: serializeOfficialEntry({ raw: "62.5", enteredAt: 1000, cycleStartMs: 0 }) };
    expect(officialPercentForCycle(raw, "openai", 0)).toBeNull();
  });

  it("is null when the stored text does not parse as a percentage", () => {
    const raw = { [FIELD]: serializeOfficialEntry({ raw: "not a number", enteredAt: 1000, cycleStartMs: 0 }) };
    expect(officialPercentForCycle(raw, "claude", 0)).toBeNull();
  });
});

function summaryAt(startMs: number): CycleSummary {
  return {
    v: 1,
    start: startMs,
    end: startMs + WINDOW.endMs,
    total: startMs, // distinguishes entries in assertions below
    limit: null,
    official: null,
    groups: {},
    machines: 0,
    models: {},
    subLimits: {},
    archivedAt: startMs,
  };
}

describe("archiveCycle / loadHistory / loadNewestArchivedStarts", () => {
  useRedis();

  it("writes a new cycle, and loadHistory reads it back newest first", async () => {
    expect(await archiveCycle("claude", summaryAt(HOUR))).toBe(true);
    expect(await archiveCycle("claude", summaryAt(2 * HOUR))).toBe(true);

    const history = await loadHistory(["claude"]);
    expect(history.claude?.map((entry) => entry.start)).toEqual([2 * HOUR, HOUR]);
  });

  it("is idempotent: the identical summary archived twice is written once", async () => {
    const summary = summaryAt(HOUR);
    expect(await archiveCycle("claude", summary)).toBe(true);
    // A second render building the very same bytes (see lib/history.ts `archivedAt`) loses the ZADD NX race harmlessly.
    expect(await archiveCycle("claude", summary)).toBe(false);

    const history = await loadHistory(["claude"]);
    expect(history.claude).toHaveLength(1);
  });

  it("keeps only the newest HISTORY_RETENTION cycles per provider", async () => {
    for (let i = 1; i <= HISTORY_RETENTION + 5; i += 1) {
      await archiveCycle("claude", summaryAt(i * HOUR));
    }
    const history = await loadHistory(["claude"]);
    expect(history.claude).toHaveLength(HISTORY_RETENTION);
    // The oldest 5 were trimmed away; the newest HISTORY_RETENTION remain, newest first.
    expect(history.claude?.[0]?.start).toBe((HISTORY_RETENTION + 5) * HOUR);
    expect(history.claude?.at(-1)?.start).toBe(6 * HOUR);
  });

  it("keeps every provider's history in its own key", async () => {
    await archiveCycle("claude", summaryAt(HOUR));
    await archiveCycle("openai", summaryAt(HOUR));
    const history = await loadHistory(["claude", "openai"]);
    expect(history.claude).toHaveLength(1);
    expect(history.openai).toHaveLength(1);
  });

  it("reports the newest archived start per provider, and null before anything is archived", async () => {
    expect(await loadNewestArchivedStarts(["claude"])).toEqual({ claude: null });
    await archiveCycle("claude", summaryAt(HOUR));
    await archiveCycle("claude", summaryAt(3 * HOUR));
    await archiveCycle("claude", summaryAt(2 * HOUR));
    expect(await loadNewestArchivedStarts(["claude", "openai"])).toEqual({ claude: 3 * HOUR, openai: null });
  });

  it("skips a damaged member instead of failing the whole read", async () => {
    await archiveCycle("claude", summaryAt(HOUR));
    await getRedis().zadd("usage:history:claude", { score: 2 * HOUR, member: "not json" });
    const history = await loadHistory(["claude"]);
    expect(history.claude?.map((entry) => entry.start)).toEqual([HOUR]);
  });
});

import { describe, expect, it } from "vitest";
import { allTimeCycles, ledgerEntryOf, summarizeAllTime } from "@/lib/all-time";
import { type CycleSummary, HISTORY_RETENTION, serializeCycleSummary } from "@/lib/history";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { archiveCycle, loadAllTime, loadHistory, saveArchivedOfficial } from "@/lib/usage-store";
import { useRedis } from "./helpers/redis-fixture";

const DAY = 86_400_000;
const WEEK = 7 * DAY;

function cycle(index: number, overrides: Partial<CycleSummary> = {}): CycleSummary {
  const start = index * WEEK;
  return {
    v: 1,
    start,
    end: start + WEEK,
    total: 0,
    limit: null,
    official: null,
    groups: {},
    machines: 1,
    models: { "claude-opus": 10 },
    subLimits: { fable: 5 },
    archivedAt: start + WEEK,
    ...overrides,
  };
}

describe("ledgerEntryOf", () => {
  it("keeps everything but the models and the sub-limits", () => {
    const summary = cycle(1, { total: 100, official: 40, groups: { Work: 100 } });
    expect(ledgerEntryOf(summary)).toEqual({ ...summary, models: {}, subLimits: {} });
  });
});

describe("allTimeCycles", () => {
  it("lists every cycle once, oldest first, the archive's summary winning over the ledger's", () => {
    const ledger = [cycle(1, { total: 10 }), cycle(2, { total: 20, official: null })];
    const history = [cycle(3, { total: 30 }), cycle(2, { total: 20, official: 55 })];
    const merged = allTimeCycles(ledger, history);
    expect(merged.map((entry) => entry.start)).toEqual([WEEK, 2 * WEEK, 3 * WEEK]);
    expect(merged[1]?.official).toBe(55);
  });
});

describe("summarizeAllTime", () => {
  it("is null while no cycle used any tokens", () => {
    expect(summarizeAllTime([], null)).toBeNull();
    expect(summarizeAllTime([cycle(1)], cycle(2))).toBeNull();
  });

  it("adds up each group's tokens and cycles, heaviest first, with its share of all of them", () => {
    const summary = summarizeAllTime(
      [cycle(1, { total: 300, groups: { Work: 200, Home: 100 } }), cycle(2, { total: 100, groups: { Work: 100 } })],
      null,
    );
    expect(summary).toMatchObject({ sinceMs: WEEK, cycles: 2, total: 400, includesCurrent: false, quota: null });
    expect(summary?.groups).toEqual([
      { groupId: "Work", tokens: 300, share: 0.75, cycles: 2, quota: null },
      { groupId: "Home", tokens: 100, share: 0.25, cycles: 1, quota: null },
    ]);
  });

  it("adds up the quota parts of the cycles with a known final usage, and counts them", () => {
    const summary = summarizeAllTime(
      [
        // 80% official, split 3:1.
        cycle(1, { total: 400, official: 80, groups: { Work: 300, Home: 100 } }),
        // No official figure, but half of a 1000-token limit.
        cycle(2, { total: 500, limit: 1000, groups: { Work: 500 } }),
        // Neither: adds tokens, not quota.
        cycle(3, { total: 200, groups: { Home: 200 } }),
      ],
      null,
    );
    expect(summary?.quotaCycles).toBe(2);
    expect(summary?.quota).toBeCloseTo(1.3);
    const byId = Object.fromEntries((summary?.groups ?? []).map((group) => [group.groupId, group]));
    expect(byId.Work?.quota).toBeCloseTo(1.1);
    expect(byId.Home?.quota).toBeCloseTo(0.2);
  });

  it("leaves a group's quota null when no cycle it used tokens in has a known final usage", () => {
    const summary = summarizeAllTime(
      [cycle(1, { total: 100, official: 50, groups: { Work: 100 } }), cycle(2, { total: 50, groups: { Home: 50 } })],
      null,
    );
    const byId = Object.fromEntries((summary?.groups ?? []).map((group) => [group.groupId, group]));
    expect(byId.Home?.quota).toBeNull();
    expect(summary?.quota).toBeCloseTo(0.5);
  });

  it("splits a cycle with keep resets segment by segment", () => {
    const summary = summarizeAllTime(
      [
        cycle(1, {
          total: 200,
          official: 100,
          groups: { Work: 100, Home: 100 },
          segments: [
            { start: WEEK, end: WEEK + DAY, official: 60, total: 100, groups: { Work: 100 } },
            { start: WEEK + DAY, end: 2 * WEEK, official: 40, total: 100, groups: { Home: 100 } },
          ],
        }),
      ],
      null,
    );
    const byId = Object.fromEntries((summary?.groups ?? []).map((group) => [group.groupId, group]));
    expect(byId.Work?.quota).toBeCloseTo(0.6);
    expect(byId.Home?.quota).toBeCloseTo(0.4);
  });

  it("counts the current cycle so far, unless it is already archived or has no usage yet", () => {
    const archived = [cycle(1, { total: 100, groups: { Work: 100 } })];
    const current = cycle(2, { total: 50, groups: { Home: 50 } });
    expect(summarizeAllTime(archived, current)).toMatchObject({ cycles: 2, total: 150, includesCurrent: true });
    expect(summarizeAllTime([...archived, current], current)).toMatchObject({ cycles: 2, includesCurrent: false });
    expect(summarizeAllTime(archived, cycle(2))).toMatchObject({ cycles: 1, includesCurrent: false });
  });
});

describe("the all-time ledger in Redis", () => {
  useRedis();

  it("gets every archived cycle, without its models and sub-limits, and keeps the ones the history trims", async () => {
    for (let index = 1; index <= HISTORY_RETENTION + 3; index += 1) {
      await archiveCycle("claude", cycle(index, { total: index }));
    }
    expect((await loadHistory(["claude"])).claude).toHaveLength(HISTORY_RETENTION);
    const ledger = (await loadAllTime(["claude"])).claude ?? [];
    expect(ledger).toHaveLength(HISTORY_RETENTION + 3);
    expect(ledger.map((entry) => entry.total)).toEqual(
      Array.from({ length: HISTORY_RETENTION + 3 }, (_, index) => index + 1),
    );
    expect(ledger[0]).toEqual(ledgerEntryOf(cycle(1, { total: 1 })));
  });

  it("copies the summaries archived before the ledger existed, before the trim drops them", async () => {
    // A store from an older build: a full history, an empty ledger.
    for (let index = 1; index <= HISTORY_RETENTION; index += 1) {
      const summary = cycle(index, { total: index });
      await getRedis().zadd(KEYS.history("claude"), { score: summary.start, member: serializeCycleSummary(summary) });
    }
    await archiveCycle("claude", cycle(HISTORY_RETENTION + 1, { total: HISTORY_RETENTION + 1 }));
    expect((await loadAllTime(["claude"])).claude).toHaveLength(HISTORY_RETENTION + 1);
  });

  it("keeps an entry it already holds when the same cycle is archived again", async () => {
    await archiveCycle("claude", cycle(1, { total: 10 }));
    await getRedis().zremrangebyscore(KEYS.history("claude"), WEEK, WEEK);
    await archiveCycle("claude", cycle(1, { total: 99 }));
    expect((await loadAllTime(["claude"])).claude?.map((entry) => entry.total)).toEqual([10]);
  });

  it("follows a correction of the archived official figure", async () => {
    await archiveCycle("claude", cycle(1, { total: 10, official: 82 }));
    expect(await saveArchivedOfficial("claude", WEEK, 100)).toBe(true);
    expect((await loadAllTime(["claude"])).claude?.[0]?.official).toBe(100);
  });

  it("keeps every provider's ledger apart, and skips a damaged entry", async () => {
    await archiveCycle("claude", cycle(1, { total: 10 }));
    await archiveCycle("openai", cycle(2, { total: 20 }));
    await getRedis().hset(KEYS.allTime("claude"), { [String(5 * WEEK)]: "not json" });
    const ledgers = await loadAllTime(["claude", "openai", "gemini"]);
    expect(ledgers.claude?.map((entry) => entry.start)).toEqual([WEEK]);
    expect(ledgers.openai?.map((entry) => entry.start)).toEqual([2 * WEEK]);
    expect(ledgers.gemini).toEqual([]);
  });
});

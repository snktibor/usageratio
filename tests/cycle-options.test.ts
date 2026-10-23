import { describe, expect, it } from "vitest";
import { getConfig, type ResetConfig } from "@/lib/config";
import {
  listCycleOptions,
  parseCycleParam,
  periodOfCycle,
  providerCycleOptions,
  selectCycle,
} from "@/lib/cycle-options";
import type { ResetEvent } from "@/lib/resets";

const UTC_MONDAY: ResetConfig = { period: "weekly", weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" };
const ms = (iso: string) => new Date(iso).getTime();
// A Wednesday: the current weekly cycle began on Monday 2026-09-28.
const NOW = new Date("2026-09-30T12:00:00Z");
/** Reports stored since long before any of these cycles. */
const LONG_AGO = ms("2026-01-01T00:00:00Z");

describe("listCycleOptions", () => {
  it("offers the current cycle, then every earlier one inside the retention, newest first", () => {
    const options = listCycleOptions({
      now: NOW,
      reset: UTC_MONDAY,
      archived: [],
      retentionDays: 21,
      oldestReportMs: LONG_AGO,
    });
    expect(options.map((option) => [new Date(option.startMs).toISOString().slice(0, 10), option.kind])).toEqual([
      ["2026-09-28", "current"],
      ["2026-09-21", "detail"],
      ["2026-09-14", "detail"],
    ]);
    // 2026-09-07 starts 23.5 days back: its first reports are already gone.
    expect(options[1]).toMatchObject({ endMs: ms("2026-09-28T00:00:00Z"), archived: false });
  });

  it("keeps an archived cycle older than the retention, as a summary only", () => {
    const options = listCycleOptions({
      now: NOW,
      reset: UTC_MONDAY,
      archived: [{ start: ms("2026-08-31T00:00:00Z"), end: ms("2026-09-07T00:00:00Z") }],
      retentionDays: 21,
      oldestReportMs: LONG_AGO,
    });
    expect(options.at(-1)).toEqual({
      startMs: ms("2026-08-31T00:00:00Z"),
      endMs: ms("2026-09-07T00:00:00Z"),
      kind: "summary",
      archived: true,
    });
  });

  it("takes an archived cycle's own boundaries over the ones worked out from changed settings", () => {
    // The budget used to reset on Fridays at 15:00; it resets on Mondays at 00:00 now.
    const archived = [
      { start: ms("2026-09-19T15:00:00Z"), end: ms("2026-09-26T15:00:00Z") },
      { start: ms("2026-09-12T15:00:00Z"), end: ms("2026-09-19T15:00:00Z") },
    ];
    const options = listCycleOptions({
      now: NOW,
      reset: UTC_MONDAY,
      archived,
      retentionDays: 70,
      oldestReportMs: LONG_AGO,
    });
    const past = options.slice(1).map((option) => [new Date(option.startMs).toISOString(), option.archived]);

    // The worked-out 09-21, 09-14 and 09-07 cycles overlap the archived ones and go; 08-31 and earlier stay.
    expect(past.slice(0, 3)).toEqual([
      ["2026-09-19T15:00:00.000Z", true],
      ["2026-09-12T15:00:00.000Z", true],
      ["2026-08-31T00:00:00.000Z", false],
    ]);
    for (const [index, option] of options.entries()) {
      for (const other of options.slice(index + 1)) {
        expect(option.startMs < other.endMs && other.startMs < option.endMs).toBe(false);
      }
    }
  });

  it("offers only the cycles that still have reports: an older archived one as a summary, the rest not at all", () => {
    // Reporting began on 2026-09-17: the week of 09-14 has reports, the ones before it none.
    const options = listCycleOptions({
      now: NOW,
      reset: UTC_MONDAY,
      archived: [{ start: ms("2026-09-07T00:00:00Z"), end: ms("2026-09-14T00:00:00Z") }],
      retentionDays: 70,
      oldestReportMs: ms("2026-09-17T09:00:00Z"),
    });
    expect(options.map((option) => [new Date(option.startMs).toISOString().slice(0, 10), option.kind])).toEqual([
      ["2026-09-28", "current"],
      ["2026-09-21", "detail"],
      ["2026-09-14", "detail"],
      ["2026-09-07", "summary"],
    ]);
    expect(
      listCycleOptions({ now: NOW, reset: UTC_MONDAY, archived: [], retentionDays: 70, oldestReportMs: null }),
    ).toHaveLength(1);
  });

  it("lists a cycle archived by several providers once, and ignores one that is not in the past", () => {
    const entry = { start: ms("2026-09-21T00:00:00Z"), end: ms("2026-09-28T00:00:00Z") };
    const options = listCycleOptions({
      now: NOW,
      reset: UTC_MONDAY,
      archived: [entry, { ...entry }, { start: ms("2026-09-28T00:00:00Z"), end: ms("2026-10-05T00:00:00Z") }],
      retentionDays: 10,
      oldestReportMs: LONG_AGO,
    });
    expect(options.map((option) => option.startMs)).toEqual([ms("2026-09-28T00:00:00Z"), entry.start]);
    expect(options[1]!.archived).toBe(true);
  });

  it("follows a monthly reset back through months of different lengths", () => {
    const monthly: ResetConfig = { ...UTC_MONDAY, period: "monthly", monthDay: 31 };
    const options = listCycleOptions({
      now: NOW,
      reset: monthly,
      archived: [],
      retentionDays: 70,
      oldestReportMs: LONG_AGO,
    });
    // September has no 31st: its last day stands in, so the current cycle began this very morning.
    expect(options.map((option) => new Date(option.startMs).toISOString().slice(0, 10))).toEqual([
      "2026-09-30",
      "2026-08-31",
      "2026-07-31",
    ]);
  });
});

describe("selectCycle", () => {
  const options = listCycleOptions({
    now: NOW,
    reset: UTC_MONDAY,
    archived: [],
    retentionDays: 21,
    oldestReportMs: LONG_AGO,
  });

  it("picks the cycle a start names, with the one before it", () => {
    const selection = selectCycle(options, ms("2026-09-21T00:00:00Z"));
    expect(selection.selected.startMs).toBe(ms("2026-09-21T00:00:00Z"));
    expect(selection.previous?.startMs).toBe(ms("2026-09-14T00:00:00Z"));
    expect(selection.unknown).toBe(false);
  });

  it("falls back to the current cycle, and says so, for a start that names none", () => {
    expect(selectCycle(options, null)).toMatchObject({ selected: options[0], unknown: false });
    expect(selectCycle(options, ms("2026-09-22T00:00:00Z"))).toMatchObject({ selected: options[0], unknown: true });
  });

  it("gives the oldest cycle no previous one", () => {
    expect(selectCycle(options, options.at(-1)!.startMs).previous).toBeNull();
  });
});

describe("parseCycleParam", () => {
  it("reads epoch milliseconds only", () => {
    expect(parseCycleParam("1790467200000")).toBe(1_790_467_200_000);
    expect(parseCycleParam(["1790467200000", "1"])).toBe(1_790_467_200_000);
    for (const raw of [undefined, "", "-1", "1.5", "2026-09-21", "1e12", "9".repeat(16)]) {
      expect(parseCycleParam(raw)).toBeNull();
    }
  });
});

describe("periodOfCycle", () => {
  it("tells a week from a month by the cycle's own length", () => {
    expect(periodOfCycle({ startMs: ms("2026-09-21T00:00:00Z"), endMs: ms("2026-09-28T00:00:00Z") })).toBe("weekly");
    // A week across the autumn clock change is still a week.
    expect(periodOfCycle({ startMs: ms("2026-10-19T22:00:00Z"), endMs: ms("2026-10-26T23:00:00Z") })).toBe("weekly");
    expect(periodOfCycle({ startMs: ms("2026-02-01T00:00:00Z"), endMs: ms("2026-03-01T00:00:00Z") })).toBe("monthly");
  });
});

describe("providerCycleOptions", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const config = {
    ...getConfig(),
    reset: { period: "weekly" as const, weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
    resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
    retentionDays: 30,
  };

  it("lists the provider's own cycles", () => {
    const options = providerCycleOptions({
      now,
      config,
      providerId: "claude",
      history: [],
      oldestReportMs: Date.parse("2026-09-01T00:00:00Z"),
    });
    expect(options[0]).toMatchObject({ kind: "current", startMs: Date.parse("2026-09-17T09:00:00Z") });
    expect(options[1]).toMatchObject({ kind: "detail", startMs: Date.parse("2026-09-10T09:00:00Z") });
  });

  it("uses the shared reset for a provider without its own", () => {
    const options = providerCycleOptions({ now, config, providerId: "openai", history: [], oldestReportMs: null });
    expect(options[0]!.startMs).toBe(Date.parse("2026-09-21T00:00:00Z"));
  });
});

describe("providerCycleOptions with a restart", () => {
  it("offers the cycle the restart cut short, then older ones on the old schedule", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    const R = Date.parse("2026-09-22T14:00:00Z");
    const config = {
      ...getConfig({}),
      reset: { period: "weekly" as const, weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
      resetOverrides: { openai: { weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" as const } },
    };
    const restart: ResetEvent = {
      id: "r",
      atMs: R,
      kind: "restart",
      cycleStartMs: Date.parse("2026-09-21T00:00:00Z"),
      before: 90,
      beforeAtMs: null,
      source: "manual",
      recordedAtMs: R,
      previousOverride: null,
    };
    const options = providerCycleOptions({
      now,
      config,
      providerId: "openai",
      history: [],
      oldestReportMs: Date.parse("2026-09-01T00:00:00Z"),
      resets: [restart],
    });
    expect(
      options
        .slice(0, 3)
        .map((option) => [new Date(option.startMs).toISOString(), new Date(option.endMs).toISOString()]),
    ).toEqual([
      ["2026-09-22T14:00:00.000Z", "2026-09-29T14:00:00.000Z"],
      ["2026-09-21T00:00:00.000Z", "2026-09-22T14:00:00.000Z"],
      ["2026-09-14T00:00:00.000Z", "2026-09-21T00:00:00.000Z"],
    ]);
  });
});

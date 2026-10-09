import { describe, expect, it } from "vitest";
import type { ResetConfig } from "@/lib/config";
import { getCycle, getDaySegments, getPreviousCycle, wallClockOf } from "@/lib/cycle";

const HOUR = 3_600_000;

const BUDAPEST_MONDAY: ResetConfig = {
  period: "weekly",
  weekday: 1,
  monthDay: 1,
  hour: 0,
  minute: 0,
  timeZone: "Europe/Budapest",
};

const BUDAPEST_FIRST: ResetConfig = { ...BUDAPEST_MONDAY, period: "monthly" };

describe("getCycle", () => {
  it("starts at the most recent Monday 00:00 Budapest time in summer (UTC+2)", () => {
    const cycle = getCycle(new Date("2026-09-23T10:15:00Z"), BUDAPEST_MONDAY);
    expect(cycle.start.toISOString()).toBe("2026-09-20T22:00:00.000Z");
    expect(cycle.end.toISOString()).toBe("2026-09-27T22:00:00.000Z");
  });

  it("uses the winter offset (UTC+1) in January", () => {
    const cycle = getCycle(new Date("2026-01-14T12:00:00Z"), BUDAPEST_MONDAY);
    expect(cycle.start.toISOString()).toBe("2026-01-11T23:00:00.000Z");
    expect(cycle.end.toISOString()).toBe("2026-01-18T23:00:00.000Z");
  });

  it("puts the exact reset instant into the new cycle", () => {
    const cycle = getCycle(new Date("2026-09-20T22:00:00.000Z"), BUDAPEST_MONDAY);
    expect(cycle.start.toISOString()).toBe("2026-09-20T22:00:00.000Z");
  });

  it("keeps the last millisecond before the reset in the old cycle", () => {
    const cycle = getCycle(new Date("2026-09-20T21:59:59.999Z"), BUDAPEST_MONDAY);
    expect(cycle.start.toISOString()).toBe("2026-09-13T22:00:00.000Z");
    expect(cycle.end.toISOString()).toBe("2026-09-20T22:00:00.000Z");
  });

  it("is 167 hours long across the spring DST change", () => {
    const cycle = getCycle(new Date("2026-03-25T12:00:00Z"), BUDAPEST_MONDAY);
    expect(cycle.start.toISOString()).toBe("2026-03-22T23:00:00.000Z");
    expect(cycle.end.toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(cycle.end.getTime() - cycle.start.getTime()).toBe(167 * HOUR);
  });

  it("is 169 hours long across the autumn DST change", () => {
    const cycle = getCycle(new Date("2026-10-21T12:00:00Z"), BUDAPEST_MONDAY);
    expect(cycle.start.toISOString()).toBe("2026-10-18T22:00:00.000Z");
    expect(cycle.end.toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(cycle.end.getTime() - cycle.start.getTime()).toBe(169 * HOUR);
  });

  it("supports a reset in the middle of a day", () => {
    const thursday: ResetConfig = { ...BUDAPEST_MONDAY, weekday: 4, hour: 14, minute: 37 };

    const before = getCycle(new Date("2026-09-24T12:36:59Z"), thursday);
    expect(before.start.toISOString()).toBe("2026-09-17T12:37:00.000Z");
    expect(before.end.toISOString()).toBe("2026-09-24T12:37:00.000Z");

    const after = getCycle(new Date("2026-09-24T12:37:00Z"), thursday);
    expect(after.start.toISOString()).toBe("2026-09-24T12:37:00.000Z");
  });

  it("works when the local date differs from the UTC date", () => {
    const auckland: ResetConfig = { ...BUDAPEST_MONDAY, timeZone: "Pacific/Auckland" };
    // 2026-09-20 13:00 UTC is already Monday 01:00 in Auckland (UTC+12).
    const cycle = getCycle(new Date("2026-09-20T13:00:00Z"), auckland);
    expect(cycle.start.toISOString()).toBe("2026-09-20T12:00:00.000Z");
  });

  it("resolves a reset time skipped or repeated by DST deterministically", () => {
    const sundayNight: ResetConfig = { ...BUDAPEST_MONDAY, weekday: 0, hour: 2, minute: 30 };
    // 02:30 does not exist on 2026-03-29 (clocks jump 02:00 → 03:00): use 03:30 CEST.
    const spring = getCycle(new Date("2026-03-29T12:00:00Z"), sundayNight);
    expect(spring.start.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    // 02:30 happens twice on 2026-10-25: use the later one (CET).
    const autumn = getCycle(new Date("2026-10-25T12:00:00Z"), sundayNight);
    expect(autumn.start.toISOString()).toBe("2026-10-25T01:30:00.000Z");
  });

  it("always contains `now`", () => {
    const configs: ResetConfig[] = [
      BUDAPEST_MONDAY,
      { ...BUDAPEST_MONDAY, weekday: 0, hour: 2, minute: 30 }, // inside the DST gap/overlap hour
      { ...BUDAPEST_MONDAY, weekday: 6, hour: 23, minute: 59, timeZone: "America/New_York" },
      { ...BUDAPEST_MONDAY, weekday: 3, hour: 12, minute: 0, timeZone: "UTC" },
    ];
    for (const config of configs) {
      for (let day = 0; day < 370; day += 1) {
        const now = new Date(Date.UTC(2026, 0, 1, 1, 17) + day * 24 * HOUR + day * 37 * 60_000);
        const cycle = getCycle(now, config);
        expect(cycle.start.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(cycle.end.getTime()).toBeGreaterThan(now.getTime());
        const hours = (cycle.end.getTime() - cycle.start.getTime()) / HOUR;
        expect(hours).toBeGreaterThanOrEqual(167);
        expect(hours).toBeLessThanOrEqual(169);
      }
    }
  });
});

describe("getCycle — monthly", () => {
  it("runs from the 1st to the 1st", () => {
    const cycle = getCycle(new Date("2026-09-23T10:15:00Z"), BUDAPEST_FIRST);
    expect(cycle.start.toISOString()).toBe("2026-08-31T22:00:00.000Z");
    expect(cycle.end.toISOString()).toBe("2026-09-30T22:00:00.000Z");
  });

  it("ignores the weekday of a monthly budget, and the month day of a weekly one", () => {
    const now = new Date("2026-09-23T10:15:00Z");
    expect(getCycle(now, { ...BUDAPEST_FIRST, weekday: 5 })).toEqual(getCycle(now, BUDAPEST_FIRST));
    expect(getCycle(now, { ...BUDAPEST_MONDAY, monthDay: 17 })).toEqual(getCycle(now, BUDAPEST_MONDAY));
  });

  it("supports a reset in the middle of a month and of a day", () => {
    const fifteenth: ResetConfig = { ...BUDAPEST_FIRST, monthDay: 15, hour: 9, minute: 30 };

    const before = getCycle(new Date("2026-09-15T07:29:59.999Z"), fifteenth);
    expect(before.start.toISOString()).toBe("2026-08-15T07:30:00.000Z");
    expect(before.end.toISOString()).toBe("2026-09-15T07:30:00.000Z");

    const after = getCycle(new Date("2026-09-15T07:30:00Z"), fifteenth);
    expect(after.start.toISOString()).toBe("2026-09-15T07:30:00.000Z");
    expect(after.end.toISOString()).toBe("2026-10-15T07:30:00.000Z");
  });

  it("resets on the last day of a month that lacks the reset day", () => {
    const thirtyFirst: ResetConfig = { ...BUDAPEST_FIRST, monthDay: 31 };

    const january = getCycle(new Date("2026-02-15T12:00:00Z"), thirtyFirst);
    expect(january.start.toISOString()).toBe("2026-01-30T23:00:00.000Z");
    expect(january.end.toISOString()).toBe("2026-02-27T23:00:00.000Z"); // February 28

    // The next one ends on March 31, after the clocks went forward.
    const february = getCycle(new Date("2026-02-28T12:00:00Z"), thirtyFirst);
    expect(february.start.toISOString()).toBe("2026-02-27T23:00:00.000Z");
    expect(february.end.toISOString()).toBe("2026-03-30T22:00:00.000Z");

    const april = getCycle(new Date("2026-04-30T12:00:00Z"), thirtyFirst);
    expect(april.start.toISOString()).toBe("2026-04-29T22:00:00.000Z"); // April 30
    expect(april.end.toISOString()).toBe("2026-05-30T22:00:00.000Z");
  });

  it("knows leap years", () => {
    const thirtieth: ResetConfig = { ...BUDAPEST_FIRST, monthDay: 30 };
    const cycle = getCycle(new Date("2028-02-29T12:00:00Z"), thirtieth);
    expect(cycle.start.toISOString()).toBe("2028-02-28T23:00:00.000Z"); // February 29
  });

  it("crosses the year boundary in both directions", () => {
    const twentieth: ResetConfig = { ...BUDAPEST_FIRST, monthDay: 20 };

    const january = getCycle(new Date("2026-01-05T12:00:00Z"), twentieth);
    expect(january.start.toISOString()).toBe("2025-12-19T23:00:00.000Z");
    expect(january.end.toISOString()).toBe("2026-01-19T23:00:00.000Z");

    const december = getCycle(new Date("2026-12-25T12:00:00Z"), twentieth);
    expect(december.start.toISOString()).toBe("2026-12-19T23:00:00.000Z");
    expect(december.end.toISOString()).toBe("2027-01-19T23:00:00.000Z");
  });

  it("always contains `now`, and is always one month long", () => {
    const configs: ResetConfig[] = [
      BUDAPEST_FIRST,
      { ...BUDAPEST_FIRST, monthDay: 31, hour: 23, minute: 59 },
      { ...BUDAPEST_FIRST, monthDay: 29, hour: 2, minute: 30 }, // March 29 02:30 falls into the DST gap
      { ...BUDAPEST_FIRST, monthDay: 15, hour: 12, timeZone: "America/New_York" },
      { ...BUDAPEST_FIRST, monthDay: 30, timeZone: "UTC" },
    ];
    for (const config of configs) {
      for (let day = 0; day < 800; day += 1) {
        const now = new Date(Date.UTC(2026, 0, 1, 1, 17) + day * 24 * HOUR + day * 37 * 60_000);
        const cycle = getCycle(now, config);
        expect(cycle.start.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(cycle.end.getTime()).toBeGreaterThan(now.getTime());
        const hours = (cycle.end.getTime() - cycle.start.getTime()) / HOUR;
        expect(hours).toBeGreaterThanOrEqual(28 * 24 - 1);
        expect(hours).toBeLessThanOrEqual(31 * 24 + 1);
        // Consecutive cycles tile time without gaps or overlaps.
        expect(getCycle(cycle.end, config).start.getTime()).toBe(cycle.end.getTime());
      }
    }
  });
});

describe("getPreviousCycle", () => {
  it("ends where the current cycle starts", () => {
    const cycle = getCycle(new Date("2026-09-23T10:15:00Z"), BUDAPEST_MONDAY);
    const previous = getPreviousCycle(cycle, BUDAPEST_MONDAY);
    expect(previous.start.toISOString()).toBe("2026-09-13T22:00:00.000Z");
    expect(previous.end.toISOString()).toBe(cycle.start.toISOString());
  });

  it("is the month before for a monthly budget", () => {
    const cycle = getCycle(new Date("2026-09-23T10:15:00Z"), BUDAPEST_FIRST);
    const previous = getPreviousCycle(cycle, BUDAPEST_FIRST);
    expect(previous.start.toISOString()).toBe("2026-07-31T22:00:00.000Z");
    expect(previous.end.toISOString()).toBe(cycle.start.toISOString());
  });
});

describe("getDaySegments", () => {
  it("splits a Monday-midnight cycle into seven whole days", () => {
    const cycle = getCycle(new Date("2026-09-23T10:15:00Z"), BUDAPEST_MONDAY);
    const segments = getDaySegments(cycle, BUDAPEST_MONDAY.timeZone);
    expect(segments.map((s) => s.weekday)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(segments[0]?.start.toISOString()).toBe(cycle.start.toISOString());
    expect(segments[6]?.end.toISOString()).toBe(cycle.end.toISOString());
    for (const segment of segments) {
      expect(segment.end.getTime() - segment.start.getTime()).toBe(24 * HOUR);
    }
  });

  it("splits a mid-day cycle into eight pieces with partial first and last days", () => {
    const thursday: ResetConfig = { ...BUDAPEST_MONDAY, weekday: 4, hour: 14, minute: 37 };
    const cycle = getCycle(new Date("2026-09-25T08:00:00Z"), thursday);
    const segments = getDaySegments(cycle, thursday.timeZone);
    expect(segments.map((s) => s.weekday)).toEqual([4, 5, 6, 0, 1, 2, 3, 4]);
    // First piece: Thursday 14:37 → midnight; last piece: midnight → Thursday 14:37.
    expect(segments[0]!.end.getTime() - segments[0]!.start.getTime()).toBe(9 * HOUR + 23 * 60_000);
    expect(segments[7]!.end.getTime() - segments[7]!.start.getTime()).toBe(14 * HOUR + 37 * 60_000);
    // The pieces tile the cycle without gaps.
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.start.getTime()).toBe(segments[i - 1]!.end.getTime());
    }
  });

  it("keeps a 25-hour day in one piece on the autumn DST change", () => {
    const cycle = getCycle(new Date("2026-10-21T12:00:00Z"), BUDAPEST_MONDAY);
    const segments = getDaySegments(cycle, BUDAPEST_MONDAY.timeZone);
    expect(segments).toHaveLength(7);
    expect(segments[6]!.end.getTime() - segments[6]!.start.getTime()).toBe(25 * HOUR);
  });

  it("names the day of the month of every piece", () => {
    const cycle = getCycle(new Date("2026-09-23T10:15:00Z"), BUDAPEST_MONDAY);
    const segments = getDaySegments(cycle, BUDAPEST_MONDAY.timeZone);
    expect(segments.map((s) => s.monthDay)).toEqual([21, 22, 23, 24, 25, 26, 27]);
  });

  it("splits a calendar month into its days", () => {
    const cycle = getCycle(new Date("2026-09-23T10:15:00Z"), BUDAPEST_FIRST);
    const segments = getDaySegments(cycle, BUDAPEST_FIRST.timeZone);
    expect(segments.map((s) => s.monthDay)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(segments[0]?.weekday).toBe(2); // 2026-09-01 is a Tuesday
    expect(segments[0]?.start.toISOString()).toBe(cycle.start.toISOString());
    expect(segments[29]?.end.toISOString()).toBe(cycle.end.toISOString());
  });

  it("splits a month that resets mid-day into 32 pieces, across the month's end", () => {
    const fifteenth: ResetConfig = { ...BUDAPEST_FIRST, monthDay: 15, hour: 9, minute: 30 };
    // August 15 09:30 → September 15 09:30: 31 days, touching 32 calendar days.
    const cycle = getCycle(new Date("2026-09-01T12:00:00Z"), fifteenth);
    const segments = getDaySegments(cycle, fifteenth.timeZone);
    expect(segments.map((s) => s.monthDay)).toEqual([
      ...Array.from({ length: 17 }, (_, i) => i + 15),
      ...Array.from({ length: 15 }, (_, i) => i + 1),
    ]);
    expect(segments[0]!.end.getTime() - segments[0]!.start.getTime()).toBe(14 * HOUR + 30 * 60_000);
    expect(segments[31]!.end.getTime() - segments[31]!.start.getTime()).toBe(9 * HOUR + 30 * 60_000);
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]!.start.getTime()).toBe(segments[i - 1]!.end.getTime());
    }
  });
});

describe("wallClockOf", () => {
  it("reads the wall clock in a time zone", () => {
    expect(wallClockOf(new Date("2026-09-24T07:00:00Z"), "Europe/Budapest")).toEqual({
      weekday: 4,
      day: 24,
      hour: 9,
      minute: 0,
    });
  });
});

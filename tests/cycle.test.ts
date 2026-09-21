import { describe, expect, it } from "vitest";
import { getCycle, getDaySegments, getPreviousCycle } from "@/lib/cycle";
import type { ResetConfig } from "@/lib/config";

const HOUR = 3_600_000;

const BUDAPEST_MONDAY: ResetConfig = {
  weekday: 1,
  hour: 0,
  minute: 0,
  timeZone: "Europe/Budapest",
};

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
      { weekday: 0, hour: 2, minute: 30, timeZone: "Europe/Budapest" }, // inside the DST gap/overlap hour
      { weekday: 6, hour: 23, minute: 59, timeZone: "America/New_York" },
      { weekday: 3, hour: 12, minute: 0, timeZone: "UTC" },
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

describe("getPreviousCycle", () => {
  it("ends where the current cycle starts", () => {
    const cycle = getCycle(new Date("2026-09-23T10:15:00Z"), BUDAPEST_MONDAY);
    const previous = getPreviousCycle(cycle, BUDAPEST_MONDAY);
    expect(previous.start.toISOString()).toBe("2026-09-13T22:00:00.000Z");
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
});

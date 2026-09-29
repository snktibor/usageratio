import { describe, expect, it } from "vitest";
import {
  clampWindow,
  formatPercentTick,
  formatTokenTick,
  MIN_ZOOM_MS,
  niceRange,
  niceScale,
  presetOf,
  presetWindow,
  tableSamples,
  visibleSamples,
  zoomTicks,
} from "@/lib/chart";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("niceScale", () => {
  it("rounds the axis up to a whole number of round steps", () => {
    const scale = niceScale(0.175, 0.1);
    expect(scale.step).toBeCloseTo(0.05, 12);
    expect(scale.max).toBeCloseTo(0.2, 12);
    expect(scale.ticks).toHaveLength(5);
  });

  it("keeps the minimum axis for small or no values", () => {
    const scale = niceScale(0, 0.1);
    expect(scale.max).toBeCloseTo(0.1, 12);
    expect(scale.step).toBeCloseTo(0.025, 12);
  });

  it("scales token counts", () => {
    expect(niceScale(1_234_567, 1_000)).toEqual({
      min: 0,
      max: 1_500_000,
      step: 500_000,
      ticks: [0, 500_000, 1_000_000, 1_500_000],
    });
  });
});

describe("tick text", () => {
  it("shows a decimal only where the step needs one, in Hungarian", () => {
    expect(formatPercentTick(0.05, 0.025, "hu")).toBe("5%");
    expect(formatPercentTick(0.075, 0.025, "hu")).toBe("7,5%");
    expect(formatPercentTick(0.2, 0.05, "hu")).toBe("20%");
  });

  it("shows a decimal only where the step needs one, in English", () => {
    expect(formatPercentTick(0.05, 0.025, "en")).toBe("5%");
    expect(formatPercentTick(0.075, 0.025, "en")).toBe("7.5%");
    expect(formatPercentTick(0.2, 0.05, "en")).toBe("20%");
  });

  it("abbreviates token counts the Hungarian way", () => {
    expect(formatTokenTick(1_200_000, "hu").replace(/\s/g, " ")).toBe("1,2 M");
    expect(formatTokenTick(250_000, "hu").replace(/\s/g, " ")).toBe("250 E");
  });

  it("abbreviates token counts the English way", () => {
    expect(formatTokenTick(1_200_000, "en")).toBe("1.2M");
    expect(formatTokenTick(250_000, "en")).toBe("250K");
  });
});

describe("niceRange", () => {
  it("starts below the data rather than at 0, on a round step", () => {
    const scale = niceRange(0.52, 0.61, 0.01);
    expect(scale.step).toBeCloseTo(0.025, 12);
    expect(scale.min).toBeCloseTo(0.5, 12);
    expect(scale.max).toBeCloseTo(0.625, 12);
    expect(scale.ticks).toEqual([0.5, 0.525, 0.55, 0.575, 0.6, 0.625]);
  });

  it("never goes below 0, and keeps a flat line off the edges", () => {
    expect(niceRange(0, 40_000, 100).min).toBe(0);
    const flat = niceRange(5_000, 5_000, 1_000);
    expect(flat.min).toBeLessThanOrEqual(5_000);
    expect(flat.max).toBeGreaterThan(5_000);
  });
});

describe("zoom window", () => {
  // A week from Monday 00:00 UTC; "now" on Wednesday 12:00.
  const CYCLE = { startMs: Date.parse("2026-09-21T00:00:00Z"), endMs: Date.parse("2026-09-28T00:00:00Z") };
  const NOW = CYCLE.startMs + 2.5 * DAY;

  it("shows the last day or three up to now, or the whole cycle", () => {
    expect(presetWindow("day", CYCLE, NOW)).toEqual({ startMs: NOW - DAY, endMs: NOW });
    expect(presetWindow("threeDays", CYCLE, CYCLE.endMs)).toEqual({
      startMs: CYCLE.endMs - 3 * DAY,
      endMs: CYCLE.endMs,
    });
    expect(presetWindow("cycle", CYCLE, NOW)).toEqual(CYCLE);
  });

  it("shows the first days of the cycle while less than that is behind it", () => {
    expect(presetWindow("threeDays", CYCLE, NOW)).toEqual({ startMs: CYCLE.startMs, endMs: CYCLE.startMs + 3 * DAY });
    expect(presetWindow("day", CYCLE, CYCLE.startMs + 5 * HOUR)).toEqual({
      startMs: CYCLE.startMs,
      endMs: CYCLE.startMs + DAY,
    });
  });

  it("tells which button a window belongs to, and none for a dragged one", () => {
    expect(presetOf(presetWindow("day", CYCLE, NOW), CYCLE, NOW)).toBe("day");
    expect(presetOf(CYCLE, CYCLE, NOW)).toBe("cycle");
    expect(presetOf({ startMs: NOW - 5 * HOUR, endMs: NOW }, CYCLE, NOW)).toBeNull();
  });

  it("keeps a dragged window inside the cycle, the right way round, and not too narrow", () => {
    expect(clampWindow({ startMs: NOW, endMs: NOW - 5 * HOUR }, CYCLE)).toEqual({
      startMs: NOW - 5 * HOUR,
      endMs: NOW,
    });
    expect(clampWindow({ startMs: CYCLE.startMs - DAY, endMs: CYCLE.startMs + HOUR * 30 }, CYCLE)).toEqual({
      startMs: CYCLE.startMs,
      endMs: CYCLE.startMs + 30 * HOUR,
    });
    const narrow = clampWindow({ startMs: NOW, endMs: NOW + 60_000 }, CYCLE);
    expect(narrow.endMs - narrow.startMs).toBe(MIN_ZOOM_MS);
    expect(narrow.startMs).toBeLessThanOrEqual(NOW);
    const atEnd = clampWindow({ startMs: CYCLE.endMs - 60_000, endMs: CYCLE.endMs }, CYCLE);
    expect(atEnd).toEqual({ startMs: CYCLE.endMs - MIN_ZOOM_MS, endMs: CYCLE.endMs });
  });
});

describe("visibleSamples", () => {
  // A month of hourly samples.
  const START = Date.parse("2026-09-01T00:00:00Z");
  const times = Array.from({ length: 30 * 24 + 1 }, (_, index) => START + index * HOUR);

  it("thins a whole month out to at most about 200 samples, keeping the last one", () => {
    const { inside, drawn } = visibleSamples(times, { startMs: START, endMs: times.at(-1)! });
    expect(inside.length).toBeLessThanOrEqual(200);
    expect(inside.at(-1)).toBe(times.length - 1);
    // Every fourth hour: the same density a month had before zooming existed.
    expect(times[inside[1]!]! - times[inside[0]!]!).toBe(4 * HOUR);
    expect(drawn).toEqual(inside);
  });

  it("shows every hour of a zoomed-in day, plus a neighbour beyond each edge for the lines", () => {
    const window = { startMs: START + 10 * DAY + 30 * 60_000, endMs: START + 11 * DAY };
    const { inside, drawn } = visibleSamples(times, window);
    expect(inside.map((index) => (times[index]! - START) / HOUR)).toEqual(
      Array.from({ length: 24 }, (_, hour) => 241 + hour),
    );
    expect(drawn[0]).toBe(240);
    expect(drawn.at(-1)).toBe(265);
  });

  it("lists every visible sample in the table up to three days, one row a day beyond that", () => {
    const threeDays = { startMs: START, endMs: START + 3 * DAY };
    const short = visibleSamples(times, threeDays);
    expect(tableSamples(times, short.inside, threeDays, [])).toEqual(short.inside);

    const week = { startMs: START, endMs: START + 7 * DAY - HOUR };
    const long = visibleSamples(times, week);
    const dayEnds = Array.from({ length: 30 }, (_, day) => START + (day + 1) * DAY);
    const rows = tableSamples(times, long.inside, week, dayEnds);
    expect(rows.map((index) => (times[index]! - START) / HOUR)).toEqual([24, 48, 72, 96, 120, 144, 167]);
  });
});

describe("zoomTicks", () => {
  it("labels whole local hours at a step that fits, and a midnight by its date", () => {
    const ticks = zoomTicks(
      { startMs: Date.parse("2026-09-22T09:30:00Z"), endMs: Date.parse("2026-09-23T09:30:00Z") },
      "Europe/Budapest",
    );
    // Budapest is UTC+2: every third local hour from 12:00 to 09:00 the next day.
    expect(ticks.map((tick) => new Date(tick.ms).toISOString().slice(11, 16))).toEqual([
      "10:00",
      "13:00",
      "16:00",
      "19:00",
      "22:00",
      "01:00",
      "04:00",
      "07:00",
    ]);
    expect(ticks.filter((tick) => tick.midnight).map((tick) => new Date(tick.ms).toISOString())).toEqual([
      "2026-09-22T22:00:00.000Z",
    ]);
  });

  it("follows a zone offset by half an hour", () => {
    const ticks = zoomTicks(
      { startMs: Date.parse("2026-09-22T00:00:00Z"), endMs: Date.parse("2026-09-22T06:00:00Z") },
      "Asia/Kolkata",
    );
    expect(ticks.every((tick) => new Date(tick.ms).getUTCMinutes() === 30)).toBe(true);
  });

  it("keeps to local midnights over a long window, thinned to fit", () => {
    const ticks = zoomTicks(
      { startMs: Date.parse("2026-09-01T00:00:00Z"), endMs: Date.parse("2026-09-21T00:00:00Z") },
      "UTC",
    );
    expect(ticks.every((tick) => tick.midnight)).toBe(true);
    expect(ticks.length).toBeLessThanOrEqual(8);
  });

  it("stays on the local clock across the autumn clock change", () => {
    const ticks = zoomTicks(
      { startMs: Date.parse("2026-10-24T22:00:00Z"), endMs: Date.parse("2026-10-25T22:00:00Z") },
      "Europe/Budapest",
      30,
    );
    // 25 hours that day: 00:00 CEST … 23:00 CET, each hour once and 02:00 twice; one midnight, the first.
    expect(ticks).toHaveLength(25);
    expect(ticks.filter((tick) => tick.midnight).map((tick) => tick.ms)).toEqual([Date.parse("2026-10-24T22:00:00Z")]);
  });
});

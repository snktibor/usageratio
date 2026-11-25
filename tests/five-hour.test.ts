import { describe, expect, it } from "vitest";
import { FIVE_HOUR_MS, fiveHourReadings, fiveHourView, parseStoredFiveHour, serializeFiveHour } from "@/lib/five-hour";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-25T12:00:00Z");
const reading = (usedPercent: number, resetsInMs: number, readAgoMs = 0) => ({
  usedPercent,
  resetsAtMs: NOW + resetsInMs,
  observedAtMs: NOW - readAgoMs,
});

describe("fiveHourView", () => {
  it("carries the window's pace on in a straight line", () => {
    // Two of the five hours gone, half of it used: at that pace it is gone two hours from now.
    const view = fiveHourView(reading(50, 3 * HOUR), NOW);
    expect(view.usedFraction).toBe(0.5);
    expect(view.elapsedFraction).toBeCloseTo(0.4);
    expect(view.outlook).toEqual({ kind: "runs_out", atMs: NOW + 2 * HOUR });
    expect(view.runOutFraction).toBeCloseTo(0.8);

    // A third of it in two hours lasts the five.
    expect(fiveHourView(reading(30, 3 * HOUR), NOW)).toMatchObject({
      outlook: { kind: "lasts" },
      runOutFraction: null,
    });
    expect(fiveHourView(reading(0, 3 * HOUR), NOW).outlook).toEqual({ kind: "lasts" });
  });

  it("takes the pace from when the figure was read, and the elapsed time from now", () => {
    // Read an hour ago, one hour into the window, at 25%: it runs out four hours in, a reset's hour early.
    const view = fiveHourView(reading(25, 3 * HOUR, HOUR), NOW);
    expect(view.elapsedFraction).toBeCloseTo(0.4);
    expect(view.outlook).toEqual({ kind: "runs_out", atMs: NOW + 2 * HOUR });
  });

  it("says when there is no pace to tell", () => {
    // Five minutes in: a single request would set the pace.
    expect(fiveHourView(reading(8, FIVE_HOUR_MS - 5 * 60_000), NOW).outlook).toEqual({ kind: "too_early" });
    expect(fiveHourView(reading(100, HOUR), NOW).outlook).toEqual({ kind: "used_up" });
    // Its reset has passed: nothing is used until a request opens a new one.
    expect(fiveHourView(reading(70, -60_000, 2 * HOUR), NOW)).toEqual({
      usedFraction: 0,
      elapsedFraction: 0,
      resetsAtMs: null,
      observedAtMs: NOW - 2 * HOUR,
      outlook: { kind: "idle" },
      runOutFraction: null,
    });
  });
});

describe("stored readings", () => {
  it("round-trips, and leaves out a field that does not hold up", () => {
    const stored = reading(62.5, 2 * HOUR);
    expect(parseStoredFiveHour(serializeFiveHour(stored))).toEqual(stored);
    expect(
      fiveHourReadings({ claude: serializeFiveHour(stored), openai: "{", deepseek: '{"p":"1","r":1,"o":1}' }),
    ).toEqual({
      claude: stored,
    });
  });
});

import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import { applyGroundTruth } from "@/lib/ground-truth";
import { recentPace } from "@/lib/recent-pace";

const HOUR = 3_600_000;
// Fixed to Budapest time, independent of DEFAULT_RESET's own (deploy-time) default.
const config = {
  ...getConfig({}),
  useTokenLimits: true,
  limit: 1_000_000,
  tokenMode: "delta" as const,
  reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
};

// The weekly cycle started Monday 00:00 Budapest time; hour 60 is Wednesday 12:00, 108 h before its end.
const CYCLE_START = Date.parse("2026-09-20T22:00:00Z");
const at = (hour: number) => CYCLE_START + hour * HOUR;

type Event = { machineId: string; groupId: string; tokens: number; ts: number };
const event = (tokens: number, ts: number): Event => ({ machineId: "mac", groupId: "Personal", tokens, ts });

/** 200k early in the cycle: what the cycle's average stands on. */
const BASE = event(200_000, at(10));

/** One report per hour, the last at hour `endHour`: a report at hour h carries the hour before it. */
function hourly(tokens: number[], endHour = 60): Event[] {
  return tokens.map((amount, index) => event(amount, at(endHour - tokens.length + 1 + index)));
}

function paceOf(
  events: Event[],
  { nowHour = 60, reading = null, limits = true }: { nowHour?: number; reading?: number | null; limits?: boolean } = {},
) {
  const model = buildDashboard(
    new Date(at(nowHour)),
    { ...config, useTokenLimits: limits },
    { events, groups: [], machines: [] },
  );
  const view = applyGroundTruth(model, reading === null ? null : { percent: reading, atMs: null });
  return { model, view, recent: recentPace(model, view) };
}

const BURST = [BASE, ...hourly([5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 40_000, 40_000])];

describe("recentPace — the change point", () => {
  it("finds a burst of the last two hours and projects it", () => {
    const { recent } = paceOf(BURST);
    expect(recent).toMatchObject({ sinceMs: at(58), untilMs: at(60), changed: true });
    expect(recent!.ratio).toBeCloseTo(40_000 / (310_000 / 60), 6);
    // 690k left at 40k an hour.
    expect(recent!.runOutAt).toBe(at(60 + 17.25));
  });

  it("finds a slowdown: nothing used since it", () => {
    const { recent } = paceOf([BASE, ...hourly([30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 0, 0])]);
    expect(recent).toEqual({ sinceMs: at(58), untilMs: at(60), changed: true, ratio: 0, runOutAt: null });
  });

  it("takes steady use as one pace over the whole window", () => {
    const { recent } = paceOf([BASE, ...hourly(Array(8).fill(10_000))]);
    expect(recent).toMatchObject({ sinceMs: at(52), untilMs: at(60), changed: false });
    expect(recent!.ratio).toBeCloseTo(10_000 / (280_000 / 60), 6);
    expect(recent!.runOutAt).toBe(at(60 + 72));
  });

  it("does not call noise within 1.5× a change", () => {
    const { recent } = paceOf([BASE, ...hourly([10_000, 12_000, 10_000, 12_000, 10_000, 12_000, 14_000, 12_000])]);
    expect(recent).toMatchObject({ sinceMs: at(52), changed: false });
  });

  it("says nothing runs out while the current pace lasts until the reset", () => {
    const { recent } = paceOf([BASE, ...hourly(Array(8).fill(1_000))]);
    expect(recent).toMatchObject({ changed: false, runOutAt: null });
    expect(recent!.ratio).toBeGreaterThan(0);
  });

  it("joins a report a few seconds past the hour to the hour it carries", () => {
    const { recent } = paceOf(
      [BASE, ...hourly([5_000, 5_000, 5_000, 5_000, 5_000, 5_000], 59), event(40_000, at(60) + 4_000)],
      { nowHour: 60 + 1 / 3 },
    );
    expect(recent).toMatchObject({ sinceMs: at(59), untilMs: at(60) + 4_000, changed: true });
  });
});

describe("recentPace — the window", () => {
  it("starts no earlier than the cycle", () => {
    const { recent } = paceOf(hourly([10_000, 10_000, 10_000], 3), { nowHour: 3 });
    expect(recent).toMatchObject({ sinceMs: CYCLE_START, untilMs: at(3), changed: false });
  });

  it("needs at least an hour of data", () => {
    expect(paceOf([event(10_000, at(0.5))], { nowHour: 0.5 }).recent).toBeNull();
  });

  it("ends at the newest report, and is not stated once every machine has been silent over 2 hours", () => {
    expect(paceOf([BASE, ...hourly(Array(8).fill(10_000), 58)]).recent).toMatchObject({ untilMs: at(58) });
    expect(paceOf([BASE, ...hourly(Array(8).fill(10_000), 57)]).recent).toBeNull();
  });
});

describe("recentPace — the budget figure", () => {
  it("restates the measured tokens by an official reading, with the token limits on", () => {
    // 62% of 1M is 620k against 310k measured: every measured token counts twice.
    const { recent } = paceOf(BURST, { reading: 62 });
    expect(recent!.ratio).toBeCloseTo(40_000 / (310_000 / 60), 6);
    // 380k left at 80k an hour.
    expect(recent!.runOutAt).toBe(at(60 + 4.75));
  });

  it("restates them as fractions of the budget without token limits", () => {
    const { recent } = paceOf(BURST, { reading: 31, limits: false });
    // 69% left at 4% an hour.
    expect(Math.abs(recent!.runOutAt! - at(60 + 17.25))).toBeLessThan(1_000);
  });

  it("states nothing without a figure, without usage, past the limit, or for a closed cycle", () => {
    expect(paceOf(BURST, { limits: false }).recent).toBeNull();
    expect(paceOf([]).recent).toBeNull();
    expect(paceOf([event(1_000_000, at(10)), ...hourly(Array(8).fill(10_000))]).recent).toBeNull();
    const { model, view } = paceOf(BURST);
    expect(recentPace({ ...model, closed: true }, view)).toBeNull();
  });
});

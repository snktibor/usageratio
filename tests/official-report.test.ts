import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { decideOfficialReport, parseOfficialReport } from "@/lib/official-report";

// Wednesday 2026-09-23 12:00 UTC; shared reset Monday 00:00 UTC.
const NOW = new Date("2026-09-23T12:00:00Z");
const base = {
  ...getConfig(),
  reset: { period: "weekly" as const, weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
  resetOverrides: {},
};
const report = (overrides: Partial<Record<string, unknown>> = {}) => ({
  providerId: "claude",
  usedPercent: 41.24,
  resetsAtMs: Date.parse("2026-09-24T09:00:00Z"),
  observedAtMs: Date.parse("2026-09-23T11:50:00Z"),
  ...overrides,
});
const parsed = (overrides = {}) => {
  const result = parseOfficialReport(report(overrides), NOW);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.report;
};

describe("parseOfficialReport", () => {
  it("accepts a well-formed report", () => {
    expect(parsed()).toEqual(report());
  });

  it("rejects bad fields", () => {
    const result = parseOfficialReport(
      { providerId: "!!", usedPercent: -1, resetsAtMs: "x", observedAtMs: NOW.getTime() + 10 * 60_000 },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(4);
  });

  it("rejects a window that resets before the reading or more than a week after it", () => {
    expect(parseOfficialReport(report({ resetsAtMs: Date.parse("2026-09-23T11:00:00Z") }), NOW).ok).toBe(false);
    expect(parseOfficialReport(report({ resetsAtMs: Date.parse("2026-10-01T12:00:00Z") }), NOW).ok).toBe(false);
  });
});

describe("decideOfficialReport", () => {
  it("refuses a monthly dashboard", () => {
    const monthly = { ...base, reset: { ...base.reset, period: "monthly" as const } };
    expect(decideOfficialReport(parsed(), monthly, NOW, null, null)).toEqual({ kind: "period_not_weekly" });
  });

  it("moves the provider's reset to the window's, and saves for the new cycle", () => {
    expect(decideOfficialReport(parsed(), base, NOW, null, null)).toEqual({
      kind: "accept",
      save: true,
      override: { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" },
      cycleStartMs: Date.parse("2026-09-17T09:00:00Z"),
      raw: "41.2",
    });
  });

  it("keeps the reset within the tolerance", () => {
    const aligned = { ...base, resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } } };
    const decision = decideOfficialReport(
      parsed({ resetsAtMs: Date.parse("2026-09-24T09:10:00Z") }),
      aligned,
      NOW,
      null,
      null,
    );
    expect(decision).toMatchObject({ kind: "accept", save: true, override: null });
  });

  it("rounds the window's reset to the minute", () => {
    const decision = decideOfficialReport(
      parsed({ resetsAtMs: Date.parse("2026-09-24T08:59:59.600Z") }),
      base,
      NOW,
      null,
      null,
    );
    expect(decision).toMatchObject({ override: { weekday: 4, hour: 9, minute: 0 } });
  });

  it("refuses a reading taken before the current cycle began", () => {
    const aligned = { ...base, resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } } };
    // Taken five minutes before this cycle began (still within a week of the window's reset).
    const old = parsed({ observedAtMs: Date.parse("2026-09-17T08:55:00Z") });
    expect(decideOfficialReport(old, aligned, NOW, null, null)).toEqual({ kind: "stale_reading" });
  });

  it("does not overwrite a figure at least as recent", () => {
    const aligned = { ...base, resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } } };
    const cycleStartMs = Date.parse("2026-09-17T09:00:00Z");
    const stored = { raw: "50", enteredAt: Date.parse("2026-09-23T11:55:00Z") };
    expect(decideOfficialReport(parsed(), aligned, NOW, stored, cycleStartMs)).toMatchObject({ save: false });
    const older = { raw: "30", enteredAt: Date.parse("2026-09-23T10:00:00Z") };
    expect(decideOfficialReport(parsed(), aligned, NOW, older, cycleStartMs)).toMatchObject({ save: true });
    // A figure stored for another cycle does not count.
    expect(decideOfficialReport(parsed(), aligned, NOW, stored, cycleStartMs - 7 * 86_400_000)).toMatchObject({
      save: true,
    });
  });

  it("keeps the provider's month day when it moves a weekly reset", () => {
    const withMonthDay = { ...base, resetOverrides: { claude: { weekday: 1, monthDay: 15, hour: 0, minute: 0 } } };
    expect(decideOfficialReport(parsed(), withMonthDay, NOW, null, null)).toMatchObject({
      override: { weekday: 4, monthDay: 15, hour: 9, minute: 0, source: "report" },
    });
  });
});

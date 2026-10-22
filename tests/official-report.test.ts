import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { decideOfficialReport, parseOfficialReport, RESET_DROP_POINTS } from "@/lib/official-report";
import { emptyResets, type ProviderResets } from "@/lib/resets";
import { withResetOverride } from "@/lib/settings";

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
    expect(decideOfficialReport(parsed(), monthly, NOW, null, emptyResets())).toEqual({ kind: "period_not_weekly" });
  });

  it("moves the provider's reset to the window's, and saves for the new cycle", () => {
    expect(decideOfficialReport(parsed(), base, NOW, null, emptyResets())).toEqual({
      kind: "accept",
      save: true,
      override: { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" },
      cycleStartMs: Date.parse("2026-09-17T09:00:00Z"),
      raw: "41.2",
      reset: null,
    });
  });

  it("keeps the reset within the tolerance", () => {
    const aligned = { ...base, resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } } };
    const decision = decideOfficialReport(
      parsed({ resetsAtMs: Date.parse("2026-09-24T09:10:00Z") }),
      aligned,
      NOW,
      null,
      emptyResets(),
    );
    expect(decision).toMatchObject({ kind: "accept", save: true, override: null });
  });

  it("rounds the window's reset to the minute", () => {
    const decision = decideOfficialReport(
      parsed({ resetsAtMs: Date.parse("2026-09-24T08:59:59.600Z") }),
      base,
      NOW,
      null,
      emptyResets(),
    );
    expect(decision).toMatchObject({ override: { weekday: 4, hour: 9, minute: 0 } });
  });

  it("refuses a reading taken before the current cycle began", () => {
    const aligned = { ...base, resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } } };
    // Taken five minutes before this cycle began (still within a week of the window's reset).
    const old = parsed({ observedAtMs: Date.parse("2026-09-17T08:55:00Z") });
    expect(decideOfficialReport(old, aligned, NOW, null, emptyResets())).toEqual({ kind: "stale_reading" });
  });

  it("does not overwrite a figure at least as recent", () => {
    const aligned = { ...base, resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } } };
    const cycleStartMs = Date.parse("2026-09-17T09:00:00Z");
    const stored = { view: { raw: "50", enteredAt: Date.parse("2026-09-23T11:55:00Z") }, cycleStartMs };
    expect(decideOfficialReport(parsed(), aligned, NOW, stored, emptyResets())).toMatchObject({ save: false });
    const older = { view: { raw: "30", enteredAt: Date.parse("2026-09-23T10:00:00Z") }, cycleStartMs };
    expect(decideOfficialReport(parsed(), aligned, NOW, older, emptyResets())).toMatchObject({ save: true });
    // A figure stored for another cycle does not count.
    const other = { ...stored, cycleStartMs: cycleStartMs - 7 * 86_400_000 };
    expect(decideOfficialReport(parsed(), aligned, NOW, other, emptyResets())).toMatchObject({ save: true });
  });

  it("keeps the provider's month day when it moves a weekly reset", () => {
    const withMonthDay = { ...base, resetOverrides: { claude: { weekday: 1, monthDay: 15, hour: 0, minute: 0 } } };
    expect(decideOfficialReport(parsed(), withMonthDay, NOW, null, emptyResets())).toMatchObject({
      override: { weekday: 4, monthDay: 15, hour: 9, minute: 0, source: "report" },
    });
  });
});

describe("decideOfficialReport — reset detection", () => {
  // Claude already aligned to its window: Thursday 09:00 UTC, cycle 2026-09-17 09:00 → 2026-09-24 09:00.
  const claude = withResetOverride(base, "claude", { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" });
  const CLAUDE_START = Date.parse("2026-09-17T09:00:00Z");
  const CLAUDE_END = Date.parse("2026-09-24T09:00:00Z");
  const earlier = (raw: string, overrides = {}) => ({
    view: { raw, enteredAt: Date.parse("2026-09-23T10:00:00Z") },
    cycleStartMs: CLAUDE_START,
    resetsAtMs: CLAUDE_END,
    ...overrides,
  });
  const on: ProviderResets = { v: 1, events: [], autoOffCycleStartMs: null };

  it("records a keep reset when the same window's figure drops by the threshold or more", () => {
    const reading = parsed({
      usedPercent: 3,
      resetsAtMs: CLAUDE_END,
      observedAtMs: Date.parse("2026-09-23T11:50:30Z"),
    });
    const R = Date.parse("2026-09-23T11:50:00Z");
    expect(decideOfficialReport(reading, claude, NOW, earlier("62"), on)).toEqual({
      kind: "accept",
      save: true,
      override: null,
      cycleStartMs: R,
      raw: "3",
      reset: {
        atMs: R,
        kind: "keep",
        cycleStartMs: CLAUDE_START,
        before: 62,
        beforeAtMs: Date.parse("2026-09-23T10:00:00Z"),
        source: "report",
        recordedAtMs: NOW.getTime(),
      },
    });
  });

  it("does not detect a smaller drop, a typed figure, or a cycle with detection off", () => {
    const reading = parsed({ usedPercent: 62 - RESET_DROP_POINTS + 0.5, resetsAtMs: CLAUDE_END });
    expect(decideOfficialReport(reading, claude, NOW, earlier("62"), on)).toMatchObject({
      kind: "accept",
      reset: null,
    });
    const low = parsed({ usedPercent: 3, resetsAtMs: CLAUDE_END });
    const typed = { view: { raw: "62", enteredAt: Date.parse("2026-09-23T10:00:00Z") }, cycleStartMs: CLAUDE_START };
    expect(decideOfficialReport(low, claude, NOW, typed, on)).toMatchObject({ reset: null });
    const off = { ...on, autoOffCycleStartMs: CLAUDE_START };
    expect(decideOfficialReport(low, claude, NOW, earlier("62"), off)).toMatchObject({ kind: "accept", reset: null });
  });

  it("refuses a reading from before the current segment", () => {
    const keep = {
      id: "k",
      atMs: Date.parse("2026-09-23T11:00:00Z"),
      kind: "keep" as const,
      cycleStartMs: CLAUDE_START,
      before: 62,
      beforeAtMs: null,
      source: "manual" as const,
      recordedAtMs: 0,
    };
    const reading = parsed({ resetsAtMs: CLAUDE_END, observedAtMs: Date.parse("2026-09-23T10:30:00Z") });
    expect(decideOfficialReport(reading, claude, NOW, null, { ...on, events: [keep] })).toEqual({
      kind: "stale_reading",
    });
  });

  describe("Codex (restart)", () => {
    // openai runs on the shared reset: 2026-09-21 00:00 → 2026-09-28 00:00.
    const S = Date.parse("2026-09-21T00:00:00Z");
    const E = Date.parse("2026-09-28T00:00:00Z");
    const R = Date.parse("2026-09-23T08:00:00Z");
    const stored = {
      view: { raw: "90", enteredAt: Date.parse("2026-09-22T12:00:00Z") },
      cycleStartMs: S,
      resetsAtMs: E,
    };
    const jumped = () => parsed({ providerId: "openai", usedPercent: 1, resetsAtMs: R + 7 * 86_400_000 });

    it("records a restart when the window jumps a week past R", () => {
      expect(decideOfficialReport(jumped(), base, NOW, stored, on)).toEqual({
        kind: "accept",
        save: true,
        override: { weekday: 3, monthDay: 23, hour: 8, minute: 0, source: "reset" },
        cycleStartMs: R,
        raw: "1",
        reset: {
          atMs: R,
          kind: "restart",
          cycleStartMs: S,
          before: 90,
          beforeAtMs: Date.parse("2026-09-22T12:00:00Z"),
          source: "report",
          recordedAtMs: NOW.getTime(),
          previousOverride: null,
        },
      });
    });

    it("ignores a moved window while detection is off for the cycle, instead of moving the reset", () => {
      expect(decideOfficialReport(jumped(), base, NOW, stored, { ...on, autoOffCycleStartMs: S })).toEqual({
        kind: "ignored",
      });
    });

    it("only aligns, without a reset, when there is no earlier reading to compare with", () => {
      expect(decideOfficialReport(jumped(), base, NOW, null, on)).toMatchObject({
        kind: "accept",
        override: { weekday: 3, hour: 8, minute: 0, source: "report" },
        reset: null,
      });
    });
  });
});

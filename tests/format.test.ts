import { describe, expect, it } from "vitest";
import { formatCost, formatCostOrDash, formatMonthDay, formatPercent, formatRecentMoment } from "@/lib/format";

describe("formatPercent", () => {
  it('marks a tiny non-zero share with the locale\'s own "less than" percent form', () => {
    expect(formatPercent(0.0001, "hu")).toBe("<0,1%");
    expect(formatPercent(0.0001, "en")).toBe("<0.1%");
    expect(formatPercent(0.0001, "de")).toBe("<0,1 %");
  });

  it("does not use the tiny-share form once the share reaches 0.1%", () => {
    expect(formatPercent(0.001, "en")).toBe("0.1%");
  });

  it("leaves an exact zero alone", () => {
    expect(formatPercent(0, "en")).toBe("0%");
  });
});

describe("formatCost", () => {
  it("formats a USD amount with the locale's own currency conventions", () => {
    expect(formatCost(12.3456, "en")).toBe("$12.35");
    expect(formatCost(0, "en")).toBe("$0.00");
  });
});

describe("formatCostOrDash", () => {
  it("is a dash for a machine or group that never sent a cost figure", () => {
    expect(formatCostOrDash(undefined, "en")).toBe("–");
  });

  it("formats the amount otherwise", () => {
    expect(formatCostOrDash(4.5, "en")).toBe("$4.50");
  });
});

describe("formatMonthDay", () => {
  it("appends the locale's day-of-month punctuation for Hungarian and German", () => {
    expect(formatMonthDay(21, "hu")).toBe("21.");
    expect(formatMonthDay(1, "hu")).toBe("1.");
    expect(formatMonthDay(21, "de")).toBe("21.");
  });

  it("uses a bare number for English", () => {
    expect(formatMonthDay(21, "en")).toBe("21");
    expect(formatMonthDay(1, "en")).toBe("1");
  });
});

describe("formatRecentMoment", () => {
  // Wednesday 12:00 in Budapest.
  const now = Date.parse("2026-09-23T10:00:00Z");

  it("gives the time alone on the same day, in the dashboard's time zone", () => {
    expect(formatRecentMoment(Date.parse("2026-09-23T08:00:00Z"), now, "Europe/Budapest", "en")).toBe("10:00");
    // 00:30 Wednesday in Budapest, still Tuesday in UTC.
    expect(formatRecentMoment(Date.parse("2026-09-22T22:30:00Z"), now, "Europe/Budapest", "en")).toBe("00:30");
  });

  it("adds the weekday on an earlier day", () => {
    expect(formatRecentMoment(Date.parse("2026-09-22T20:00:00Z"), now, "Europe/Budapest", "en")).toBe("Tuesday 22:00");
  });
});

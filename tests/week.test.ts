import { describe, expect, it } from "vitest";
import { firstDayOfWeek, weekdayOrder } from "@/lib/week";

describe("firstDayOfWeek", () => {
  it("starts the week on Sunday for English", () => {
    expect(firstDayOfWeek("en")).toBe(0);
  });

  it("starts the week on Monday for Hungarian and German", () => {
    expect(firstDayOfWeek("hu")).toBe(1);
    expect(firstDayOfWeek("de")).toBe(1);
  });

  it("falls back to Monday for a locale string Intl.Locale rejects", () => {
    expect(firstDayOfWeek("not a locale!!")).toBe(1);
    expect(firstDayOfWeek("")).toBe(1);
  });
});

describe("weekdayOrder", () => {
  it("rotates 0..6 to start on Sunday for English", () => {
    expect(weekdayOrder("en")).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("rotates 0..6 to start on Monday for Hungarian", () => {
    expect(weekdayOrder("hu")).toEqual([1, 2, 3, 4, 5, 6, 0]);
  });

  it("always carries every weekday exactly once", () => {
    for (const locale of ["en", "hu", "de", "not a locale!!"]) {
      expect([...weekdayOrder(locale)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    }
  });
});

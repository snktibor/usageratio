import { describe, expect, it } from "vitest";
import { formatMonthDay, formatPercent } from "@/lib/format";

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

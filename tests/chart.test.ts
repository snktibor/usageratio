import { describe, expect, it } from "vitest";
import { formatPercentTick, formatTokenTick, niceScale } from "@/lib/chart";

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
      max: 1_500_000,
      step: 500_000,
      ticks: [0, 500_000, 1_000_000, 1_500_000],
    });
  });
});

describe("tick text", () => {
  it("shows a decimal only where the step needs one", () => {
    expect(formatPercentTick(0.05, 0.025)).toBe("5%");
    expect(formatPercentTick(0.075, 0.025)).toBe("7,5%");
    expect(formatPercentTick(0.2, 0.05)).toBe("20%");
  });

  it("abbreviates token counts the Hungarian way", () => {
    expect(formatTokenTick(1_200_000).replace(/\s/g, " ")).toBe("1,2 M");
    expect(formatTokenTick(250_000).replace(/\s/g, " ")).toBe("250 E");
  });
});

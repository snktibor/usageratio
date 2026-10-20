import { describe, expect, it } from "vitest";
import { estimateResources, WATER_LITRES_PER_KWH, WH_PER_USD } from "@/lib/resources";

describe("estimateResources", () => {
  it("scales energy with the list-price cost, and water with the energy", () => {
    // Simon P. Couch's heavy coding day: $15–20 at list price, about 1.3 kWh.
    const day = estimateResources(17.5);
    expect(day.energyKwh).toBeCloseTo(1.365);
    expect(day.waterLitres).toBeCloseTo(1.365 * WATER_LITRES_PER_KWH);
  });

  it("matches the per-token factors it stands for: ~390 Wh per million input tokens at Opus 4.5's $5", () => {
    expect(estimateResources(5).energyKwh * 1000).toBeCloseTo(390);
    expect(WH_PER_USD).toBe(78);
  });

  it("is zero for no cost, and never negative", () => {
    expect(estimateResources(0)).toEqual({ energyKwh: 0, waterLitres: 0 });
    expect(estimateResources(-3)).toEqual({ energyKwh: 0, waterLitres: 0 });
  });
});

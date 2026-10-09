import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { earliestCycle, earliestStartMs, providerCycle } from "@/lib/provider-cycles";

// Wednesday 2026-09-23 12:00 UTC.
const NOW = new Date("2026-09-23T12:00:00Z");
const config = {
  ...getConfig(),
  reset: { period: "weekly" as const, weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
  resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
};

describe("providerCycle", () => {
  it("uses the shared reset for a provider without an override", () => {
    const { cycle, previous } = providerCycle(NOW, config, "openai");
    expect(cycle.start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(cycle.end.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(previous.start.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("uses the provider's own reset", () => {
    const { cycle, previous } = providerCycle(NOW, config, "claude");
    expect(cycle.start.toISOString()).toBe("2026-09-17T09:00:00.000Z");
    expect(cycle.end.toISOString()).toBe("2026-09-24T09:00:00.000Z");
    expect(previous.start.toISOString()).toBe("2026-09-10T09:00:00.000Z");
  });
});

describe("earliestCycle / earliestStartMs", () => {
  it("picks the provider whose cycle began first", () => {
    expect(earliestCycle(NOW, config, ["openai", "claude"]).cycle.start.toISOString()).toBe("2026-09-17T09:00:00.000Z");
    expect(new Date(earliestStartMs(NOW, config, ["openai", "claude"], "previous")).toISOString()).toBe(
      "2026-09-10T09:00:00.000Z",
    );
  });

  it("falls back to the shared reset with no providers", () => {
    expect(earliestCycle(NOW, config, []).cycle.start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("counts the shared reset even when every provider has a later start", () => {
    const later = { ...config, resetOverrides: { claude: { weekday: 2, monthDay: 1, hour: 0, minute: 0 } } };
    expect(earliestStartMs(NOW, later, ["claude"], "cycle")).toBe(Date.parse("2026-09-21T00:00:00Z"));
  });
});

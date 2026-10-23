import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import {
  currentSegmentStartMs,
  earliestCycle,
  earliestStartMs,
  officialTagAt,
  providerCycle,
} from "@/lib/provider-cycles";
import type { ResetEvent } from "@/lib/resets";

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

describe("with resets", () => {
  const R = Date.parse("2026-09-22T14:00:00Z");
  const S = Date.parse("2026-09-21T00:00:00Z");
  const restarted = {
    ...config,
    resetOverrides: {
      ...config.resetOverrides,
      openai: { weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" as const },
    },
  };
  const event = (overrides: Partial<ResetEvent>): ResetEvent => ({
    id: "r",
    atMs: R,
    kind: "keep",
    cycleStartMs: S,
    before: 90,
    beforeAtMs: null,
    source: "manual",
    recordedAtMs: R,
    ...overrides,
  });
  const restart = event({ kind: "restart", previousOverride: null });

  it("makes the cycle a restart cut short the previous one", () => {
    const { cycle, previous } = providerCycle(NOW, restarted, "openai", [restart]);
    expect(cycle.start.toISOString()).toBe("2026-09-22T14:00:00.000Z");
    expect(previous.start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(previous.end.toISOString()).toBe("2026-09-22T14:00:00.000Z");
  });

  it("starts the current segment at the cycle's last keep reset", () => {
    expect(currentSegmentStartMs(NOW, config, "openai", [])).toBe(S);
    expect(currentSegmentStartMs(NOW, config, "openai", [event({})])).toBe(R);
  });

  it("tags a figure with the segment its moment falls in, in this cycle or the one before", () => {
    const tagAt = officialTagAt(NOW, restarted, "openai", [restart]);
    expect(tagAt(R + 3_600_000)).toBe(R);
    expect(tagAt(S + 3_600_000)).toBe(S);
    expect(tagAt(S - 1)).toBeNull();
  });
});

import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuotaMeter } from "@/components/quota-meter";
import { getConfig } from "@/lib/config";
import { buildDashboard, type StoreSnapshot } from "@/lib/dashboard";
import { applyGroundTruth } from "@/lib/ground-truth";
import type { ResetEvent } from "@/lib/resets";
import { renderWithIntl } from "../helpers/render";

const HOUR = 3_600_000;
const CYCLE_START = Date.parse("2026-09-20T22:00:00Z");
const NOW = new Date("2026-09-23T10:00:00Z");

function snapshot(partial: Partial<StoreSnapshot>): StoreSnapshot {
  return { events: [], groups: [], machines: [], ...partial };
}

describe("QuotaMeter", () => {
  it("exposes usage against a token limit as an accessible meter", () => {
    const config = { ...getConfig({}), useTokenLimits: true, limit: 500_000, tokenMode: "delta" as const };
    const model = buildDashboard(
      NOW,
      config,
      snapshot({ events: [{ machineId: "win-1", groupId: "Work", tokens: 150_000, ts: CYCLE_START + 10 * HOUR }] }),
    );
    const view = applyGroundTruth(model, null);

    renderWithIntl(<QuotaMeter model={model} view={view} />);

    const meter = screen.getByRole("meter");
    expect(meter.getAttribute("aria-valuemin")).toBe("0");
    expect(meter.getAttribute("aria-valuemax")).toBe("500000");
    expect(meter.getAttribute("aria-valuenow")).toBe("150000");
    const valueText = meter.getAttribute("aria-valuetext");
    expect(valueText).toContain("150,000");
    expect(valueText).toContain("500,000");
    expect(valueText).toContain("30.0%");
  });

  it("hides the meter from assistive tech while nothing at all tells the quota's state", () => {
    // Token limits off, and no official reading: neither figure exists to expose.
    const config = getConfig({});
    const model = buildDashboard(NOW, config, snapshot({}));
    const view = applyGroundTruth(model, null);

    renderWithIntl(<QuotaMeter model={model} view={view} />);

    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("shows the cost estimate line, with its energy and water, once an event of the cycle carries one", () => {
    const config = { ...getConfig({}), costEstimate: true };
    const model = buildDashboard(
      NOW,
      config,
      snapshot({
        events: [{ machineId: "mac", groupId: "Work", tokens: 150_000, ts: CYCLE_START + 10 * HOUR, costUsd: 12.3456 }],
      }),
    );
    const view = applyGroundTruth(model, null);

    renderWithIntl(<QuotaMeter model={model} view={view} />);

    expect(screen.getByText(/\$12\.35/)).toBeTruthy();
    expect(screen.getByText(/at API list prices/)).toBeTruthy();
    expect(screen.getByText("≈ 963 Wh")).toBeTruthy();
    expect(screen.getByText("≈ 4 L of water")).toBeTruthy();
  });

  it("has no cost line with the cost estimate off, even when an event carries a cost", () => {
    const model = buildDashboard(
      NOW,
      getConfig({}),
      snapshot({
        events: [{ machineId: "mac", groupId: "Work", tokens: 150_000, ts: CYCLE_START + 10 * HOUR, costUsd: 12.3456 }],
      }),
    );

    renderWithIntl(<QuotaMeter model={model} view={applyGroundTruth(model, null)} />);

    expect(screen.queryByText(/at API list prices/)).toBeNull();
  });

  it("has no cost line while nothing in the cycle carries a cost figure", () => {
    const config = { ...getConfig({}), costEstimate: true };
    const model = buildDashboard(
      NOW,
      config,
      snapshot({ events: [{ machineId: "mac", groupId: "Work", tokens: 150_000, ts: CYCLE_START + 10 * HOUR }] }),
    );
    const view = applyGroundTruth(model, null);

    renderWithIntl(<QuotaMeter model={model} view={view} />);

    expect(screen.queryByText(/at API list prices/)).toBeNull();
  });

  describe("the current pace", () => {
    // Budapest time: the cycle started Monday 00:00, NOW is 60 h into it.
    const config = {
      ...getConfig({}),
      useTokenLimits: true,
      limit: 1_000_000,
      tokenMode: "delta" as const,
      reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
    };
    /** 200k early on, then one report an hour up to NOW. */
    function render(lastHours: number[]) {
      const events = [
        { machineId: "mac", groupId: "Work", tokens: 200_000, ts: CYCLE_START + 10 * HOUR },
        ...lastHours.map((tokens, index) => ({
          machineId: "mac",
          groupId: "Work",
          tokens,
          ts: CYCLE_START + (61 - lastHours.length + index) * HOUR,
        })),
      ];
      const model = buildDashboard(NOW, config, snapshot({ events }));
      renderWithIntl(<QuotaMeter model={model} view={applyGroundTruth(model, null)} />);
    }

    it("says when a burst of the last hours would use the budget up", () => {
      render([5_000, 5_000, 5_000, 5_000, 5_000, 5_000, 40_000, 40_000]);
      expect(
        screen.getByText(
          /Current pace \(since 10:00, 7\.74× the average\): runs out in about 17 hours 15 minutes, around Thursday 05:15\./,
        ),
      ).toBeTruthy();
    });

    it("names the whole window when the pace did not change", () => {
      render(Array(8).fill(10_000));
      expect(
        screen.getByText(/Current pace \(over the last 8 hours, 2\.14× the average\): runs out in about 3 days/),
      ).toBeTruthy();
    });

    it("says since when nothing was used", () => {
      render([30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 0, 0]);
      expect(screen.getByText(/Current pace: nothing used since 10:00\./)).toBeTruthy();
    });
  });
});

describe("QuotaMeter — after a keep reset", () => {
  // Fixed to Budapest time, independent of DEFAULT_RESET's own (deploy-time) default.
  const config = {
    ...getConfig({}),
    useTokenLimits: true,
    limit: 500_000,
    tokenMode: "delta" as const,
    reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
  };
  const keep = (hoursIntoCycle: number, before: number | null): ResetEvent => {
    const atMs = CYCLE_START + hoursIntoCycle * HOUR;
    return {
      id: `k${hoursIntoCycle}`,
      atMs,
      kind: "keep",
      cycleStartMs: CYCLE_START,
      before,
      beforeAtMs: null,
      source: "manual",
      recordedAtMs: atMs,
    };
  };
  const events = [
    { machineId: "win-1", groupId: "Work", tokens: 300_000, ts: CYCLE_START + 10 * HOUR },
    { machineId: "win-1", groupId: "Work", tokens: 20_000, ts: CYCLE_START + 40 * HOUR },
  ];

  it("states the reset, the figure before it and the week's total under the main figure", () => {
    const model = buildDashboard(NOW, config, snapshot({ events, resets: [keep(38, 80)] }));
    renderWithIntl(<QuotaMeter model={model} view={applyGroundTruth(model, { percent: 20, atMs: null })} />);
    expect(screen.getByText(/^Reset .+ · before it 80% · this week in total 100%$/)).toBeDefined();
  });

  it("shows an unknown figure as a dash and leaves it out of the total", () => {
    const model = buildDashboard(NOW, config, snapshot({ events, resets: [keep(20, null), keep(38, 80)] }));
    renderWithIntl(<QuotaMeter model={model} view={applyGroundTruth(model, { percent: 20, atMs: null })} />);
    expect(
      screen.getByText(/^Reset .+ · before it – · Reset .+ · before it 80% · this week in total 100%$/),
    ).toBeDefined();
  });

  it("lays the meter's ruler and its now marker over the segment", () => {
    const model = buildDashboard(NOW, config, snapshot({ events, resets: [keep(38, 80)] }));
    renderWithIntl(<QuotaMeter model={model} view={applyGroundTruth(model, null)} />);
    // 22 of the segment's 130 hours have passed; the text still tells the cycle's 60 of 168.
    expect(Number.parseFloat(screen.getByText("now").style.left)).toBeCloseTo((22 / 130) * 100);
    expect(screen.getByText(/36% of the cycle has elapsed/)).toBeDefined();
  });

  it("has no reset line without a keep reset", () => {
    const model = buildDashboard(NOW, config, snapshot({ events }));
    renderWithIntl(<QuotaMeter model={model} view={applyGroundTruth(model, null)} />);
    expect(screen.queryByText(/in total/)).toBeNull();
  });
});

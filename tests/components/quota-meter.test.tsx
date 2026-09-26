import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QuotaMeter } from "@/components/quota-meter";
import { getConfig } from "@/lib/config";
import { buildDashboard, type StoreSnapshot } from "@/lib/dashboard";
import { applyGroundTruth } from "@/lib/ground-truth";
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

  it("shows the cost estimate line once an event of the cycle carries one", () => {
    const config = getConfig({});
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
  });

  it("has no cost line while nothing in the cycle carries a cost figure", () => {
    const config = getConfig({});
    const model = buildDashboard(
      NOW,
      config,
      snapshot({ events: [{ machineId: "mac", groupId: "Work", tokens: 150_000, ts: CYCLE_START + 10 * HOUR }] }),
    );
    const view = applyGroundTruth(model, null);

    renderWithIntl(<QuotaMeter model={model} view={view} />);

    expect(screen.queryByText(/at API list prices/)).toBeNull();
  });
});

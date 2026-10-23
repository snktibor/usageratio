import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type ChartSeries, CycleChart } from "@/components/cycle-chart";
import type { TimeSpan } from "@/lib/chart";
import { getConfig } from "@/lib/config";
import { buildDashboard, type StoreSnapshot } from "@/lib/dashboard";
import { renderWithIntl } from "../helpers/render";

const HOUR = 3_600_000;
// Monday 00:00 Budapest time (weekly reset's default weekday).
const CYCLE_START = Date.parse("2026-09-20T22:00:00Z");
const NOW = new Date("2026-09-23T10:00:00Z");

function snapshot(partial: Partial<StoreSnapshot>): StoreSnapshot {
  return { events: [], groups: [], machines: [], ...partial };
}

function liveRegion(): Element {
  const region = document.querySelector('[aria-live="polite"]');
  if (!region) throw new Error("no aria-live region rendered");
  return region;
}

describe("CycleChart", () => {
  it("reads out the crosshair once focused, and moves it with the arrow keys", () => {
    const model = buildDashboard(
      NOW,
      getConfig({}),
      snapshot({ events: [{ machineId: "win-1", groupId: "Work", tokens: 1_000, ts: CYCLE_START + 10 * HOUR }] }),
    );
    // Distinct values per sample: the crosshair's readout must change as it moves.
    const series: ChartSeries[] = [
      { id: "total", label: "Total", color: "#fff", values: model.timeline.times.map((_, index) => index) },
    ];

    renderWithIntl(
      <CycleChart
        model={model}
        series={series}
        minAxis={1}
        formatTick={(value) => String(value)}
        formatValue={(value) => `${value} tokens`}
        label="Usage over time"
      />,
    );

    const plot = screen.getByRole("group", { name: "Usage over time" });
    expect(liveRegion().textContent).toBe("");

    fireEvent.focus(plot);
    const afterFocus = liveRegion().textContent;
    expect(afterFocus).not.toBe("");
    expect(afterFocus).toContain("tokens");

    fireEvent.keyDown(plot, { key: "ArrowLeft" });
    const afterArrowLeft = liveRegion().textContent;
    expect(afterArrowLeft).not.toBe("");
    expect(afterArrowLeft).not.toBe(afterFocus);

    fireEvent.keyDown(plot, { key: "Escape" });
    expect(liveRegion().textContent).toBe("");
  });

  describe("zoomed in", () => {
    // Every sample's own value is its hour into the cycle: the readout names which sample it is on.
    function renderZoomable() {
      const model = buildDashboard(
        NOW,
        getConfig({}),
        snapshot({ events: [{ machineId: "win-1", groupId: "Work", tokens: 1_000, ts: CYCLE_START + 10 * HOUR }] }),
      );
      const series: ChartSeries[] = [
        {
          id: "total",
          label: "Total",
          color: "#fff",
          values: model.timeline.times.map((time) => (time - CYCLE_START) / HOUR),
        },
      ];
      renderWithIntl(
        <CycleChart
          model={model}
          series={series}
          minAxis={1}
          formatTick={(value) => String(value)}
          formatValue={(value) => `h${value}`}
          label="Usage over time"
        />,
      );
      return screen.getByRole("group", { name: "Usage over time" });
    }

    it("keeps the keys, the readout and the table to the last 24 hours", () => {
      const plot = renderZoomable();
      // 60 hours into the cycle.
      fireEvent.click(screen.getByRole("radio", { name: "24 hours" }));
      expect(screen.getByRole("radio", { name: "24 hours" })).toHaveProperty("checked", true);

      fireEvent.focus(plot);
      expect(liveRegion().textContent).toContain("h60");
      fireEvent.keyDown(plot, { key: "Home" });
      expect(liveRegion().textContent).toContain("h36");
      fireEvent.keyDown(plot, { key: "ArrowLeft" });
      expect(liveRegion().textContent).toContain("h36");
      fireEvent.keyDown(plot, { key: "End" });
      expect(liveRegion().textContent).toContain("h60");

      // One table row per hour of the window, and none from before it.
      const rows = document.querySelectorAll("table tbody tr");
      expect(rows).toHaveLength(25);
      expect(rows[0]?.textContent).toContain("h36");
    });

    it("goes back to the whole cycle, one row a day in the table", () => {
      renderZoomable();
      fireEvent.click(screen.getByRole("radio", { name: "24 hours" }));
      fireEvent.click(screen.getByRole("radio", { name: "Whole cycle" }));
      // Monday and Tuesday have ended, then now.
      expect(document.querySelectorAll("table tbody tr")).toHaveLength(3);
      expect(screen.queryByRole("button", { name: "Reset zoom" })).toBeNull();
    });
  });
});

describe("CycleChart — resets", () => {
  // Whatever the default reset is: the cycle's start, and half way from it to now on a whole minute.
  const S = buildDashboard(NOW, getConfig({}), snapshot({})).cycle.startMs;
  const R = S + Math.floor((NOW.getTime() - S) / 2 / 60_000) * 60_000;
  const model = buildDashboard(
    NOW,
    getConfig({}),
    snapshot({
      events: [
        { machineId: "win-1", groupId: "Work", tokens: 1_000, ts: S + HOUR },
        { machineId: "win-1", groupId: "Work", tokens: 500, ts: R + HOUR },
      ],
      resets: [
        {
          id: "k",
          atMs: R,
          kind: "keep",
          cycleStartMs: S,
          before: null,
          beforeAtMs: null,
          source: "manual",
          recordedAtMs: R,
        },
      ],
    }),
  );
  const series: ChartSeries[] = [
    { id: "total", label: "Total", color: "#fff", values: model.timeline.times.map(() => 0) },
  ];
  const renderChart = (paleSpans?: TimeSpan[]) =>
    renderWithIntl(
      <CycleChart
        model={model}
        series={series}
        minAxis={1}
        formatTick={(value) => String(value)}
        formatValue={(value) => String(value)}
        label="Usage"
        {...(paleSpans && { paleSpans })}
      />,
    );

  it("marks a keep reset with a labelled line", () => {
    renderChart();
    expect(screen.getByText("reset")).toBeDefined();
    expect(document.querySelectorAll("[data-reset-marker]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(0);
  });

  it("veils the stretches it is given", () => {
    renderChart([{ startMs: S, endMs: R }]);
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(1);
  });
});

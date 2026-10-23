import { fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChartSeries, CycleChart } from "@/components/cycle-chart";
import type { TimeSpan } from "@/lib/chart";
import { getConfig } from "@/lib/config";
import { buildDashboard, type StoreSnapshot } from "@/lib/dashboard";
import { formatCycleMoment } from "@/lib/format";
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

  it("breaks each line at the reset instead of drawing its drop along the marker", () => {
    const { times } = model.timeline;
    renderWithIntl(
      <CycleChart
        model={model}
        series={[{ id: "total", label: "Total", color: "#fff", values: times.map((ms) => (ms < R ? 5 : 0)) }]}
        minAxis={1}
        formatTick={(value) => String(value)}
        formatValue={(value) => String(value)}
        label="Usage"
      />,
    );
    const d = document.querySelector("svg path[stroke='#fff']")?.getAttribute("d") ?? "";
    expect(d.match(/M/g)).toHaveLength(2);
  });
});

describe("CycleChart — the reset label near the plot's edges", () => {
  // jsdom lays nothing out: the plot needs a width for the labels to fall on different places.
  const SIZE = { clientWidth: 800, clientHeight: 256 } as const;
  beforeAll(() => {
    for (const [name, value] of Object.entries(SIZE)) {
      Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
    }
  });
  afterAll(() => {
    for (const name of Object.keys(SIZE)) Reflect.deleteProperty(HTMLElement.prototype, name);
  });

  // Whatever the default reset is: the cycle's start.
  const S = buildDashboard(NOW, getConfig({}), snapshot({})).cycle.startMs;
  const keep = (id: string, hoursAgo: number) => {
    const atMs = NOW.getTime() - hoursAgo * HOUR;
    return {
      id,
      atMs,
      kind: "keep" as const,
      cycleStartMs: S,
      before: null,
      beforeAtMs: null,
      source: "manual" as const,
      recordedAtMs: atMs,
    };
  };

  /** The reset labels of the last 24 hours, oldest reset first, with the plot's width left to measure. */
  function zoomedLabels(resets: ReturnType<typeof keep>[]): HTMLElement[] {
    const model = buildDashboard(NOW, getConfig({}), snapshot({ resets }));
    renderWithIntl(
      <CycleChart
        model={model}
        series={[{ id: "total", label: "Total", color: "#fff", values: model.timeline.times.map(() => 0) }]}
        minAxis={1}
        formatTick={(value) => String(value)}
        formatValue={(value) => String(value)}
        label="Usage"
      />,
    );
    fireEvent.click(screen.getByRole("radio", { name: "24 hours" }));
    return screen.getAllByText("reset");
  }
  const placement = (label: HTMLElement) =>
    ["-translate-x-full", "translate-x-0", "-translate-x-1/2"].filter((name) => label.classList.contains(name));

  it("puts it left of its marker near the right edge, where the value axis's labels are, and right of it near the left edge", () => {
    // 1 h ago: 33 px from the right edge; 12 h ago: in the middle; 23.5 h ago: 17 px from the left edge.
    const labels = zoomedLabels([keep("old", 23.5), keep("mid", 12), keep("new", 1)]);
    expect(labels.map(placement)).toEqual([["translate-x-0"], ["-translate-x-1/2"], ["-translate-x-full"]]);
  });

  it("keeps it clear of the value axis's labels at the right edge", () => {
    const [label] = zoomedLabels([keep("new", 0.25)]);
    // Its right edge is where its `left` is: no further right than the room the axis's labels take.
    expect(Number.parseFloat(label!.style.left)).toBeLessThanOrEqual(800 - 48);
  });
});

describe("CycleChart — a month, thinned", () => {
  // A monthly cycle (Budapest time) 540 hours in: more samples than a chart draws, so it keeps every third.
  const MONTH_START = Date.parse("2026-08-31T22:00:00Z");
  const monthly = {
    ...getConfig({}),
    reset: { ...getConfig({}).reset, period: "monthly" as const, timeZone: "Europe/Budapest" },
  };
  // 07:30 on the 18th: between two hourly samples, so a plain thinning has no reason to keep the ones around it.
  const R = MONTH_START + 17 * 24 * HOUR + 7.5 * HOUR;

  it("keeps the samples around a reset, so the crosshair can stand on both sides of the drop", () => {
    const model = buildDashboard(
      NOW,
      monthly,
      snapshot({
        resets: [
          {
            id: "k",
            atMs: R,
            kind: "keep",
            cycleStartMs: MONTH_START,
            before: null,
            beforeAtMs: null,
            source: "manual",
            recordedAtMs: R,
          },
        ],
      }),
    );
    renderWithIntl(
      <CycleChart
        model={model}
        series={[{ id: "total", label: "Total", color: "#fff", values: model.timeline.times.map(() => 0) }]}
        minAxis={1}
        formatTick={(value) => String(value)}
        formatValue={(value) => String(value)}
        label="Usage"
      />,
    );
    const plot = screen.getByRole("group", { name: "Usage" });

    // Step through every sample the chart shows.
    fireEvent.focus(plot);
    fireEvent.keyDown(plot, { key: "Home" });
    const readouts: string[] = [];
    for (let step = 0; step < model.timeline.times.length; step++) {
      readouts.push(liveRegion().textContent ?? "");
      fireEvent.keyDown(plot, { key: "ArrowRight" });
    }

    for (const ms of [R - 1, R]) {
      const moment = formatCycleMoment(ms, "monthly", "Europe/Budapest", "en");
      expect(readouts.some((readout) => readout.startsWith(`${moment}:`))).toBe(true);
    }
  });
});

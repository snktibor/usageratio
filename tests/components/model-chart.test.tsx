import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelChart } from "@/components/model-chart";
import { getConfig } from "@/lib/config";
import { buildDashboard, type StoreSnapshot } from "@/lib/dashboard";
import type { ResetEvent } from "@/lib/resets";
import { renderWithIntl } from "../helpers/render";

const HOUR = 3_600_000;
const CYCLE_START = Date.parse("2026-09-20T22:00:00Z");
const NOW = new Date("2026-09-23T10:00:00Z");

const events = [
  {
    machineId: "win",
    groupId: "Work",
    tokens: 30_000,
    ts: CYCLE_START + 10 * HOUR,
    models: { "claude-opus-4": 30_000 },
  },
];
const keep: ResetEvent = {
  id: "r38",
  atMs: CYCLE_START + 38 * HOUR,
  kind: "keep",
  cycleStartMs: CYCLE_START,
  before: 80,
  beforeAtMs: null,
  source: "manual",
  recordedAtMs: CYCLE_START + 38 * HOUR,
};

function render(partial: Partial<StoreSnapshot>) {
  // Fixed to Budapest time, independent of DEFAULT_RESET's own (deploy-time) default.
  const config = {
    ...getConfig({}),
    tokenMode: "delta" as const,
    reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
  };
  renderWithIntl(<ModelChart model={buildDashboard(NOW, config, { events, groups: [], machines: [], ...partial })} />);
}

describe("ModelChart", () => {
  it("says the tokens start again from 0 at each reset once the cycle has one", () => {
    render({ resets: [keep] });
    expect(
      screen.getByText(
        "Measured tokens of the selected model by group, aggregated since the beginning of the cycle, starting again from 0 at each reset.",
      ),
    ).toBeDefined();
  });

  it("says nothing of resets without one", () => {
    render({});
    expect(
      screen.getByText("Measured tokens of the selected model by group, aggregated since the beginning of the cycle."),
    ).toBeDefined();
  });
});

describe("ModelChart — a closed cycle with keep resets", () => {
  it("says the lines start again from 0 at each of its resets", () => {
    const END = CYCLE_START + 168 * HOUR;
    const R = CYCLE_START + 38 * HOUR;
    const config = {
      ...getConfig({}),
      tokenMode: "delta" as const,
      reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
    };
    const closed = buildDashboard(
      new Date(END + 32 * HOUR),
      config,
      {
        events: [
          ...events,
          { machineId: "win", groupId: "Work", tokens: 12_000, ts: R + HOUR, models: { "claude-opus-4": 12_000 } },
        ],
        groups: [],
        machines: [],
        archivedSegments: [
          { start: CYCLE_START, end: R, official: 80, total: 0, groups: {} },
          { start: R, end: END, official: 44, total: 0, groups: {} },
        ],
      },
      [],
      {
        cycle: { start: new Date(CYCLE_START), end: new Date(END) },
        previous: { start: new Date(CYCLE_START - 168 * HOUR), end: new Date(CYCLE_START) },
      },
    );
    renderWithIntl(<ModelChart model={closed} />);
    expect(screen.getByText(/starting again from 0 at each reset/)).toBeDefined();
  });
});

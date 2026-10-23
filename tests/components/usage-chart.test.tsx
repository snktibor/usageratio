import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageChart } from "@/components/usage-chart";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import { applyGroundTruth, applySegmentFigures } from "@/lib/ground-truth";
import type { ResetEvent } from "@/lib/resets";
import { renderWithIntl } from "../helpers/render";

const HOUR = 3_600_000;
const NOW = new Date("2026-09-23T10:00:00Z");
const config = { ...getConfig({}), useTokenLimits: true, limit: 500_000, tokenMode: "delta" as const };
// Whatever the default reset is: the cycle's start, and half way from it to now on a whole minute.
const S = buildDashboard(NOW, config, { events: [], groups: [], machines: [] }).cycle.startMs;
const R = S + Math.floor((NOW.getTime() - S) / 2 / 60_000) * 60_000;

/** Work's 30k and Home's 20k before the reset, Work's 12k since. */
function modelWith(before: number | null) {
  const reset: ResetEvent = {
    id: "k",
    atMs: R,
    kind: "keep",
    cycleStartMs: S,
    before,
    beforeAtMs: null,
    source: "manual",
    recordedAtMs: R,
  };
  return buildDashboard(NOW, config, {
    events: [
      { machineId: "win-1", groupId: "Work", tokens: 30_000, ts: S + HOUR },
      { machineId: "mac", groupId: "Home", tokens: 20_000, ts: S + 2 * HOUR },
      { machineId: "win-1", groupId: "Work", tokens: 12_000, ts: R + HOUR },
    ],
    groups: [],
    machines: [],
    resets: [reset],
  });
}

describe("UsageChart — after a keep reset", () => {
  it("fades a finished segment that has no figure of its own under an official reading", () => {
    const model = modelWith(null);
    renderWithIntl(
      <UsageChart model={model} view={applyGroundTruth(model, { percent: 6, atMs: null })} subLimits={[]} />,
    );
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(1);
    expect(screen.getByText(/an estimate at the current rate/)).toBeDefined();
  });

  it("draws every segment plainly when each has its figure, and says the lines restart", () => {
    const model = modelWith(80);
    renderWithIntl(
      <UsageChart model={model} view={applyGroundTruth(model, { percent: 6, atMs: null })} subLimits={[]} />,
    );
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(0);
    expect(screen.getByText(/every line starts again from 0/)).toBeDefined();
  });

  it("charts the group that used tokens only before the reset", () => {
    const model = modelWith(80);
    renderWithIntl(<UsageChart model={model} view={applyGroundTruth(model, null)} subLimits={[]} />);
    expect(screen.getAllByText("Home").length).toBeGreaterThan(0);
  });
});

describe("UsageChart — a closed cycle with keep resets", () => {
  const END = S + 7 * 24 * HOUR;
  const R = S + 38 * HOUR;
  const closed = buildDashboard(
    new Date(END + 32 * HOUR),
    config,
    {
      events: [
        { machineId: "win-1", groupId: "Work", tokens: 30_000, ts: S + HOUR },
        { machineId: "win-1", groupId: "Work", tokens: 12_000, ts: R + HOUR },
      ],
      groups: [],
      machines: [],
      archivedSegments: [
        { start: S, end: R, official: null, total: 0, groups: {} },
        { start: R, end: END, official: 44, total: 0, groups: {} },
      ],
    },
    [],
    {
      cycle: { start: new Date(S), end: new Date(END) },
      previous: { start: new Date(S - 7 * 24 * HOUR), end: new Date(S) },
    },
  );

  it("marks the reset, and fades a segment that has no figure", () => {
    renderWithIntl(<UsageChart model={closed} view={applySegmentFigures(closed, [null, 44])} subLimits={[]} />);
    expect(screen.getByText("reset")).toBeDefined();
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(1);
    expect(screen.getByText(/every line starts again from 0/)).toBeDefined();
  });

  it("draws every segment plainly when each has its figure", () => {
    renderWithIntl(<UsageChart model={closed} view={applySegmentFigures(closed, [80, 44])} subLimits={[]} />);
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(0);
  });
});

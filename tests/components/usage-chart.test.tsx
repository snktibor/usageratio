import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageChart } from "@/components/usage-chart";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import { applyGroundTruth } from "@/lib/ground-truth";
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

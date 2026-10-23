import { fireEvent, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GroupBreakdown } from "@/components/group-breakdown";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import { applyGroundTruth } from "@/lib/ground-truth";
import { renderWithIntl } from "../helpers/render";

const HOUR = 3_600_000;
const CYCLE_START = Date.parse("2026-09-20T22:00:00Z");
const NOW = new Date("2026-09-23T10:00:00Z");

function report(machineId: string, groupId: string, tokens: number) {
  return { machineId, groupId, tokens, ts: CYCLE_START + 10 * HOUR };
}

function renderBreakdown({ limit = null }: { limit?: number | null } = {}) {
  const base = { ...getConfig({}), tokenMode: "delta" as const };
  const model = buildDashboard(
    NOW,
    limit === null ? { ...base, useTokenLimits: false } : { ...base, useTokenLimits: true, limit },
    {
      events: [report("mac", "Personal", 10_000), report("win-1", "Work", 18_000), report("win-2", "Work", 12_000)],
      groups: [],
      machines: [],
    },
  );
  return renderWithIntl(<GroupBreakdown model={model} view={applyGroundTruth(model, null)} />);
}

const toggleOf = (groupId: string) => screen.getByRole("button", { name: new RegExp(groupId) });
const chartOf = (groupId: string) =>
  screen.queryByRole("group", { name: `Consumption of the machines of the group “${groupId}” over the cycle` });
/** The rows of the table under a group's chart (closed until asked for, hence `hidden`). */
const chartRowsOf = (groupId: string) =>
  within(
    screen.getByRole("table", {
      name: `Consumption of the machines of the group “${groupId}” over the cycle`,
      hidden: true,
    }),
  ).getAllByRole("row", { hidden: true });
/** The key above a group's chart: one entry per machine. */
const keyOf = (groupId: string) =>
  within(document.getElementById(toggleOf(groupId).getAttribute("aria-controls")!)!)
    .getAllByRole("list")[0]!
    .querySelectorAll("li");

// jsdom lays nothing out: the chart needs a size for its day lines to fall on different places.
const SIZE = { clientWidth: 800, clientHeight: 256 } as const;
beforeAll(() => {
  for (const [name, value] of Object.entries(SIZE)) {
    Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
  }
});
afterAll(() => {
  for (const name of Object.keys(SIZE)) Reflect.deleteProperty(HTMLElement.prototype, name);
});

describe("GroupBreakdown", () => {
  it("starts with every group closed", () => {
    renderBreakdown();

    expect(toggleOf("Work").getAttribute("aria-expanded")).toBe("false");
    expect(toggleOf("Personal").getAttribute("aria-expanded")).toBe("false");
    expect(chartOf("Work")).toBeNull();
    expect(chartOf("Personal")).toBeNull();
  });

  it("opens the chart of a group's machines under its row, with each machine's figures in its key", () => {
    renderBreakdown();

    fireEvent.click(toggleOf("Work"));

    expect(toggleOf("Work").getAttribute("aria-expanded")).toBe("true");
    expect(chartOf("Work")).not.toBeNull();
    // Only that group's machines, each with its tokens and its share of the group.
    expect([...keyOf("Work")].map((entry) => entry.textContent)).toEqual(["win-118,00060%", "win-212,00040%"]);
    // The chart's own table has a column per machine, and no other group's.
    const columns = screen.getAllByRole("columnheader", { hidden: true }).map((cell) => cell.textContent);
    expect(columns).toEqual(expect.arrayContaining(["win-1", "win-2"]));
    expect(columns).not.toContain("mac");
  });

  it("draws the machines as shares of the budget, the tokens staying in the key", () => {
    renderBreakdown({ limit: 100_000 });

    fireEvent.click(toggleOf("Work"));

    expect([...keyOf("Work")].map((entry) => entry.textContent)).toEqual(["win-118,00060%", "win-212,00040%"]);
    // The chart's own table ends on each machine's share of the 100k limit.
    const lastRow = chartRowsOf("Work").at(-1)!;
    expect(lastRow.textContent).toContain("18.0%");
    expect(lastRow.textContent).toContain("12.0%");
    expect(lastRow.textContent).not.toContain("18,000");
  });

  it("falls back on tokens while there is no budget to take a share of", () => {
    renderBreakdown();

    fireEvent.click(toggleOf("Work"));

    const lastRow = chartRowsOf("Work").at(-1)!;
    expect(lastRow.textContent).toContain("18,000 token");
    expect(screen.getByText(/without an official percentage/)).toBeTruthy();
  });

  it("opens from anywhere on the row, and closes on a second click", () => {
    renderBreakdown();
    const row = toggleOf("Personal").closest("tr")!;

    fireEvent.click(within(row).getByText("10,000"));
    expect(chartOf("Personal")).not.toBeNull();

    fireEvent.click(within(row).getByText("10,000"));
    expect(chartOf("Personal")).toBeNull();
    expect(toggleOf("Personal").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps one group open at a time: opening another closes the first", () => {
    renderBreakdown();

    fireEvent.click(toggleOf("Work"));
    fireEvent.click(toggleOf("Personal"));

    expect(chartOf("Personal")).not.toBeNull();
    expect(chartOf("Work")).toBeNull();
    expect(toggleOf("Work").getAttribute("aria-expanded")).toBe("false");
    expect(toggleOf("Personal").getAttribute("aria-expanded")).toBe("true");
  });
});

describe("GroupBreakdown — nothing consumed yet", () => {
  // Fixed to Budapest time, independent of DEFAULT_RESET's own (deploy-time) default.
  const config = {
    ...getConfig({}),
    useTokenLimits: false,
    tokenMode: "delta" as const,
    reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
  };
  const before = report("mac", "Personal", 10_000);

  it("says since when: the reset, after a keep reset with no report after it", () => {
    const atMs = CYCLE_START + 20 * HOUR;
    const model = buildDashboard(NOW, config, {
      events: [before],
      groups: [],
      machines: [],
      resets: [
        {
          id: "r20",
          atMs,
          kind: "keep",
          cycleStartMs: CYCLE_START,
          before: 80,
          beforeAtMs: null,
          source: "manual",
          recordedAtMs: atMs,
        },
      ],
    });

    renderWithIntl(<GroupBreakdown model={model} view={applyGroundTruth(model, null)} />);

    expect(screen.getByText(/^No consumption since the reset yet\./)).toBeDefined();
  });

  it("says since the cycle began without a reset", () => {
    const model = buildDashboard(NOW, config, { events: [], groups: [], machines: [] });

    renderWithIntl(<GroupBreakdown model={model} view={applyGroundTruth(model, null)} />);

    expect(screen.getByText(/^No consumption in this cycle yet\./)).toBeDefined();
  });
});

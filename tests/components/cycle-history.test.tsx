import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CycleHistory } from "@/components/cycle-history";
import { getConfig } from "@/lib/config";
import { buildDashboard, type StoreSnapshot } from "@/lib/dashboard";
import type { CycleSummary } from "@/lib/history";
import { renderWithIntl } from "../helpers/render";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-09-23T10:00:00Z");

function snapshot(partial: Partial<StoreSnapshot>): StoreSnapshot {
  return { events: [], groups: [], machines: [], ...partial };
}

function summary(overrides: Partial<CycleSummary> & Pick<CycleSummary, "start" | "end">): CycleSummary {
  return {
    v: 1,
    total: 0,
    limit: null,
    official: null,
    groups: {},
    machines: 0,
    models: {},
    subLimits: {},
    archivedAt: overrides.end,
    ...overrides,
  };
}

describe("CycleHistory", () => {
  it("shows the empty state when nothing has been archived yet", () => {
    const model = buildDashboard(NOW, getConfig({}), snapshot({}));

    renderWithIntl(<CycleHistory model={model} history={[]} />);

    expect(screen.getByRole("heading", { name: "Previous cycles" })).toBeTruthy();
    expect(screen.getByText(/No previous cycle has been archived yet/)).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders one row per archived cycle, its tokens, official percentage and groups", () => {
    const model = buildDashboard(
      NOW,
      getConfig({}),
      snapshot({ events: [{ machineId: "mac", groupId: "Work", tokens: 1000, ts: NOW.getTime() }] }),
    );
    const history: CycleSummary[] = [
      summary({
        start: NOW.getTime() - 7 * DAY,
        end: NOW.getTime(),
        total: 120_000,
        official: 62,
        groups: { Work: 90_000, Personal: 30_000 },
        machines: 3,
      }),
      summary({
        start: NOW.getTime() - 14 * DAY,
        end: NOW.getTime() - 7 * DAY,
        total: 80_000,
        groups: { Work: 80_000 },
        machines: 2,
      }),
    ];

    const { container } = renderWithIntl(<CycleHistory model={model} history={history} />);

    expect(screen.getByRole("heading", { name: "Previous cycles" })).toBeTruthy();
    // The bar chart, keyboard- and screen-reader-accessible like components/cycle-chart.tsx.
    expect(screen.getByRole("group", { name: "Usage of previous cycles" })).toBeTruthy();

    // The compact table is the one not tucked inside the chart's own "as a table" <details>.
    const tables = container.querySelectorAll("table");
    const compactTable = tables[tables.length - 1]!;
    const rows = compactTable.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(2);

    const cellsOf = (row: Element) => row.querySelectorAll("td");
    expect(cellsOf(rows[0]!)[0]?.textContent).toBe("120,000");
    expect(cellsOf(rows[0]!)[1]?.textContent).toBe("62%");
    expect(cellsOf(rows[1]!)[0]?.textContent).toBe("80,000");
    // No official figure for the older cycle: shown as "–", not a stale or zero percentage.
    expect(cellsOf(rows[1]!)[1]?.textContent).toBe("–");
  });
});

import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CycleHistory } from "@/components/cycle-history";
import type { CycleSummary } from "@/lib/history";
import { renderWithIntl } from "../helpers/render";

// The rows are next-intl links; outside a Next app they only need a router to exist.
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en",
  useParams: () => ({ locale: "en" }),
}));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const END = Date.parse("2026-09-21T00:00:00Z");

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

const NEWER = summary({
  start: END - 7 * DAY,
  end: END,
  total: 120_000,
  official: 62,
  groups: { Work: 90_000, Personal: 30_000 },
  machines: 3,
});
const OLDER = summary({
  start: END - 14 * DAY,
  end: END - 7 * DAY,
  total: 80_000,
  groups: { Work: 80_000 },
  machines: 2,
});

function renderHistory(history: CycleSummary[], extra: Partial<Parameters<typeof CycleHistory>[0]> = {}) {
  return renderWithIntl(
    <CycleHistory
      history={history}
      timeZone="Europe/Budapest"
      groupColors={{ Work: "#3987e5", Personal: "#d95926" }}
      kinds={{}}
      selectedStartMs={null}
      {...extra}
    />,
  );
}

describe("CycleHistory", () => {
  it("shows the empty state when nothing has been archived yet", () => {
    renderHistory([]);
    expect(screen.getByRole("heading", { name: "Previous cycles" })).toBeTruthy();
    expect(screen.getByText(/No previous cycle has been archived yet/)).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("does not draw a chart for a single cycle: one column compares nothing", () => {
    renderHistory([NEWER]);
    expect(screen.queryByRole("group", { name: "Usage of previous cycles" })).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });

  it("lists every cycle as a link to its own view, with its final usage, tokens and group shares", () => {
    renderHistory([NEWER, OLDER]);
    // Two cycles to compare: the chart is there, keyboard- and screen-reader-accessible.
    expect(screen.getByRole("group", { name: "Usage of previous cycles" })).toBeTruthy();

    const [newer, older] = screen.getAllByRole("listitem");
    const newerLink = within(newer!).getByRole("link");
    expect(newerLink.getAttribute("href")).toBe(`/en?cycle=${NEWER.start}`);
    expect(newerLink.textContent).toContain("62.0%");
    expect(newerLink.textContent).toContain("official");
    expect(newerLink.textContent).toContain("120,000 tokens measured · 3 machines");
    // The groups' shares are written out, not only drawn: of the quota (62% split 3:1), and of the tokens.
    expect(newerLink.textContent).toContain("Work47% of quota · 75% of tokens");
    expect(newerLink.textContent).toContain("Personal16% of quota · 25% of tokens");

    // No official figure and no token limit for the older cycle: said so, not a stale or zero percentage.
    const olderLink = within(older!).getByRole("link");
    expect(olderLink.textContent).toContain("–");
    expect(olderLink.textContent).toContain("no official figure");
    // Nothing to split, either: only the group's share of the tokens.
    expect(olderLink.textContent).toContain("Work100%");
    expect(olderLink.textContent).not.toContain("of quota");
  });

  it("marks the cycle on screen, and the ones that only have a summary left", () => {
    renderHistory([NEWER, OLDER], { selectedStartMs: NEWER.start, kinds: { [OLDER.start]: "summary" } });
    const [newer, older] = screen.getAllByRole("listitem");
    expect(within(newer!).getByRole("link").getAttribute("aria-current")).toBe("page");
    expect(within(older!).getByText("summary only")).toBeTruthy();
    expect(within(newer!).queryByText("summary only")).toBeNull();
  });

  it("shows three cycles at a time: the older ones scroll inside the list", () => {
    // jsdom lays nothing out: every row is given a height to measure.
    const rowHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(120);
    const cycles = [0, 1, 2, 3, 4].map((age) =>
      summary({ start: END - (age + 1) * 7 * DAY, end: END - age * 7 * DAY, total: 1_000 }),
    );

    const { unmount } = renderHistory(cycles);
    // Every cycle is still in the list; its box is as tall as the first three.
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.getByRole("list").parentElement?.style.maxHeight).toBe("360px");
    unmount();

    // Three or fewer fit as they are: nothing to scroll, no height imposed.
    renderHistory(cycles.slice(0, 3));
    expect(screen.getByRole("list").parentElement?.style.maxHeight).toBe("");
    rowHeight.mockRestore();
  });

  it("falls back to the share of the token limit when no official figure was recorded", () => {
    renderHistory([summary({ start: END - 7 * DAY, end: END, total: 250_000, limit: 1_000_000 })]);
    const link = screen.getByRole("link");
    expect(link.textContent).toContain("25.0%");
    expect(link.textContent).toContain("of the token limit, measured");
  });

  it("splits the bars between the groups on request, and remembers the choice", () => {
    localStorage.removeItem("usageratio_history_view");
    const { unmount } = renderHistory([NEWER, OLDER]);
    const total = screen.getByRole("radio", { name: "Total" }) as HTMLInputElement;
    expect(total.checked).toBe(true);
    // The table follows the chart: one column per group once the bars are split.
    expect(screen.queryByRole("columnheader", { name: "Work" })).toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "By group" }));
    expect((screen.getByRole("radio", { name: "By group" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Each bar is split between the groups/)).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Work" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Personal" })).toBeTruthy();
    const newerRow = screen.getAllByRole("row").find((row) => row.textContent?.includes("62%"))!;
    expect(
      within(newerRow)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["47%", "16%", "62%"]);
    expect(localStorage.getItem("usageratio_history_view")).toBe("groups");
    unmount();

    // Another cycle opened: still split.
    renderHistory([NEWER, OLDER]);
    expect((screen.getByRole("radio", { name: "By group" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Total" }));
    expect(localStorage.getItem("usageratio_history_view")).toBe("total");
  });

  it("writes a cycle with keep resets as the sum of its segments, and marks one a reset cut short", () => {
    const segmented = summary({
      start: END - 7 * DAY,
      end: END,
      total: 1_000,
      official: 124,
      groups: { Work: 600, Personal: 400 },
      machines: 2,
      segments: [
        { start: END - 7 * DAY, end: END - 4 * DAY, official: 80, total: 500, groups: { Work: 500 } },
        { start: END - 4 * DAY, end: END, official: 44, total: 500, groups: { Work: 100, Personal: 400 } },
      ],
    });
    const cut = summary({ start: END - 14 * DAY, end: END - 9 * DAY, total: 500, official: 70, endedByReset: true });
    renderHistory([segmented, cut]);

    const [first, second] = screen.getAllByRole("listitem");
    const link = within(first!).getByRole("link");
    expect(link.textContent).toContain("124%");
    expect(link.textContent).toContain("(80% + 44%)");
    // Each segment's figure split by that segment's tokens: Work 80% + 8.8%, Personal 35.2%.
    expect(link.textContent).toContain("Work89% of quota · 60% of tokens");
    expect(link.textContent).toContain("Personal35% of quota · 40% of tokens");
    expect(within(first!).queryByText("ended by a reset")).toBeNull();
    expect(within(second!).getByText("ended by a reset")).toBeTruthy();
  });

  it("stacks a segmented cycle's bar by each segment's own split", () => {
    localStorage.removeItem("usageratio_history_view");
    const segmented = summary({
      start: END - 7 * DAY,
      end: END,
      total: 1_000,
      official: 124,
      groups: { Work: 600, Personal: 400 },
      segments: [
        { start: END - 7 * DAY, end: END - 4 * DAY, official: 80, total: 500, groups: { Work: 500 } },
        { start: END - 4 * DAY, end: END, official: 44, total: 500, groups: { Work: 100, Personal: 400 } },
      ],
    });
    renderHistory([segmented, OLDER]);
    fireEvent.click(screen.getByRole("radio", { name: "By group" }));
    const table = screen.getByRole("table");
    const row = within(table)
      .getAllByRole("row")
      .find((tr) => tr.textContent?.includes("124%"))!;
    expect(row.textContent).toContain("89%");
    expect(row.textContent).toContain("35%");
  });
});

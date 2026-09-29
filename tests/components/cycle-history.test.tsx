import { screen, within } from "@testing-library/react";
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
    // The groups' shares are written out, not only drawn.
    expect(newerLink.textContent).toContain("Work75%");
    expect(newerLink.textContent).toContain("Personal25%");

    // No official figure and no token limit for the older cycle: said so, not a stale or zero percentage.
    const olderLink = within(older!).getByRole("link");
    expect(olderLink.textContent).toContain("–");
    expect(olderLink.textContent).toContain("no official figure");
  });

  it("marks the cycle on screen, and the ones that only have a summary left", () => {
    renderHistory([NEWER, OLDER], { selectedStartMs: NEWER.start, kinds: { [OLDER.start]: "summary" } });
    const [newer, older] = screen.getAllByRole("listitem");
    expect(within(newer!).getByRole("link").getAttribute("aria-current")).toBe("page");
    expect(within(older!).getByText("summary only")).toBeTruthy();
    expect(within(newer!).queryByText("summary only")).toBeNull();
  });

  it("falls back to the share of the token limit when no official figure was recorded", () => {
    renderHistory([summary({ start: END - 7 * DAY, end: END, total: 250_000, limit: 1_000_000 })]);
    const link = screen.getByRole("link");
    expect(link.textContent).toContain("25.0%");
    expect(link.textContent).toContain("of the token limit, measured");
  });
});

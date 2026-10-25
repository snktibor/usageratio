import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AllTimeGroups } from "@/components/all-time-groups";
import type { AllTimeSummary } from "@/lib/all-time";
import { renderWithIntl } from "../helpers/render";

const SINCE = Date.parse("2026-04-06T00:00:00Z");
const COLORS = { Work: "#3987e5", Home: "#d95926", CI: "#4caf50", Lab: "#9c27b0" };

function summary(overrides: Partial<AllTimeSummary> = {}): AllTimeSummary {
  return {
    sinceMs: SINCE,
    cycles: 3,
    quotaCycles: 2,
    total: 1000,
    quota: 1.5,
    includesCurrent: true,
    groups: [
      { groupId: "Work", tokens: 500, share: 0.5, cycles: 3, quota: 0.9 },
      { groupId: "Home", tokens: 250, share: 0.25, cycles: 2, quota: 0.4 },
      { groupId: "CI", tokens: 150, share: 0.15, cycles: 2, quota: 0.2 },
      { groupId: "Old", tokens: 100, share: 0.1, cycles: 1, quota: null },
    ],
    ...overrides,
  };
}

function renderAllTime(value: AllTimeSummary | null) {
  return renderWithIntl(<AllTimeGroups summary={value} timeZone="Europe/Budapest" groupColors={COLORS} />);
}

describe("AllTimeGroups", () => {
  it("shows nothing without usage, or with nothing but the current cycle to add up", () => {
    expect(renderAllTime(null).container.innerHTML).toBe("");
    expect(renderAllTime(summary({ cycles: 1 })).container.innerHTML).toBe("");
  });

  it("starts closed, naming the span and the heaviest groups' shares, and counting the rest", () => {
    const { container } = renderAllTime(summary());
    expect(screen.getByRole("heading", { name: "All time" })).toBeTruthy();
    expect(
      screen.getByText("Since Apr 6, 2026 · 3 cycles, the current one so far included · 1,000 tokens"),
    ).toBeTruthy();
    expect(container.querySelector("details")?.open).toBe(false);
    const toggle = container.querySelector("summary")!;
    expect(within(toggle).getByText("Work")).toBeTruthy();
    expect(within(toggle).getByText("50%")).toBeTruthy();
    expect(within(toggle).queryByText("Old (no longer exists)")).toBeNull();
    expect(within(toggle).getByText("+1 more")).toBeTruthy();
  });

  it("opened, lists every group with its tokens, quotas used and cycles, a gone group marked", () => {
    const { container } = renderAllTime(summary());
    fireEvent.click(screen.getByText("Details"));
    expect(container.querySelector("details")?.open).toBe(true);
    const rows = within(screen.getByRole("table")).getAllByRole("row");
    // The header, then one row per group, heaviest first.
    expect(rows).toHaveLength(5);
    expect(within(rows[1]!).getByRole("rowheader").textContent).toContain("Work");
    expect(rows[1]!.textContent).toContain("0.9×");
    expect(within(rows[4]!).getByRole("rowheader").textContent).toContain("Old (no longer exists)");
    expect(rows[4]!.textContent).toContain("–");
    expect(screen.getByText(/1\.5× in all/).textContent).toContain("Only 2 of the 3 cycles have one.");
  });

  it("has no quota column while no cycle's final usage is known", () => {
    renderAllTime(summary({ quota: null, quotaCycles: 0, includesCurrent: false }));
    expect(screen.getByText("Since Apr 6, 2026 · 3 cycles · 1,000 tokens")).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Quotas used", hidden: true })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Cycles", hidden: true })).toBeTruthy();
  });
});

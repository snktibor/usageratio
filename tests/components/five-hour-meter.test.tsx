import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FiveHourMeter } from "@/components/five-hour-meter";
import { renderWithIntl } from "../helpers/render";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-25T12:00:00Z");

describe("FiveHourMeter", () => {
  it("shows what is used, the time gone and left, and when the window's pace runs out", () => {
    // Two of the five hours gone at half used: it runs out at 14:00, an hour before the 15:00 reset.
    const reading = { usedPercent: 50, resetsAtMs: NOW + 3 * HOUR, observedAtMs: NOW };
    renderWithIntl(<FiveHourMeter reading={reading} generatedAt={NOW} timeZone="UTC" />);

    expect(screen.getByRole("heading", { name: /5-hour window/ }).textContent).toContain("50.0%");
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText("Resets at", { exact: false }).parentElement?.textContent).toContain("15:00");
    expect(screen.getAllByText("3 hours left")).toHaveLength(2);
    expect(screen.getByText("Time gone by:", { exact: false }).parentElement?.textContent).toContain("40%");
    expect(screen.getByText("At this pace it runs out at 14:00")).toBeTruthy();
  });

  it("says when no window is running, and when an old reading was taken", () => {
    const reading = { usedPercent: 70, resetsAtMs: NOW - 60_000, observedAtMs: NOW - 2 * HOUR };
    renderWithIntl(<FiveHourMeter reading={reading} generatedAt={NOW} timeZone="UTC" />);

    expect(screen.getByText("No window running: the next request starts one")).toBeTruthy();
    expect(screen.getByText("read at 10:00", { exact: false })).toBeTruthy();
    expect(screen.queryByText("Resets at", { exact: false })).toBeNull();
  });
});

import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GroundTruthInput } from "@/components/ground-truth-input";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import { applyGroundTruth } from "@/lib/ground-truth";
import { renderWithIntl } from "../helpers/render";

const NOW = new Date("2026-09-23T10:00:00Z");

/** An official reading over a model that has measured nothing yet. */
function renderField(
  since: "reset" | "cycle",
  fold: { collapsed?: boolean; onCollapsedChange?: (collapsed: boolean) => void } = {},
) {
  const model = buildDashboard(NOW, getConfig({}), { events: [], groups: [], machines: [] });
  renderWithIntl(
    <GroundTruthInput
      raw="40"
      onChange={vi.fn()}
      invalid={false}
      enteredAt={null}
      status={{ status: "idle", problem: null }}
      view={applyGroundTruth(model, { percent: 40, atMs: null })}
      timeZone={model.timeZone}
      providerId="claude"
      providerLabel="Claude"
      providers={[{ id: "claude", label: "Claude" }]}
      onProviderChange={vi.fn()}
      since={since}
      {...fold}
    >
      <p>sub-limits</p>
    </GroundTruthInput>,
  );
}

describe("GroundTruthInput — no consumption measured yet", () => {
  it("says since the reset after a keep reset", () => {
    renderField("reset");
    expect(screen.getByText(/^Machines have not measured any consumption since the reset yet, /)).toBeDefined();
  });

  it("says in this cycle without a reset", () => {
    renderField("cycle");
    expect(screen.getByText(/^Machines have not measured any consumption in this cycle yet, /)).toBeDefined();
  });
});

describe("GroundTruthInput — folding", () => {
  it("folds to its header: the title, the figure and the account picker", () => {
    const onCollapsedChange = vi.fn();
    renderField("cycle", { collapsed: true, onCollapsedChange });
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByText("sub-limits")).toBeNull();
    expect(screen.getByText("40.0%")).toBeDefined();
    expect(screen.getByRole("combobox")).toBeDefined();
    const unfold = screen.getByRole("button", { name: "Unfold the card" });
    expect(unfold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(unfold);
    expect(onCollapsedChange).toHaveBeenCalledWith(false);
  });

  it("unfolded, shows the field and everything under it, with a button to fold it", () => {
    const onCollapsedChange = vi.fn();
    renderField("cycle", { collapsed: false, onCollapsedChange });
    expect(screen.getByRole("slider")).toBeDefined();
    expect(screen.getByText("sub-limits")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Fold the card" }));
    expect(onCollapsedChange).toHaveBeenCalledWith(true);
  });

  it("has no fold button unless asked to", () => {
    renderField("cycle");
    expect(screen.queryByRole("button", { name: /the card/ })).toBeNull();
  });
});

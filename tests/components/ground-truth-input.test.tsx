import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GroundTruthInput } from "@/components/ground-truth-input";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import { applyGroundTruth } from "@/lib/ground-truth";
import { renderWithIntl } from "../helpers/render";

const NOW = new Date("2026-09-23T10:00:00Z");

/** An official reading over a model that has measured nothing yet. */
function renderField(since: "reset" | "cycle") {
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
    />,
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

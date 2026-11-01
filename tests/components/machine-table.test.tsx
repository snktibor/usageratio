import { describe, expect, it } from "vitest";
import { MachineTable } from "@/components/machine-table";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import { applyGroundTruth } from "@/lib/ground-truth";
import { renderWithIntl } from "../helpers/render";

const HOUR = 3_600_000;
const config = { ...getConfig({}), reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" } };

// Wednesday 12:00 Budapest time; the weekly cycle started Monday 00:00.
const NOW = new Date("2026-09-23T10:00:00Z");
const CYCLE_START = Date.parse("2026-09-20T22:00:00Z");

const known = (machineId: string, lastSeenAt: number) => ({ machineId, groupId: "Work", lastSeenAt, lastTokens: 0 });

function renderTable(machines: ReturnType<typeof known>[], events: { machineId: string; tokens: number }[] = []) {
  const model = buildDashboard(NOW, config, {
    events: events.map((event) => ({ ...event, groupId: "Work", ts: CYCLE_START + HOUR })),
    groups: [],
    machines,
  });
  return renderWithIntl(<MachineTable model={model} view={applyGroundTruth(model, null)} />);
}

describe("MachineTable", () => {
  it("lists only the machines that reported in the cycle, with or without usage", () => {
    const { container } = renderTable(
      [known("busy", CYCLE_START + HOUR), known("idle", CYCLE_START + HOUR), known("gone", CYCLE_START - HOUR)],
      [{ machineId: "busy", tokens: 300 }],
    );

    const rows = [...container.querySelectorAll("tbody th")].map((cell) => cell.textContent);
    expect(rows).toEqual(["busy", "idle"]);
    expect(container.textContent).not.toContain("gone");
  });

  it("leaves the section out while no machine has reported in the cycle", () => {
    const { container } = renderTable([known("gone", CYCLE_START - HOUR)]);

    expect(container.innerHTML).toBe("");
  });
});

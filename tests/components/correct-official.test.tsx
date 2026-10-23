import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArchivedCycleView } from "@/components/archived-cycle-view";
import { DashboardView } from "@/components/dashboard-view";
import { getConfig } from "@/lib/config";
import { buildProviderDashboards } from "@/lib/dashboard";
import type { CycleSummary } from "@/lib/history";
import { renderWithIntl } from "../helpers/render";

const refresh = vi.fn();
vi.mock("@/i18n/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/i18n/routing")>()),
  useRouter: () => ({ push: vi.fn(), refresh }),
}));

const START = Date.parse("2026-09-28T00:00:00Z");
const END = Date.parse("2026-10-05T00:00:00Z");
const historyContext = { groupColors: {}, kinds: {} } as never;

/** The PUTs sent so far: path and parsed body. */
function sent(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([path, init]) => ({ path, body: JSON.parse((init as RequestInit).body as string) }));
}

describe("correcting a finished cycle's official percentage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers();
    refresh.mockClear();
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("in the full view: shows the archived figure, and a correction goes to the archive", async () => {
    const providers = buildProviderDashboards(
      new Date("2026-10-08T12:00:00Z"),
      getConfig({}),
      ["claude"],
      { eventsByProvider: {}, groups: [], machines: [] },
      new Map([["claude", { raw: "82", enteredAt: END }]]),
      {
        cycle: { start: new Date(START), end: new Date(END) },
        previous: { start: new Date(START - 7 * 86_400_000), end: new Date(START) },
      },
    );
    renderWithIntl(
      <DashboardView providers={providers} historyByProvider={{}} historyContext={historyContext} pastCycle />,
    );

    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    const field = screen.getByRole("textbox", { name: "Official consumption at the end of the cycle" });
    expect((field as HTMLInputElement).value).toBe("82");

    fireEvent.change(field, { target: { value: "100" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sent(fetchMock)).toEqual([
      { path: "/api/official-usage/archived", body: { providerId: "claude", raw: "100", cycleStartMs: START } },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("in the summary-only view: the same correction, from the summary's own figure", async () => {
    const summary: CycleSummary = {
      v: 1,
      start: START,
      end: END,
      total: 1_000,
      limit: null,
      official: 82,
      groups: {},
      machines: 1,
      models: {},
      subLimits: {},
      archivedAt: END,
    };
    renderWithIntl(
      <ArchivedCycleView
        summaries={[{ id: "claude", label: "Claude", summary }]}
        historyByProvider={{ claude: [summary] }}
        historyContext={historyContext}
        timeZone="Europe/Budapest"
        selectedStartMs={START}
        pastCycle
        costEstimate={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Official consumption at the end of the cycle" }), {
      target: { value: "100" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sent(fetchMock)).toEqual([
      { path: "/api/official-usage/archived", body: { providerId: "claude", raw: "100", cycleStartMs: START } },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("100%")).toBeDefined();
  });

  it("in the summary-only view: a cycle with keep resets shows the sum, and corrects one segment", async () => {
    const MID = START + 3 * 86_400_000;
    const summary: CycleSummary = {
      v: 1,
      start: START,
      end: END,
      total: 1_000,
      limit: null,
      official: 100,
      groups: {},
      machines: 1,
      models: {},
      subLimits: {},
      archivedAt: END,
      segments: [
        { start: START, end: MID, official: 80, total: 500, groups: {} },
        { start: MID, end: END, official: 20, total: 500, groups: {} },
      ],
    };
    renderWithIntl(
      <ArchivedCycleView
        summaries={[{ id: "claude", label: "Claude", summary }]}
        historyByProvider={{ claude: [summary] }}
        historyContext={historyContext}
        timeZone="Europe/Budapest"
        selectedStartMs={START}
        pastCycle
        costEstimate={false}
      />,
    );

    expect(screen.getAllByText("100%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("(80% + 20%)").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    const fields = screen.getAllByRole("textbox", { name: /Official percentage/ });
    expect(fields.map((field) => (field as HTMLInputElement).value)).toEqual(["80", "20"]);

    fireEvent.change(fields[1]!, { target: { value: "44" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sent(fetchMock)).toEqual([
      {
        path: "/api/official-usage/archived",
        body: { providerId: "claude", raw: "44", cycleStartMs: START, segmentStartMs: MID },
      },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Back to the figure: the sum follows the corrected segment.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("124%")).toBeDefined();
    expect(screen.getAllByText("(80% + 44%)").length).toBeGreaterThan(0);
  });
});

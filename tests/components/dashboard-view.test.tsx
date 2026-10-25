import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "@/components/dashboard-view";
import { getConfig } from "@/lib/config";
import { buildProviderDashboards } from "@/lib/dashboard";
import { officialUsageField } from "@/lib/official-usage";
import { renderWithIntl } from "../helpers/render";

const push = vi.fn();
const refresh = vi.fn();
vi.mock("@/i18n/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/i18n/routing")>()),
  useRouter: () => ({ push, refresh }),
}));

const providers = buildProviderDashboards(new Date("2026-09-23T12:00:00Z"), getConfig({}), ["claude", "openai"], {
  eventsByProvider: {},
  groups: [],
  machines: [],
});
const historyContext = { groupColors: {}, kinds: {}, allTimeByProvider: {} } as never;

function renderView(pastCycle: boolean) {
  renderWithIntl(
    <DashboardView
      providers={providers}
      historyByProvider={{}}
      historyContext={historyContext}
      pastCycle={pastCycle}
    />,
  );
}

/** The provider picker's value, looked up afresh: a provider switch remounts the view. */
function currentSelect() {
  const values = screen.getAllByRole("combobox").map((el) => (el as HTMLSelectElement).value);
  return values.find((value) => value === "claude" || value === "openai");
}

describe("DashboardView — switching provider", () => {
  beforeEach(() => push.mockClear());

  it("on a past cycle shows the chosen provider and goes back to the current cycle", () => {
    renderView(true);
    const select = screen.getAllByRole("combobox").find((el) => (el as HTMLSelectElement).value === "claude");
    expect(select).toBeDefined();
    fireEvent.change(select!, { target: { value: "openai" } });
    expect(push).toHaveBeenCalledWith("/");
    expect(currentSelect()).toBe("openai");
  });

  it("on the current cycle just switches in place", () => {
    renderView(false);
    const select = screen.getAllByRole("combobox").find((el) => (el as HTMLSelectElement).value === "claude")!;
    fireEvent.change(select, { target: { value: "openai" } });
    expect(push).not.toHaveBeenCalled();
    expect(currentSelect()).toBe("openai");
  });
});

describe("DashboardView — the official figure's tag", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("tags a typed figure with the start of the current segment", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, enteredAt: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date("2026-09-23T12:00:00Z");
    const store = { eventsByProvider: {}, groups: [], machines: [] };
    const cycleStartMs = buildProviderDashboards(now, getConfig({}), ["claude"], store)[0]!.dashboard.cycle.startMs;
    // Half way between the cycle's start and now, on a whole minute: whatever the default reset is.
    const R = cycleStartMs + Math.floor((now.getTime() - cycleStartMs) / 2 / 60_000) * 60_000;
    const [claude] = buildProviderDashboards(now, getConfig({}), ["claude"], {
      ...store,
      resets: {
        claude: {
          v: 1,
          events: [
            {
              id: "k",
              atMs: R,
              kind: "keep",
              cycleStartMs,
              before: 80,
              beforeAtMs: null,
              source: "manual",
              recordedAtMs: R,
            },
          ],
          autoOffCycleStartMs: null,
        },
      },
    });

    renderWithIntl(
      <DashboardView providers={[claude!]} historyByProvider={{}} historyContext={historyContext} pastCycle={false} />,
    );
    fireEvent.change(screen.getByLabelText("Current official consumption"), { target: { value: "12" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/official-usage");
    expect(JSON.parse(init.body as string)).toMatchObject({ providerId: "claude", raw: "12", cycleStartMs: R });
  });
});

describe("DashboardView — 'Was there a reset?'", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks once a figure typed below 10% has been saved, and not for one at 10% or above", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, enteredAt: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date("2026-09-23T12:00:00Z");
    const [claude] = buildProviderDashboards(
      now,
      getConfig({}),
      ["claude"],
      { eventsByProvider: {}, groups: [], machines: [] },
      new Map([[officialUsageField("claude", null), { raw: "62", enteredAt: now.getTime() - 3_600_000 }]]),
    );
    renderWithIntl(
      <DashboardView providers={[claude!]} historyByProvider={{}} historyContext={historyContext} pastCycle={false} />,
    );
    const field = screen.getByLabelText("Current official consumption");
    const question = () => screen.queryByRole("button", { name: "Yes, record a reset" });

    fireEvent.change(field, { target: { value: "8" } });
    // Not while the figure is being saved (the save goes out 600 ms after the last change).
    expect(question()).toBeNull();
    expect(await screen.findByRole("button", { name: "Yes, record a reset" }, { timeout: 2_000 })).toBeDefined();
    expect(screen.getByText(/stood at 62% before this change/)).toBeDefined();

    fireEvent.change(field, { target: { value: "12" } });
    expect(question()).toBeNull();
    // Its save goes out too: nothing is left pending for the next test.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(question()).toBeNull();
  });

  it("never carries a finished cycle's correction into the current cycle's question", async () => {
    refresh.mockClear();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date("2026-10-08T12:00:00Z");
    const store = { eventsByProvider: {}, groups: [], machines: [] };
    const start = Date.parse("2026-09-28T00:00:00Z");
    const end = Date.parse("2026-10-05T00:00:00Z");
    const [finished] = buildProviderDashboards(
      now,
      getConfig({}),
      ["claude"],
      store,
      new Map([["claude", { raw: "82", enteredAt: end }]]),
      {
        cycle: { start: new Date(start), end: new Date(end) },
        previous: { start: new Date(start - 7 * 86_400_000), end: new Date(start) },
      },
    );
    const [current] = buildProviderDashboards(
      now,
      getConfig({}),
      ["claude"],
      store,
      new Map([["claude", { raw: "3", enteredAt: now.getTime() - 3_600_000 }]]),
    );
    const view = (provider: typeof finished, pastCycle: boolean) => (
      <DashboardView
        providers={[provider!]}
        historyByProvider={{}}
        historyContext={historyContext}
        pastCycle={pastCycle}
      />
    );
    const question = () => screen.queryByRole("button", { name: "Yes, record a reset" });

    const { rerender } = renderWithIntl(view(finished, true));
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    const field = screen.getByRole("textbox", { name: "Official consumption at the end of the cycle" });
    fireEvent.change(field, { target: { value: "8" } });
    // The correction is saved (and the page refreshed); a finished cycle never asks.
    await waitFor(() => expect(refresh).toHaveBeenCalled(), { timeout: 2_000 });
    expect(question()).toBeNull();

    // "Back to the current cycle" keeps the view mounted: its figure is 3, far under the corrected 82.
    rerender(view(current, false));
    await waitFor(() =>
      expect((screen.getByLabelText("Current official consumption") as HTMLInputElement).value).toBe("3"),
    );
    expect(question()).toBeNull();
  });
});

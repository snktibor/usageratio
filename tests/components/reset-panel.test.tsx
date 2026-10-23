import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResetPanel } from "@/components/reset-panel";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import type { ResetEvent } from "@/lib/resets";
import { renderWithIntl } from "../helpers/render";

const refresh = vi.fn();
vi.mock("@/i18n/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/i18n/routing")>()),
  useRouter: () => ({ refresh }),
}));

const HOUR = 3_600_000;
// Wednesday 12:00 Budapest time; the weekly cycle started Monday 00:00 (Sunday 22:00 UTC).
const NOW = new Date("2026-09-23T10:00:00Z");
const S = Date.parse("2026-09-20T22:00:00Z");
// Fixed to Budapest time, independent of DEFAULT_RESET's own (deploy-time) default.
const config = { ...getConfig({}), reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" } };

function reset(id: string, hoursIntoCycle: number, overrides: Partial<ResetEvent> = {}): ResetEvent {
  const atMs = S + hoursIntoCycle * HOUR;
  return {
    id,
    atMs,
    kind: "keep",
    cycleStartMs: S,
    before: 80,
    beforeAtMs: null,
    source: "manual",
    recordedAtMs: atMs,
    ...overrides,
  };
}

function answering(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([path, init]) => ({
    path,
    method: (init as RequestInit).method,
    body: JSON.parse((init as RequestInit).body as string),
  }));
}

/** The official figure 62%, read at 11:00 Budapest time, an hour before now. */
function renderPanel(resets: ResetEvent[] = [], window?: Parameters<typeof buildDashboard>[4]) {
  const model = buildDashboard(NOW, config, { events: [], groups: [], machines: [], resets }, [], window);
  renderWithIntl(
    <ResetPanel
      providerId="claude"
      providerLabel="Claude"
      model={model}
      resetMode="keep"
      entry={{ raw: "62", enteredAt: NOW.getTime() - HOUR }}
    />,
  );
}

describe("ResetPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    refresh.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("records a reset at the moment given, with the stored figure read before it", async () => {
    const fetchMock = answering(200, { ok: true });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "There was a reset…" }));
    expect((screen.getByLabelText(/Used before the reset/) as HTMLInputElement).value).toBe("62");
    // 11:30: the figure was read at 11:00, before it, so it stays.
    fireEvent.change(screen.getByLabelText(/When/), { target: { value: "2026-09-23T11:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sent(fetchMock)).toEqual([
      {
        path: "/api/resets",
        method: "POST",
        body: { providerId: "claude", atMs: Date.parse("2026-09-23T09:30:00Z"), before: 62 },
      },
    ]);
  });

  it("leaves the figure out when it was read after the moment", async () => {
    const fetchMock = answering(200, { ok: true });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "There was a reset…" }));
    fireEvent.change(screen.getByLabelText(/When/), { target: { value: "2026-09-23T10:30" } });
    expect((screen.getByLabelText(/Used before the reset/) as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sent(fetchMock)[0]!.body).toEqual({
      providerId: "claude",
      atMs: Date.parse("2026-09-23T08:30:00Z"),
      before: null,
    });
  });

  it("edits a reset of the list", async () => {
    const fetchMock = answering(200, { ok: true });
    renderPanel([reset("k", 38)]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText(/When/) as HTMLInputElement).value).toBe("2026-09-22T14:00");
    fireEvent.change(screen.getByLabelText(/Used before the reset/), { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sent(fetchMock)).toEqual([
      { path: "/api/resets", method: "PUT", body: { providerId: "claude", id: "k", atMs: S + 38 * HOUR, before: 75 } },
    ]);
  });

  it("deletes a reset recorded by hand, and reverts one the menu bar app detected", async () => {
    const fetchMock = answering(200, { ok: true });
    renderPanel([reset("manual", 20), reset("detected", 38, { source: "report" })]);
    expect(screen.getByText("detected by the menu bar app")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Wrong – revert" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(sent(fetchMock).map((call) => [call.method, call.body])).toEqual([
      ["DELETE", { providerId: "claude", id: "detected", revert: true }],
      ["DELETE", { providerId: "claude", id: "manual" }],
    ]);
  });

  it("lists the resets under the button that records one", () => {
    renderPanel([reset("k", 38)]);
    const button = screen.getByRole("button", { name: "There was a reset…" });
    const heading = screen.getByRole("heading", { name: "Resets in this cycle" });
    expect(button.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("bounds a new or kept reset's moment below by the cycle start, but not a restart's, which may move earlier", () => {
    // The cycle the restart began starts at the restart itself (S), a day after the cycle it cut short began.
    const restart = reset("r", 0, { kind: "restart", cycleStartMs: S - 24 * HOUR, source: "report" });
    renderPanel([restart, reset("k", 38)], {
      cycle: { start: new Date(S), end: new Date(S + 7 * 24 * HOUR) },
      previous: { start: new Date(S - 7 * 24 * HOUR), end: new Date(S) },
    });
    const when = () => screen.getByLabelText(/When/) as HTMLInputElement;
    const [editRestart, editKeep] = screen.getAllByRole("button", { name: "Edit" });
    fireEvent.click(editRestart!);
    expect(when().value).toBe("2026-09-21T00:00");
    expect(when().hasAttribute("min")).toBe(false);
    fireEvent.click(editKeep!);
    expect(when().getAttribute("min")).toBe("2026-09-21T00:01");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "There was a reset…" }));
    expect(when().getAttribute("min")).toBe("2026-09-21T00:01");
  });

  it("says why the server refused", async () => {
    answering(409, { error: "duplicate_reset" });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "There was a reset…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("There is already a reset at that minute.")).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("checks the figure before sending it, and names the reset type with a link to the settings", () => {
    const fetchMock = answering(200, { ok: true });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "There was a reset…" }));
    expect(screen.getByText(/the weekly reset stays/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Change in the settings" }).getAttribute("href")).toContain(
      "/settings#settings-general",
    );
    fireEvent.change(screen.getByLabelText(/Used before the reset/), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/as a number from 0 to 100/)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

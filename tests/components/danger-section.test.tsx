import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftProvider } from "@/components/settings/draft";
import { DangerSection } from "@/components/settings/sections/danger-section";
import { renderWithIntl } from "../helpers/render";

/** Deleting a provider: a plain confirmation without reports, the typed dialog with them (or while unknown). */

const IMPACT = { events: 0, machines: 1, groups: 0, lastReportAt: null, recentMachines: 0 };
const WITH_REPORTS = {
  events: 30,
  machines: 2,
  groups: 2,
  lastReportAt: Date.now() - 5 * 3_600_000,
  recentMachines: 0,
};
const OPENAI: DraftProvider = {
  id: "openai",
  label: "OpenAI",
  models: [],
  visible: false,
  limitText: "",
  savedLimit: 0,
  subLimits: [],
};

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const DRY = "/api/providers/openai?force=1&dryRun=1";

function renderDanger(history = true) {
  const handlers = { onDeleted: vi.fn(), onManaged: vi.fn() };
  renderWithIntl(
    <DangerSection
      titleId="settings"
      providers={[OPENAI]}
      timeZone="Europe/Budapest"
      history={history}
      {...handlers}
    />,
  );
  return handlers;
}

describe("DangerSection history", () => {
  it("shows the history of destructive actions, closed", () => {
    renderDanger();
    expect(screen.getByText("Show the history of deletions and merges")).not.toBeNull();
  });

  it("leaves it out when history is false (a workspace member)", () => {
    renderDanger(false);
    expect(screen.queryByText("Show the history of deletions and merges")).toBeNull();
  });
});

describe("DangerSection provider delete", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("with no stored reports: the simple confirmation, then a DELETE without force", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn(async (url: string) =>
      url === DRY ? answer(200, { ok: true, impact: IMPACT }) : answer(200, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handlers = renderDanger();

    fireEvent.click(screen.getByRole("button", { name: "Delete the “OpenAI” provider" }));
    // The typed dialog holds the place until the count says there is nothing to lose.
    expect(await screen.findByText(/It has no stored reports/)).not.toBeNull();
    expect(screen.queryByLabelText("Name to confirm the deletion")).toBeNull();
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(handlers.onDeleted).toHaveBeenCalledWith("openai"));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/providers/openai", { method: "DELETE" });
    expect(handlers.onManaged).toHaveBeenCalled();
  });

  it("with stored reports: the typed dialog, then a DELETE with force", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === DRY ? answer(200, { ok: true, impact: WITH_REPORTS }) : answer(200, { ok: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const handlers = renderDanger();

    fireEvent.click(screen.getByRole("button", { name: "Delete the “OpenAI” provider" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("30 stored reports · 2 machines · last report 5 hours ago")).not.toBeNull();
    const confirm = within(dialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Name to confirm the deletion"), { target: { value: "openai" } });
    fireEvent.click(confirm);

    await waitFor(() => expect(handlers.onDeleted).toHaveBeenCalledWith("openai"));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/providers/openai?force=1", { method: "DELETE" });
  });

  it("when the count fails: the typed dialog with the problem line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(500, { error: "server_error" })),
    );
    renderDanger();

    fireEvent.click(screen.getByRole("button", { name: "Delete the “OpenAI” provider" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("What this deletes could not be counted.")).not.toBeNull();
    expect(within(dialog).getByLabelText("Name to confirm the deletion")).not.toBeNull();
  });

  it("falls back to the typed dialog when a plain delete answers provider_has_events", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === DRY) return answer(200, { ok: true, impact: IMPACT });
      if (init?.method === "DELETE" && url === "/api/providers/openai") {
        return answer(409, { error: "provider_has_events" });
      }
      return answer(200, { ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDanger();

    fireEvent.click(screen.getByRole("button", { name: "Delete the “OpenAI” provider" }));
    await screen.findByText(/It has no stored reports/);
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes" }));

    expect(await screen.findByLabelText("Name to confirm the deletion")).not.toBeNull();
  });

  it("asks for the PIN when the delete answers sudo_required", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === DRY) return answer(200, { ok: true, impact: WITH_REPORTS });
      if (url === "/api/auth/sudo" && !init?.method) return answer(200, { mode: "pin", numeric: true });
      return answer(403, { error: "sudo_required" });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDanger();

    fireEvent.click(screen.getByRole("button", { name: "Delete the “OpenAI” provider" }));
    const dialog = await screen.findByRole("alertdialog");
    await within(dialog).findByText(/^30 stored reports/);
    fireEvent.change(within(dialog).getByLabelText("Name to confirm the deletion"), { target: { value: "openai" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("button", { name: /^Unlock/ })).not.toBeNull();
  });

  it("retries the delete once the PIN is accepted", async () => {
    let unlocked = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === DRY) return answer(200, { ok: true, impact: WITH_REPORTS });
      if (url === "/api/auth/sudo" && init?.method === "POST") {
        unlocked = true;
        return new Response(null, { status: 204 });
      }
      if (url === "/api/auth/sudo") return answer(200, { mode: "pin", numeric: true });
      return unlocked ? answer(200, { ok: true }) : answer(403, { error: "sudo_required" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const handlers = renderDanger();

    fireEvent.click(screen.getByRole("button", { name: "Delete the “OpenAI” provider" }));
    const dialog = await screen.findByRole("alertdialog");
    await within(dialog).findByText(/^30 stored reports/);
    fireEvent.change(within(dialog).getByLabelText("Name to confirm the deletion"), { target: { value: "openai" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    const unlock = await screen.findByRole("button", { name: /^Unlock/ });
    fireEvent.change(document.getElementById("sudo-pin") as HTMLInputElement, { target: { value: "12345" } });
    fireEvent.click(unlock);

    await waitFor(() => expect(handlers.onDeleted).toHaveBeenCalledWith("openai"));
    expect(fetchMock).toHaveBeenLastCalledWith("/api/providers/openai?force=1", { method: "DELETE" });
    expect(await screen.findByText("Deleted “OpenAI”.")).not.toBeNull();
  });

  it("shows the problem line when the delete fails otherwise", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === DRY ? answer(200, { ok: true, impact: WITH_REPORTS }) : answer(500, { error: "server_error" }),
      ),
    );
    const handlers = renderDanger();

    fireEvent.click(screen.getByRole("button", { name: "Delete the “OpenAI” provider" }));
    const dialog = await screen.findByRole("alertdialog");
    await within(dialog).findByText(/^30 stored reports/);
    fireEvent.change(within(dialog).getByLabelText("Name to confirm the deletion"), { target: { value: "openai" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("That did not work. Try again in a moment.")).not.toBeNull();
    expect(handlers.onDeleted).not.toHaveBeenCalled();
  });
});

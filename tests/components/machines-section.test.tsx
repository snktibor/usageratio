import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftGroup } from "@/components/settings/draft";
import { MachinesSection } from "@/components/settings/sections/machines-section";
import { renderWithIntl } from "../helpers/render";

const GROUPS: DraftGroup[] = [
  { id: "Personal", color: "#3987e5", colorText: "#3987e5", hasReports: true, excluded: [] },
];

const MACHINE = {
  providerId: "claude",
  machineId: "mac-1",
  groupId: "Personal",
  lastSeenAt: Date.now(),
  lastTokens: 1234,
};

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as Response;
}

function mockFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const response of responses) fn.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("MachinesSection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads and renders the known machines", async () => {
    mockFetch(jsonResponse({ machines: [MACHINE] }));
    renderWithIntl(<MachinesSection titleId="settings" groups={GROUPS} onManaged={vi.fn()} />);

    expect(await screen.findByText("mac-1")).not.toBeNull();
    expect(screen.getByText("Personal")).not.toBeNull();
  });

  it("shows an empty state once loaded with nothing", async () => {
    mockFetch(jsonResponse({ machines: [] }));
    renderWithIntl(<MachinesSection titleId="settings" groups={GROUPS} onManaged={vi.fn()} />);

    expect(await screen.findByText("No machines have reported yet.")).not.toBeNull();
  });

  it("renames a machine: click to edit, Enter commits, PATCH is sent with the new id", async () => {
    const onManaged = vi.fn();
    const fetchMock = mockFetch(
      jsonResponse({ machines: [MACHINE] }),
      jsonResponse({ ok: true, affected: { events: 1, machines: 1, groups: 0 } }),
    );
    renderWithIntl(<MachinesSection titleId="settings" groups={GROUPS} onManaged={onManaged} />);

    const nameButton = await screen.findByText("mac-1");
    fireEvent.click(nameButton);

    const input = screen.getByLabelText(/rename.*mac-1/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "mac-1-renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/machines/claude/mac-1");
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ id: "mac-1-renamed" }),
    });
    expect(await screen.findByText("mac-1-renamed")).not.toBeNull();
    expect(onManaged).toHaveBeenCalled();
  });

  it("Escape cancels an edit without sending a request", async () => {
    const fetchMock = mockFetch(jsonResponse({ machines: [MACHINE] }));
    renderWithIntl(<MachinesSection titleId="settings" groups={GROUPS} onManaged={vi.fn()} />);

    const nameButton = await screen.findByText("mac-1");
    fireEvent.click(nameButton);
    const input = screen.getByDisplayValue("mac-1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "something-else" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByDisplayValue("something-else")).toBeNull();
    expect(await screen.findByText("mac-1")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("delete opens a confirm dialog naming the machine, with the confirm button disabled during the countdown", async () => {
    mockFetch(jsonResponse({ machines: [MACHINE] }));
    renderWithIntl(<MachinesSection titleId="settings" groups={GROUPS} onManaged={vi.fn()} />);

    await screen.findByText("mac-1");
    fireEvent.click(screen.getByLabelText(/delete.*mac-1/i));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete this machine?")).not.toBeNull();
    expect(within(dialog).getByText(/mac-1/)).not.toBeNull();
    const confirmButton = within(dialog).getByRole("button", { name: /yes/i });
    expect(confirmButton).toHaveProperty("disabled", true);
  });
});

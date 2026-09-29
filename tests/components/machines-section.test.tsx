import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftGroup } from "@/components/settings/draft";
import { MachinesSection } from "@/components/settings/sections/machines-section";
import { renderWithIntl } from "../helpers/render";

const GROUPS: DraftGroup[] = [
  { id: "Personal", color: "#3987e5", colorText: "#3987e5", hasReports: true, excluded: [] },
];

const TWO_GROUPS: DraftGroup[] = [
  ...GROUPS,
  { id: "Work", color: "#e5a139", colorText: "#e5a139", hasReports: true, excluded: [] },
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

  it("lists a machine once, with a tag per provider it reports for", async () => {
    mockFetch(jsonResponse({ machines: [MACHINE, { ...MACHINE, providerId: "openai" }] }));
    renderWithIntl(<MachinesSection titleId="settings" groups={GROUPS} onManaged={vi.fn()} />);

    expect(await screen.findAllByText("mac-1")).toHaveLength(1);
    const tags = screen.getByRole("list", { name: "Providers it reports for" });
    expect(
      within(tags)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Claude", "OpenAI"]);
  });

  it("renames every provider's entry of the machine", async () => {
    const onManaged = vi.fn();
    const onMachineIds = vi.fn();
    const fetchMock = mockFetch(
      jsonResponse({ machines: [MACHINE, { ...MACHINE, providerId: "openai" }] }),
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    );
    renderWithIntl(
      <MachinesSection titleId="settings" groups={GROUPS} onManaged={onManaged} onMachineIds={onMachineIds} />,
    );

    fireEvent.click(await screen.findByText("mac-1"));
    expect(onMachineIds).toHaveBeenLastCalledWith(["mac-1"]);
    const input = screen.getByLabelText(/rename.*mac-1/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "studio" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByText("studio")).not.toBeNull();
    expect(onMachineIds).toHaveBeenLastCalledWith(["studio"]);
    expect(fetchMock.mock.calls.slice(1).map((call) => [call[0], call[1].method])).toEqual([
      ["/api/machines/claude/mac-1", "PATCH"],
      ["/api/machines/openai/mac-1", "PATCH"],
    ]);
    expect(onManaged).toHaveBeenCalled();
  });

  it("offers a merge for a rename onto another machine's name, and merges every entry once confirmed", async () => {
    const onManaged = vi.fn();
    const fetchMock = mockFetch(
      jsonResponse({
        machines: [
          { ...MACHINE, groupId: "Personal" },
          { ...MACHINE, providerId: "openai", groupId: "Personal" },
          { ...MACHINE, providerId: "openai", machineId: "pc", groupId: "Work" },
        ],
      }),
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
      jsonResponse({ machines: [{ ...MACHINE, machineId: "pc", groupId: "Work" }] }),
    );
    renderWithIntl(<MachinesSection titleId="settings" groups={TWO_GROUPS} onManaged={onManaged} />);

    fireEvent.click(await screen.findByText("mac-1"));
    const input = screen.getByLabelText(/rename.*mac-1/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "pc" } });
    fireEvent.keyDown(input, { key: "Enter" });

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Merge “mac-1” into “pc”?")).not.toBeNull();
    expect(within(dialog).getByText(/move under “pc” \(Work\)/)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const confirmButton = within(dialog).getByRole("button", { name: /yes/i });
    await waitFor(() => expect(confirmButton).toHaveProperty("disabled", false), { timeout: 4000 });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls.slice(1, 3).map((call) => [call[0], call[1].body])).toEqual([
      ["/api/machines/claude/mac-1", JSON.stringify({ id: "pc", group: "Work", merge: true })],
      ["/api/machines/openai/mac-1", JSON.stringify({ id: "pc", group: "Work", merge: true })],
    ]);
    expect(await screen.findByText("Merged “mac-1” into “pc”.")).not.toBeNull();
    expect(onManaged).toHaveBeenCalled();
  }, 8000);

  it("asks for the PIN when a merge needs sudo, and carries on with it once unlocked", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ machines: [MACHINE, { ...MACHINE, machineId: "pc" }] }),
      jsonResponse({ error: "sudo_required" }, false, 403),
      jsonResponse({ numeric: true }),
      { ok: true, status: 204, json: async () => ({}) } as Response,
      jsonResponse({ ok: true }),
      jsonResponse({ machines: [{ ...MACHINE, machineId: "pc" }] }),
    );
    renderWithIntl(<MachinesSection titleId="settings" groups={GROUPS} onManaged={vi.fn()} />);

    fireEvent.click(await screen.findByText("mac-1"));
    const input = screen.getByLabelText(/rename.*mac-1/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "pc" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const dialog = await screen.findByRole("alertdialog");
    const confirmButton = within(dialog).getByRole("button", { name: /yes/i });
    await waitFor(() => expect(confirmButton).toHaveProperty("disabled", false), { timeout: 4000 });
    fireEvent.click(confirmButton);

    // In the same dialog, which stays open, focused, and saying what it is for.
    const unlock = await within(dialog).findByRole("button", { name: "Unlock" });
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(document.activeElement?.id).toBe("sudo-pin");
    expect(
      within(dialog).getByText("Confirm this with your PIN. It will not ask again for the next 5 minutes."),
    ).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: /yes/i })).toHaveProperty("disabled", true);
    fireEvent.change(document.getElementById("sudo-pin")!, { target: { value: "12345" } });
    fireEvent.click(unlock);

    expect(await screen.findByText("Merged “mac-1” into “pc”.")).not.toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchMock.mock.calls[4]![0]).toBe("/api/machines/claude/mac-1");
    expect(fetchMock.mock.calls[4]![1].body).toBe(JSON.stringify({ id: "pc", group: "Personal", merge: true }));
  }, 8000);

  it("moves every provider's entry of a machine to the group picked for it", async () => {
    const onManaged = vi.fn();
    const fetchMock = mockFetch(
      jsonResponse({ machines: [MACHINE, { ...MACHINE, providerId: "openai" }] }),
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    );
    renderWithIntl(<MachinesSection titleId="settings" groups={TWO_GROUPS} onManaged={onManaged} />);

    const picker = (await screen.findByLabelText("Group of “mac-1”")) as HTMLSelectElement;
    expect(picker.value).toBe("Personal");
    fireEvent.change(picker, { target: { value: "Work" } });

    expect(await screen.findByText("Moved “mac-1” to Work.")).not.toBeNull();
    expect(fetchMock.mock.calls.slice(1).map((call) => [call[0], call[1].body])).toEqual([
      ["/api/machines/claude/mac-1", JSON.stringify({ group: "Work" })],
      ["/api/machines/openai/mac-1", JSON.stringify({ group: "Work" })],
    ]);
    expect((screen.getByLabelText("Group of “mac-1”") as HTMLSelectElement).value).toBe("Work");
    expect(onManaged).toHaveBeenCalled();
  });

  it("says to save the settings first when the picked group is not stored yet", async () => {
    mockFetch(jsonResponse({ machines: [MACHINE] }), jsonResponse({ error: "group_not_found" }, false, 404));
    renderWithIntl(<MachinesSection titleId="settings" groups={TWO_GROUPS} onManaged={vi.fn()} />);

    fireEvent.change(await screen.findByLabelText("Group of “mac-1”"), { target: { value: "Work" } });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "“Work” is not saved yet. Save the settings first, then move the machine.",
    );
  });

  it("says which providers were renamed when a rename fails half way, and reloads the list", async () => {
    const onManaged = vi.fn();
    const fetchMock = mockFetch(
      jsonResponse({ machines: [MACHINE, { ...MACHINE, providerId: "openai" }] }),
      jsonResponse({ ok: true }),
      jsonResponse({ error: "internal" }, false, 503),
      jsonResponse({
        machines: [
          { ...MACHINE, machineId: "studio" },
          { ...MACHINE, providerId: "openai" },
        ],
      }),
    );
    renderWithIntl(<MachinesSection titleId="settings" groups={GROUPS} onManaged={onManaged} />);

    fireEvent.click(await screen.findByText("mac-1"));
    const input = screen.getByLabelText(/rename.*mac-1/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "studio" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      await screen.findByText(
        "Only partly renamed: Claude now uses “studio”, OpenAI still uses “mac-1”. Try renaming “mac-1” again.",
      ),
    ).not.toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[3]![0]).toBe("/api/machines");
    expect(await screen.findByText("studio")).not.toBeNull();
    expect(onManaged).toHaveBeenCalled();
  });

  it("deletes every provider's entry of the machine once confirmed", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ machines: [MACHINE, { ...MACHINE, providerId: "openai" }] }),
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    );
    renderWithIntl(<MachinesSection titleId="settings" groups={GROUPS} onManaged={vi.fn()} />);

    await screen.findByText("mac-1");
    fireEvent.click(screen.getByLabelText(/delete.*mac-1/i));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/\(Claude, OpenAI\)/)).not.toBeNull();
    const confirmButton = within(dialog).getByRole("button", { name: /yes/i });
    await waitFor(() => expect(confirmButton).toHaveProperty("disabled", false), { timeout: 4000 });
    fireEvent.click(confirmButton);

    expect(await screen.findByText("No machines have reported yet.")).not.toBeNull();
    expect(fetchMock.mock.calls.slice(1).map((call) => [call[0], call[1].method])).toEqual([
      ["/api/machines/claude/mac-1", "DELETE"],
      ["/api/machines/openai/mac-1", "DELETE"],
    ]);
  }, 8000);

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

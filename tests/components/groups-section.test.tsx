import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftGroup } from "@/components/settings/draft";
import { GroupsSection } from "@/components/settings/sections/groups-section";
import { renderWithIntl } from "../helpers/render";

/** The group delete flow: the typed confirmation with its impact line, the sudo retry, and the empty-group shortcut. */

const IMPACT = { events: 40, machines: 2, groups: 1, lastReportAt: Date.now() - 2 * 3_600_000, recentMachines: 1 };
const WORK: DraftGroup = { id: "Work", color: "#e5a139", colorText: "#e5a139", hasReports: true, excluded: [] };
const EMPTY: DraftGroup = { id: "Empty", color: "#3987e5", colorText: "#3987e5", hasReports: false, excluded: [] };

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

/** Routes by method and URL; `realDelete` answers the DELETE without dryRun. */
function mockApi(realDelete: () => Response | Promise<Response>) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/groups/Work?force=1&dryRun=1") return answer(200, { ok: true, dryRun: true, impact: IMPACT });
    if (url === "/api/groups/Work?force=1" && init?.method === "DELETE") return realDelete();
    if (url === "/api/auth/sudo") return answer(200, { mode: "pin", numeric: true });
    throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function renderGroups(groups: DraftGroup[]) {
  const handlers = {
    onPatchGroup: vi.fn(),
    onSetCounted: vi.fn(),
    onRemoveGroup: vi.fn(),
    onGroupsChanged: vi.fn(),
    onAddGroup: vi.fn(),
    onNewGroupNameChange: vi.fn(),
    onManaged: vi.fn(),
  };
  renderWithIntl(
    <GroupsSection
      titleId="settings"
      groups={groups}
      savedGroupIds={groups.map((group) => group.id)}
      newGroupName=""
      visibleProviders={[]}
      {...handlers}
    />,
  );
  return handlers;
}

/** Opens the delete dialog for Work and types its name. */
async function openAndType(name = "Work") {
  fireEvent.click(screen.getByRole("button", { name: "Delete “Work”" }));
  const dialog = await screen.findByRole("alertdialog");
  await within(dialog).findByText(/^40 stored reports/);
  fireEvent.change(within(dialog).getByLabelText("Name to confirm the deletion"), { target: { value: name } });
  return dialog;
}

describe("GroupsSection delete", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("opens the typed dialog for a group with reports, with the impact line, and force-deletes once the name is typed", async () => {
    const fetchMock = mockApi(() => answer(200, { ok: true, affected: { events: 40, machines: 2, groups: 1 } }));
    const handlers = renderGroups([WORK]);

    fireEvent.click(screen.getByRole("button", { name: "Delete “Work”" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(await within(dialog).findByText("40 stored reports · 2 machines · last report 2 hours ago")).not.toBeNull();
    expect(within(dialog).getByRole("note")).not.toBeNull();

    const confirm = within(dialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Name to confirm the deletion"), { target: { value: "Work" } });
    fireEvent.click(confirm);

    await waitFor(() => expect(handlers.onManaged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/groups/Work?force=1", { method: "DELETE" });
    expect(handlers.onGroupsChanged).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Deleted “Work”.")).not.toBeNull();
  });

  it("does not delete when the dialog is cancelled", async () => {
    const fetchMock = mockApi(() => answer(200, { ok: true }));
    renderGroups([WORK]);
    fireEvent.click(screen.getByRole("button", { name: "Delete “Work”" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes a group without reports from the draft, with no request", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const handlers = renderGroups([EMPTY]);
    fireEvent.click(screen.getByRole("button", { name: "Delete “Empty”" }));
    expect(handlers.onRemoveGroup).toHaveBeenCalledWith(EMPTY);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for the PIN when the delete answers sudo_required", async () => {
    mockApi(() => answer(403, { error: "sudo_required" }));
    const handlers = renderGroups([WORK]);
    const dialog = await openAndType();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByRole("button", { name: /^Unlock/ })).not.toBeNull();
    expect(handlers.onGroupsChanged).not.toHaveBeenCalled();
  });

  it("retries the delete once the PIN is accepted", async () => {
    let unlocked = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/sudo" && init?.method === "POST") {
        unlocked = true;
        return new Response(null, { status: 204 });
      }
      if (url === "/api/groups/Work?force=1" && unlocked) return answer(200, { ok: true });
      if (url === "/api/groups/Work?force=1") return answer(403, { error: "sudo_required" });
      if (url === "/api/groups/Work?force=1&dryRun=1") return answer(200, { ok: true, impact: IMPACT });
      return answer(200, { mode: "pin", numeric: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const handlers = renderGroups([WORK]);
    const dialog = await openAndType();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    const unlock = await screen.findByRole("button", { name: /^Unlock/ });
    fireEvent.change(document.getElementById("sudo-pin") as HTMLInputElement, { target: { value: "12345" } });
    fireEvent.click(unlock);

    await waitFor(() => expect(handlers.onGroupsChanged).toHaveBeenCalledTimes(1));
    expect(handlers.onManaged).toHaveBeenCalled();
  });

  it("shows a problem line when the delete fails otherwise", async () => {
    mockApi(() => answer(500, { error: "server_error" }));
    const handlers = renderGroups([WORK]);
    const dialog = await openAndType();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("That did not work. Try again in a moment.")).not.toBeNull();
    expect(handlers.onGroupsChanged).not.toHaveBeenCalled();
  });
});

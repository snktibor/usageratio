import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DraftGroup } from "@/components/settings/draft";
import { GroupsSection } from "@/components/settings/sections/groups-section";
import { MachinesSection } from "@/components/settings/sections/machines-section";
import { renderWithIntl } from "../helpers/render";

/** Archiving and restoring groups and machines on the settings panel (lib/archived.ts). */

const WORK: DraftGroup = { id: "Work", color: "#e5a139", colorText: "#e5a139", hasReports: true, excluded: [] };
const OLD: DraftGroup = {
  id: "Old",
  color: "#3987e5",
  colorText: "#3987e5",
  hasReports: true,
  excluded: [],
  archivedAt: 1,
};

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function renderGroups(groups: DraftGroup[], savedGroupIds = groups.map((group) => group.id)) {
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
      savedGroupIds={savedGroupIds}
      newGroupName=""
      visibleProviders={[]}
      {...handlers}
    />,
  );
  return handlers;
}

/** What the section's `onGroupsChanged` updater makes of `groups`. */
function applied(handler: ReturnType<typeof vi.fn>, groups: DraftGroup[]): DraftGroup[] {
  const updater = handler.mock.calls.at(-1)![0] as (current: DraftGroup[]) => DraftGroup[];
  return updater(groups);
}

describe("GroupsSection archive", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("archives a saved group live, and its baseline follows", async () => {
    const fetchMock = vi.fn(async () => answer(200, { ok: true, changed: true }));
    vi.stubGlobal("fetch", fetchMock);
    const handlers = renderGroups([WORK]);

    fireEvent.click(screen.getByRole("button", { name: "Archive “Work”" }));
    await waitFor(() => expect(handlers.onManaged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/groups/Work", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect(applied(handlers.onGroupsChanged, [WORK, OLD])).toEqual([{ ...WORK, archivedAt: expect.any(Number) }, OLD]);
    expect(await screen.findByText("Archived “Work”. Its reports stay; a new report brings it back.")).not.toBeNull();
  });

  it("offers no archive for a group that exists only in the draft", () => {
    renderGroups([WORK], []);
    expect(screen.queryByRole("button", { name: "Archive “Work”" })).toBeNull();
  });

  it("folds the archived groups away and restores one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(200, { ok: true, changed: true })),
    );
    const handlers = renderGroups([WORK, OLD]);

    expect(screen.queryByRole("button", { name: "Delete “Old”" })).toBeNull();
    expect(screen.getByText("Show 1 archived group")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Restore “Old” from the archive" }));

    await waitFor(() => expect(handlers.onManaged).toHaveBeenCalled());
    expect(applied(handlers.onGroupsChanged, [WORK, OLD])).toEqual([WORK, { ...OLD, archivedAt: undefined }]);
    expect(await screen.findByText("Restored “Old”.")).not.toBeNull();
  });

  it("says so when the server refuses, and changes nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(503, { error: "store_unavailable" })),
    );
    const handlers = renderGroups([WORK]);

    fireEvent.click(screen.getByRole("button", { name: "Archive “Work”" }));
    expect(await screen.findByText(/did not work/)).not.toBeNull();
    expect(handlers.onGroupsChanged).not.toHaveBeenCalled();
  });

  it("says so when the server cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const handlers = renderGroups([WORK]);

    fireEvent.click(screen.getByRole("button", { name: "Archive “Work”" }));
    expect(await screen.findByText(/did not work/)).not.toBeNull();
    expect(handlers.onManaged).not.toHaveBeenCalled();
  });
});

const NOW = Date.now();
const ENTRY = { lastSeenAt: NOW, lastTokens: 1 };
const MAC = { ...ENTRY, providerId: "claude", machineId: "mac", groupId: "Work" };

function jsonResponse(body: unknown, status = 200): Response {
  return answer(status, body);
}

function mockFetch(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn();
  for (const response of responses) fn.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("MachinesSection archive", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("archives every provider's entry of a machine, which then moves to the archived list", async () => {
    const onManaged = vi.fn();
    const onMachineIds = vi.fn();
    const fetchMock = mockFetch(
      jsonResponse({ machines: [MAC, { ...MAC, providerId: "codex" }, { ...MAC, machineId: "pc" }] }),
      jsonResponse({ ok: true, changed: true }),
      jsonResponse({ ok: true, changed: true }),
    );
    renderWithIntl(
      <MachinesSection titleId="settings" groups={[WORK]} onManaged={onManaged} onMachineIds={onMachineIds} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Archive “mac”" }));
    await waitFor(() => expect(onManaged).toHaveBeenCalled());
    expect(fetchMock.mock.calls.slice(1).map(([url, init]) => [url, init.body])).toEqual([
      ["/api/machines/claude/mac", JSON.stringify({ archived: true })],
      ["/api/machines/codex/mac", JSON.stringify({ archived: true })],
    ]);
    expect(await screen.findByText("Show 1 archived machine")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Archive “mac”" })).toBeNull();
    expect(onMachineIds).toHaveBeenLastCalledWith(["pc"]);
    expect(screen.getByRole("button", { name: "Archive “pc”" })).not.toBeNull();
  });

  it("restores only the entries that carry their own mark", async () => {
    const onManaged = vi.fn();
    const fetchMock = mockFetch(
      jsonResponse({ machines: [{ ...MAC, archivedAt: 1 }] }),
      jsonResponse({ ok: true, changed: true }),
    );
    renderWithIntl(<MachinesSection titleId="settings" groups={[WORK]} onManaged={onManaged} />);

    fireEvent.click(await screen.findByRole("button", { name: "Restore “mac” from the archive" }));
    await waitFor(() => expect(onManaged).toHaveBeenCalled());
    expect(fetchMock.mock.calls[1]).toEqual([
      "/api/machines/claude/mac",
      expect.objectContaining({ body: JSON.stringify({ archived: false }) }),
    ]);
    expect(await screen.findByRole("button", { name: "Archive “mac”" })).not.toBeNull();
    expect(screen.getByText("Restored “mac”.")).not.toBeNull();
  });

  it("lists an archived machine whose group is gone, in the neutral colour", async () => {
    mockFetch(jsonResponse({ machines: [{ ...MAC, groupId: "Gone", archivedAt: 1 }] }));
    renderWithIntl(<MachinesSection titleId="settings" groups={[WORK]} onManaged={vi.fn()} />);

    expect(await screen.findByText("Gone")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Restore “mac” from the archive" })).not.toBeNull();
  });

  it("lists a machine of an archived group as archived with it, without its own restore, and keeps the group out of the pickers", async () => {
    mockFetch(jsonResponse({ machines: [{ ...MAC, machineId: "old-mac", groupId: "Old" }, MAC] }));
    renderWithIntl(<MachinesSection titleId="settings" groups={[WORK, OLD]} onManaged={vi.fn()} />);

    expect(await screen.findByText("Archived with Old")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Restore “old-mac” from the archive" })).toBeNull();
    const picker = screen.getByRole("combobox", { name: /mac/ });
    expect(
      within(picker)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Work"]);
  });

  it("stops at the first failure, says so, and reloads a half-archived machine", async () => {
    const onManaged = vi.fn();
    const fetchMock = mockFetch(
      jsonResponse({ machines: [MAC, { ...MAC, providerId: "codex" }] }),
      jsonResponse({ ok: true, changed: true }),
      jsonResponse({ error: "store_unavailable" }, 503),
      jsonResponse({
        machines: [
          { ...MAC, archivedAt: 1 },
          { ...MAC, providerId: "codex" },
        ],
      }),
    );
    renderWithIntl(<MachinesSection titleId="settings" groups={[WORK]} onManaged={onManaged} />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive “mac”" }));
    expect(await screen.findByText(/did not work/)).not.toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[3]![0]).toBe("/api/machines");
    expect(onManaged).not.toHaveBeenCalled();
  });

  it("does not reload when nothing was archived", async () => {
    const fetchMock = mockFetch(jsonResponse({ machines: [MAC] }), jsonResponse({ error: "not_found" }, 404));
    renderWithIntl(<MachinesSection titleId="settings" groups={[WORK]} onManaged={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "Archive “mac”" }));
    expect(await screen.findByText(/did not work/)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

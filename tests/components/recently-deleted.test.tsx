import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentlyDeleted } from "@/components/settings/sections/recently-deleted";
import type { TrashEntry } from "@/lib/trash";
import { renderWithIntl } from "../helpers/render";

/** The Recently deleted list: loading, restore, the PIN retry, the refusals, and the owner's permanent delete. */

const DAY = 86_400_000;
const DELETED_AT = Date.UTC(2026, 10, 10, 12, 0);
const LAB: TrashEntry = {
  id: "AAAAAAAAAAAAAAAA",
  kind: "group",
  name: "Lab",
  deletedAt: DELETED_AT,
  expiresAt: DELETED_AT + 30 * DAY,
  by: null,
  affected: { events: 40, machines: 2, groups: 1 },
};
const OPENAI: TrashEntry = {
  id: "BBBBBBBBBBBBBBBB",
  kind: "provider",
  name: "openai",
  deletedAt: DELETED_AT - DAY,
  expiresAt: DELETED_AT + 29 * DAY,
  by: "tibor",
  affected: { events: 1, machines: 1, groups: 1 },
};
const RESTORE_LAB = `/api/trash/${LAB.id}/restore`;
const PURGE_LAB = `/api/trash/${LAB.id}`;

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const GROUP_RESTORED = {
  ok: true,
  kind: "group",
  id: "Lab",
  restored: { events: 40, machines: 2 },
  merged: false,
  group: { id: "Lab", color: "#3987e5", excluded: ["openai"] },
};

/** GET /api/trash answers `entries` (or fails); `act` answers the restore and the delete, by method and URL. */
function mockApi(entries: TrashEntry[] | "fail", act: (url: string, method: string) => Response | null = () => null) {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/trash") {
      return entries === "fail" ? answer(503, { error: "store_unavailable" }) : answer(200, { entries });
    }
    if (url === "/api/auth/sudo" && method === "GET") return answer(200, { mode: "pin", numeric: true });
    const reply = act(url, method);
    if (reply) return reply;
    throw new Error(`unexpected ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function renderList(canPurge = true) {
  const handlers = { onGroupRestored: vi.fn(), onProviderRestored: vi.fn(), onManaged: vi.fn() };
  const element = (reloadKey: number) => (
    <RecentlyDeleted timeZone="Europe/Budapest" canPurge={canPurge} reloadKey={reloadKey} {...handlers} />
  );
  const { unmount, rerender } = renderWithIntl(element(0));
  return { ...handlers, unmount, reload: (reloadKey: number) => rerender(element(reloadKey)) };
}

describe("RecentlyDeleted list", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the entries with kind, counts and dates, and no loading line afterwards", async () => {
    mockApi([LAB, OPENAI]);
    renderList();

    expect(screen.getByText("Loading status...")).not.toBeNull();
    expect(await screen.findByText("Lab")).not.toBeNull();
    expect(screen.queryByText("Loading status...")).toBeNull();
    expect(screen.getByText("openai")).not.toBeNull();
    expect(screen.getByText("Group")).not.toBeNull();
    expect(screen.getByText("Provider")).not.toBeNull();
    expect(screen.getByText(/Deleted .* · 40 reports · kept until /)).not.toBeNull();
    expect(screen.getByText(/ · 1 report · kept until /)).not.toBeNull();
    expect(screen.getByText(/stay here for 30 days/)).not.toBeNull();
    // Folded away under its count, closed until opened.
    const summary = screen.getByText("Show the 2 deleted items");
    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
  });

  it("says so when nothing was deleted", async () => {
    mockApi([]);
    renderList();
    expect(await screen.findByText("Nothing was deleted recently.")).not.toBeNull();
    expect(screen.queryByText("Loading status...")).toBeNull();
  });

  it("says so when the list cannot be loaded, and the loading line is gone", async () => {
    mockApi("fail");
    renderList();
    expect(await screen.findByText("The recently deleted list could not be loaded.")).not.toBeNull();
    expect(screen.queryByText("Loading status...")).toBeNull();
  });

  it("loads the list again when reloadKey changes, without a loading line", async () => {
    let entries = [LAB];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(200, { entries })),
    );
    const view = renderList();
    await screen.findByText("Lab");

    entries = [LAB, OPENAI];
    view.reload(1);
    expect(await screen.findByText("openai")).not.toBeNull();
    expect(screen.queryByText("Loading status...")).toBeNull();
  });

  it("treats a network error like a failed load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    renderList();
    expect(await screen.findByText("The recently deleted list could not be loaded.")).not.toBeNull();
  });
});

describe("RecentlyDeleted restore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the restore, hands the group over, toasts, and reloads the list", async () => {
    let restored = false;
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/trash") return answer(200, { entries: restored ? [] : [LAB] });
      if (url === RESTORE_LAB && init?.method === "POST") {
        restored = true;
        return answer(200, GROUP_RESTORED);
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fn);
    const handlers = renderList();

    fireEvent.click(await screen.findByRole("button", { name: "Restore “Lab”" }));

    await waitFor(() => expect(handlers.onManaged).toHaveBeenCalledTimes(1));
    expect(fn).toHaveBeenCalledWith(RESTORE_LAB, { method: "POST" });
    expect(handlers.onGroupRestored).toHaveBeenCalledWith({
      id: "Lab",
      color: "#3987e5",
      colorText: "#3987e5",
      hasReports: true,
      excluded: ["openai"],
    });
    expect(handlers.onProviderRestored).not.toHaveBeenCalled();
    expect(await screen.findByText("Restored “Lab”.")).not.toBeNull();
    expect(await screen.findByText("Nothing was deleted recently.")).not.toBeNull();
  });

  it("uses the merged toast when the restore joined what arrived since", async () => {
    mockApi([LAB], (url) => (url === RESTORE_LAB ? answer(200, { ...GROUP_RESTORED, merged: true }) : null));
    renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Restore “Lab”" }));
    expect(
      await screen.findByText("Restored “Lab”, together with the reports that arrived since it was deleted."),
    ).not.toBeNull();
  });

  it("hands a restored provider over by id", async () => {
    mockApi([OPENAI], (url) =>
      url === `/api/trash/${OPENAI.id}/restore`
        ? answer(200, { ok: true, kind: "provider", id: "openai", restored: { events: 1, machines: 1 }, merged: false })
        : null,
    );
    const handlers = renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Restore “openai”" }));
    await waitFor(() => expect(handlers.onProviderRestored).toHaveBeenCalledWith("openai"));
    expect(handlers.onGroupRestored).not.toHaveBeenCalled();
    expect(handlers.onManaged).toHaveBeenCalled();
  });

  it("asks for the PIN on sudo_required, then retries the restore", async () => {
    let unlocked = false;
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/trash") return answer(200, { entries: [LAB] });
      if (url === "/api/auth/sudo" && init?.method === "POST") {
        unlocked = true;
        return new Response(null, { status: 204 });
      }
      if (url === "/api/auth/sudo") return answer(200, { mode: "pin", numeric: true });
      if (url === RESTORE_LAB) return unlocked ? answer(200, GROUP_RESTORED) : answer(403, { error: "sudo_required" });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fn);
    const handlers = renderList();

    fireEvent.click(await screen.findByRole("button", { name: "Restore “Lab”" }));
    const unlock = await screen.findByRole("button", { name: /^Unlock/ });
    expect(handlers.onGroupRestored).not.toHaveBeenCalled();
    fireEvent.change(document.getElementById("sudo-pin") as HTMLInputElement, { target: { value: "12345" } });
    fireEvent.click(unlock);

    await waitFor(() => expect(handlers.onGroupRestored).toHaveBeenCalledTimes(1));
    expect(handlers.onManaged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /^Unlock/ })).toBeNull();
  });

  it("on 404 says the entry is gone and reloads the list", async () => {
    let gone = false;
    const fn = vi.fn(async (url: string) => {
      if (url === "/api/trash") return answer(200, { entries: gone ? [] : [LAB] });
      if (url === RESTORE_LAB) {
        gone = true;
        return answer(404, { error: "not_found" });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fn);
    const handlers = renderList();

    fireEvent.click(await screen.findByRole("button", { name: "Restore “Lab”" }));
    expect(await screen.findByText("That entry is no longer in Recently deleted.")).not.toBeNull();
    await waitFor(() => expect(screen.queryByText("Lab")).toBeNull());
    expect(handlers.onGroupRestored).not.toHaveBeenCalled();
    expect(fn.mock.calls.filter(([url]) => url === "/api/trash")).toHaveLength(2);
  });

  it("on 409 too_many_* says a limit is reached", async () => {
    mockApi([LAB], (url) => (url === RESTORE_LAB ? answer(409, { error: "too_many_groups" }) : null));
    const handlers = renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Restore “Lab”" }));
    expect(
      await screen.findByText("It cannot be restored: the limit of groups, providers or machines is reached."),
    ).not.toBeNull();
    expect(handlers.onManaged).not.toHaveBeenCalled();
  });

  it("on any other error says it did not work, and the buttons work again", async () => {
    mockApi([LAB], (url) => (url === RESTORE_LAB ? answer(500, { error: "server_error" }) : null));
    renderList();
    const button = await screen.findByRole("button", { name: "Restore “Lab”" });
    fireEvent.click(button);
    expect(await screen.findByText("That did not work. Try again in a moment.")).not.toBeNull();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  });

  it("says it did not work when the refusal carries no error code", async () => {
    mockApi([LAB], (url) => (url === RESTORE_LAB ? new Response("not json", { status: 500 }) : null));
    renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Restore “Lab”" }));
    expect(await screen.findByText("That did not work. Try again in a moment.")).not.toBeNull();
  });

  it("hands nothing over when a group's restore answer lacks the group, and still toasts", async () => {
    const { group: _group, ...bare } = GROUP_RESTORED;
    mockApi([LAB], (url) => (url === RESTORE_LAB ? answer(200, bare) : null));
    const handlers = renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Restore “Lab”" }));
    expect(await screen.findByText("Restored “Lab”.")).not.toBeNull();
    expect(handlers.onGroupRestored).not.toHaveBeenCalled();
    expect(handlers.onProviderRestored).not.toHaveBeenCalled();
  });

  it("lets the toast go by itself", async () => {
    mockApi([LAB], (url) => (url === RESTORE_LAB ? answer(200, GROUP_RESTORED) : null));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Restore “Lab”" }));
    expect(await screen.findByText("Restored “Lab”.")).not.toBeNull();
    act(() => vi.advanceTimersByTime(5_000));
    vi.useRealTimers();
    expect(screen.queryByText("Restored “Lab”.")).toBeNull();
  });

  it("does not touch the state once it is unmounted before the first load comes back", async () => {
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const handlers = renderList();
    handlers.unmount();
    await act(async () => release(answer(200, { entries: [LAB] })));
  });

  it("says it did not work when the request itself fails", async () => {
    const fn = vi.fn(async (url: string) => {
      if (url === "/api/trash") return answer(200, { entries: [LAB] });
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fn);
    renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Restore “Lab”" }));
    expect(await screen.findByText("That did not work. Try again in a moment.")).not.toBeNull();
  });

  it("does not touch the state once it is unmounted before the reload comes back", async () => {
    let release: (value: Response) => void = () => {};
    let listCalls = 0;
    const fn = vi.fn(async (url: string) => {
      if (url === "/api/trash") {
        listCalls += 1;
        return listCalls === 1
          ? answer(200, { entries: [LAB] })
          : new Promise<Response>((resolve) => (release = resolve));
      }
      if (url === RESTORE_LAB) return answer(200, GROUP_RESTORED);
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fn);
    const handlers = renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Restore “Lab”" }));
    await waitFor(() => expect(handlers.onManaged).toHaveBeenCalled());
    await waitFor(() => expect(listCalls).toBe(2));
    handlers.unmount();
    await act(async () => release(answer(200, { entries: [] })));
  });
});

describe("RecentlyDeleted permanent delete", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("offers no permanent delete without canPurge", async () => {
    mockApi([LAB]);
    renderList(false);
    await screen.findByText("Lab");
    expect(screen.getByRole("button", { name: "Restore “Lab”" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Delete “Lab” permanently" })).toBeNull();
  });

  it("confirms after the countdown, then sends DELETE, reloads and tells the panel", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let purged = false;
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/trash") return answer(200, { entries: purged ? [] : [LAB] });
      if (url === PURGE_LAB && init?.method === "DELETE") {
        purged = true;
        return answer(200, { ok: true, affected: LAB.affected });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fn);
    const handlers = renderList();

    fireEvent.click(await screen.findByRole("button", { name: "Delete “Lab” permanently" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete permanently?")).not.toBeNull();
    expect(within(dialog).getByText(/“Lab” and its 40 stored reports are removed for good/)).not.toBeNull();
    expect((within(dialog).getByRole("button", { name: /^Yes/ }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes" }));

    await waitFor(() => expect(handlers.onManaged).toHaveBeenCalledTimes(1));
    expect(fn).toHaveBeenCalledWith(PURGE_LAB, { method: "DELETE" });
    expect(handlers.onGroupRestored).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText("Nothing was deleted recently.")).not.toBeNull();
  });

  it("does not delete when the dialog is cancelled", async () => {
    const fn = mockApi([LAB]);
    renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Delete “Lab” permanently" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("asks for the PIN on sudo_required, then retries the delete", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let unlocked = false;
    const fn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/trash") return answer(200, { entries: [LAB] });
      if (url === "/api/auth/sudo" && init?.method === "POST") {
        unlocked = true;
        return new Response(null, { status: 204 });
      }
      if (url === "/api/auth/sudo") return answer(200, { mode: "pin", numeric: true });
      if (url === PURGE_LAB) return unlocked ? answer(200, { ok: true }) : answer(403, { error: "sudo_required" });
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fn);
    const handlers = renderList();

    fireEvent.click(await screen.findByRole("button", { name: "Delete “Lab” permanently" }));
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes" }));

    const unlock = await screen.findByRole("button", { name: /^Unlock/ });
    fireEvent.change(document.getElementById("sudo-pin") as HTMLInputElement, { target: { value: "12345" } });
    fireEvent.click(unlock);

    await waitFor(() => expect(handlers.onManaged).toHaveBeenCalledTimes(1));
    expect(fn.mock.calls.filter(([url, init]) => url === PURGE_LAB && init?.method === "DELETE")).toHaveLength(2);
  });

  it("shows a problem line when the delete is refused (a member, or an error)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockApi([LAB], (url) => (url === PURGE_LAB ? answer(403, { error: "owner_only" }) : null));
    const handlers = renderList();
    fireEvent.click(await screen.findByRole("button", { name: "Delete “Lab” permanently" }));
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes" }));
    expect(await screen.findByText("That did not work. Try again in a moment.")).not.toBeNull();
    expect(handlers.onManaged).not.toHaveBeenCalled();
  });
});

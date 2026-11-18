import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ManageHistory } from "@/components/settings/sections/manage-history";
import type { ManageAuditEntry } from "@/lib/manage-audit";
import { renderWithIntl } from "../helpers/render";

/** The history of destructive actions: fetched on the first open, one row per entry. */

const AT = Date.parse("2026-11-18T10:30:00Z");

const base = {
  userAgent: "UA",
  ip: "203.0.113.0/24 · 3fa9c1a2b91c",
  trashId: null,
};

const ENTRIES: ManageAuditEntry[] = [
  {
    ...base,
    at: AT,
    action: "group_merged",
    subject: { kind: "group", id: "Work", target: "Team" },
    affected: { events: 12, machines: 1, groups: 1 },
    browser: "Chrome 140",
    os: "macOS",
    session: "1a2b3c4d",
    by: "octocat",
  },
  {
    ...base,
    at: AT - 3_600_000,
    action: "machine_deleted",
    subject: { kind: "machine", id: "mac", providerId: "claude" },
    affected: { events: 1, machines: 1, groups: 0 },
    browser: null,
    os: null,
    session: "ffffffff",
    by: null,
  },
  {
    ...base,
    at: AT - 7_200_000,
    action: "restart_recorded",
    subject: { kind: "provider", id: "openai" },
    affected: null,
    browser: null,
    os: null,
    userAgent: "",
    session: null,
    by: null,
  },
  {
    ...base,
    at: AT - 9_000_000,
    action: "machine_merged",
    subject: { kind: "machine", id: "a", providerId: "claude", target: "b" },
    affected: { events: 1, machines: 2, groups: 0 },
    browser: "Chrome 140",
    os: null,
    session: null,
    by: null,
  },
];

function toggle(open: boolean) {
  const details = document.querySelector("details")!;
  details.open = open;
  fireEvent(details, new Event("toggle"));
}
const open = () => toggle(true);

function stubFetch(answer: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async () => answer());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("ManageHistory", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is closed and fetches nothing until opened, then fetches once", async () => {
    const fetchMock = stubFetch(
      () => new Response(JSON.stringify({ entries: [], currentSession: null }), { status: 200 }),
    );
    renderWithIntl(<ManageHistory timeZone="Europe/Budapest" />);
    expect(screen.getByText("Show the history of deletions and merges")).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    // A hidden loading line would read as a page still loading (e2e/settings.spec.ts waits for none).
    expect(screen.queryByText("Loading status...")).toBeNull();

    open();
    expect(await screen.findByText("Nothing recorded yet.")).not.toBeNull();
    // Closing and opening again does not fetch again.
    toggle(false);
    open();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/manage/audit", { cache: "no-store" });
  });

  it("lists each entry: action, subject, counts, who and from which browser", async () => {
    stubFetch(() => new Response(JSON.stringify({ entries: ENTRIES, currentSession: "1a2b3c4d" }), { status: 200 }));
    renderWithIntl(<ManageHistory timeZone="Europe/Budapest" />);
    open();

    expect(await screen.findByText("Groups merged")).not.toBeNull();
    expect(screen.getByText("Work → Team")).not.toBeNull();
    expect(screen.getByText("12 reports · 1 machine")).not.toBeNull();
    expect(screen.getByText("by @octocat")).not.toBeNull();
    expect(screen.getByText(/Chrome 140 · macOS/)).not.toBeNull();
    expect(screen.getByText(/this browser/)).not.toBeNull();

    expect(screen.getByText("Machine deleted")).not.toBeNull();
    expect(screen.getByText("claude:mac")).not.toBeNull();
    expect(screen.getByText("Unknown browser")).not.toBeNull();

    expect(screen.getByText("Restart recorded")).not.toBeNull();
    expect(screen.getByText("openai")).not.toBeNull();
    expect(screen.getByText("Unknown client")).not.toBeNull();

    expect(screen.getByText("Machines merged")).not.toBeNull();
    expect(screen.getByText("claude:a → claude:b")).not.toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(ENTRIES.length);
    expect(screen.getByText(/the last 500 entries; times in Europe\/Budapest/)).not.toBeNull();
  });

  it("says so when the session has expired (401)", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    renderWithIntl(<ManageHistory timeZone="Europe/Budapest" />);
    open();
    expect(await screen.findByText("The session has expired. Log in again with the PIN.")).not.toBeNull();
  });

  it("says so when the store is unavailable (503) or the request fails", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: "store_unavailable" }), { status: 503 }));
    const first = renderWithIntl(<ManageHistory timeZone="Europe/Budapest" />);
    open();
    expect(
      await screen.findByText("The log could not be loaded: the data store is currently unavailable."),
    ).not.toBeNull();
    first.unmount();

    stubFetch(() => Promise.reject(new Error("offline")));
    renderWithIntl(<ManageHistory timeZone="Europe/Budapest" />);
    open();
    expect(
      await screen.findByText("The log could not be loaded: the data store is currently unavailable."),
    ).not.toBeNull();
  });

  it("ignores an answer that arrives after it is gone", async () => {
    let answer: (response: Response) => void = () => {};
    stubFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
    const view = renderWithIntl(<ManageHistory timeZone="Europe/Budapest" />);
    open();
    view.unmount();
    answer(new Response(JSON.stringify({ entries: ENTRIES, currentSession: null }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("Groups merged")).toBeNull();
  });

  it("ignores a failure that arrives after it is gone", async () => {
    let fail: (reason: Error) => void = () => {};
    stubFetch(() => new Promise<Response>((_, reject) => (fail = reject)));
    const view = renderWithIntl(<ManageHistory timeZone="Europe/Budapest" />);
    open();
    view.unmount();
    fail(new Error("offline"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.body.textContent).toBe("");
  });

  it("shows the loading line while the answer is on its way", async () => {
    let answer: (response: Response) => void = () => {};
    stubFetch(() => new Promise<Response>((resolve) => (answer = resolve)));
    renderWithIntl(<ManageHistory timeZone="Europe/Budapest" />);
    open();
    expect(screen.getByText("Loading status...")).not.toBeNull();
    answer(new Response(JSON.stringify({ entries: [], currentSession: null }), { status: 200 }));
    await waitFor(() => expect(screen.queryByText("Loading status...")).toBeNull());
  });
});

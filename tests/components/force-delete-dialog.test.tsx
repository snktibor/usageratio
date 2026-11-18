import { fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type DeleteImpactState, ForceDeleteDialog, useDeleteImpact } from "@/components/settings/force-delete-dialog";
import type { DeleteImpact } from "@/lib/manage-store";
import { renderWithIntl } from "../helpers/render";

const HOUR = 3_600_000;
const IMPACT: DeleteImpact = {
  events: 12,
  machines: 2,
  groups: 1,
  lastReportAt: Date.now() - 3 * HOUR,
  recentMachines: 0,
};
const ready = (changes: Partial<DeleteImpact> = {}): DeleteImpactState => ({
  phase: "ready",
  impact: { ...IMPACT, ...changes },
});

function renderDialog(
  impact: DeleteImpactState,
  { kind = "group" as "group" | "provider", name = "Work", onConfirm = vi.fn(), onCancel = vi.fn() } = {},
) {
  renderWithIntl(
    <ForceDeleteDialog
      kind={kind}
      name={name}
      title="Delete this?"
      body="This cannot be undone."
      impact={impact}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />,
  );
  const dialog = screen.getByRole("alertdialog");
  return {
    dialog,
    field: within(dialog).getByLabelText("Name to confirm the deletion") as HTMLInputElement,
    confirm: within(dialog).getByRole("button", { name: "Delete" }) as HTMLButtonElement,
    onConfirm,
    onCancel,
  };
}

describe("ForceDeleteDialog", () => {
  it("keeps Delete disabled until the exact name is typed, case included", () => {
    const { field, confirm } = renderDialog(ready());
    expect(confirm.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "work" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "Wor" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "Work" } });
    expect(confirm.disabled).toBe(false);
  });

  it("confirms once the name is typed", async () => {
    const { field, confirm, onConfirm, onCancel } = renderDialog(ready());
    fireEvent.change(field, { target: { value: "Work" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("shows the name to type", () => {
    const { dialog } = renderDialog(ready());
    expect(within(dialog).getByText("Work", { selector: "code" })).not.toBeNull();
  });

  it("lets other keys through in the field", () => {
    const { field } = renderDialog(ready());
    expect(fireEvent.keyDown(field, { key: "a" })).toBe(true);
  });

  it("does not confirm or submit a surrounding form on Enter in the field", () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const onConfirm = vi.fn();
    renderWithIntl(
      <form onSubmit={onSubmit}>
        <ForceDeleteDialog
          kind="group"
          name="Work"
          title="Delete this?"
          body="Body"
          impact={ready()}
          onCancel={vi.fn()}
          onConfirm={onConfirm}
        />
      </form>,
    );
    const field = screen.getByLabelText("Name to confirm the deletion");
    fireEvent.change(field, { target: { value: "Work" } });
    const notPrevented = fireEvent.keyDown(field, { key: "Enter" });
    expect(notPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("states the reports, machines and age of the last report once counted", () => {
    const { dialog } = renderDialog(ready());
    expect(within(dialog).getByText("12 stored reports · 2 machines · last report 3 hours ago")).not.toBeNull();
    expect(within(dialog).queryByRole("note")).toBeNull();
  });

  it("uses the singular forms and the empty line", () => {
    const { dialog } = renderDialog(ready({ events: 1, machines: 1 }));
    expect(within(dialog).getByText(/^1 stored report · 1 machine · last report/)).not.toBeNull();
  });

  it("says so when no reports are left, and when no machine reported", () => {
    const { dialog } = renderDialog(ready({ events: 0, machines: 0, lastReportAt: null }));
    expect(within(dialog).getByText("No stored reports left · no machine")).not.toBeNull();
  });

  it("says it is counting while loading, and that it could not when failed", () => {
    const loading = renderDialog({ phase: "loading" });
    expect(within(loading.dialog).getByText("Counting what this deletes…")).not.toBeNull();
    expect(loading.confirm.disabled).toBe(true);
  });

  it("says when the count failed, and still allows deleting after typing the name", () => {
    const { dialog, field, confirm } = renderDialog({ phase: "failed" });
    expect(within(dialog).getByText("What this deletes could not be counted.")).not.toBeNull();
    fireEvent.change(field, { target: { value: "Work" } });
    expect(confirm.disabled).toBe(false);
  });

  it("warns about recently reporting machines, for a group", () => {
    const { dialog } = renderDialog(ready({ recentMachines: 2 }));
    expect(within(dialog).getByRole("note").textContent).toBe(
      "2 machines reported to this group in the last 24 hours. Unless their setup changes, the group comes back with the next report.",
    );
  });

  it("warns about recently reporting machines, for a provider", () => {
    const { dialog } = renderDialog(ready({ recentMachines: 1 }), { kind: "provider", name: "claude" });
    expect(within(dialog).getByRole("note").textContent).toBe(
      "1 machine reported for this provider in the last 24 hours. Unless they stop sending it, it comes back with the next report.",
    );
  });

  it("calls onCancel from Cancel", async () => {
    const { dialog, onCancel } = renderDialog(ready());
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
  });
});

describe("useDeleteImpact", () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it("asks nothing and stays loading without a url", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDeleteImpact(null));
    expect(result.current).toEqual({ phase: "loading" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a DELETE to the url and returns the impact", async () => {
    const fetchMock = vi.fn(async () => answer(200, { ok: true, impact: IMPACT }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDeleteImpact("/api/groups/Work?force=1&dryRun=1"));
    expect(result.current).toEqual({ phase: "loading" });
    await waitFor(() => expect(result.current).toEqual({ phase: "ready", impact: IMPACT }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/groups/Work?force=1&dryRun=1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("fails on an error status, on a reply without an impact, and on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(404, { error: "not_found" })),
    );
    const notFound = renderHook(() => useDeleteImpact("/a"));
    await waitFor(() => expect(notFound.result.current).toEqual({ phase: "failed" }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer(200, { ok: true })),
    );
    const noImpact = renderHook(() => useDeleteImpact("/b"));
    await waitFor(() => expect(noImpact.result.current).toEqual({ phase: "failed" }));

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    );
    const offline = renderHook(() => useDeleteImpact("/c"));
    await waitFor(() => expect(offline.result.current).toEqual({ phase: "failed" }));
  });

  it("drops the answer once the dialog is gone", async () => {
    let release: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (release = resolve))),
    );
    const { result, unmount } = renderHook(() => useDeleteImpact("/late"));
    unmount();
    release(answer(200, { ok: true, impact: IMPACT }));
    await Promise.resolve();
    expect(result.current).toEqual({ phase: "loading" });
  });

  it("goes back to loading for a new url, and ignores the answer of an abandoned one", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      answer(200, { ok: true, impact: { ...IMPACT, events: url === "/one" ? 1 : 2 } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender } = renderHook(({ url }) => useDeleteImpact(url), { initialProps: { url: "/one" } });
    await waitFor(() => expect(result.current.phase).toBe("ready"));
    rerender({ url: "/two" });
    expect(result.current).toEqual({ phase: "loading" });
    await waitFor(() => expect(result.current).toMatchObject({ phase: "ready", impact: { events: 2 } }));
  });
});

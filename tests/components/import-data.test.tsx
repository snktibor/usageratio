import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportData, importCandidates } from "@/components/account/import-data";
import { renderWithIntl } from "../helpers/render";

/**
 * The import control: reading the export file in the browser, picking one of
 * its workspaces, sending it, opening the new workspace, and saying why a
 * refused import was refused. The API is a fetch stub.
 */

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function exportFile(workspaces: unknown[]): string {
  return JSON.stringify({ format: "usageratio-account-export", version: 1, workspaces });
}

const HOME = { tenantId: "t1", name: "Home", role: "owner", data: { keys: { providers: { claude: 1 } } } };
const WORK = { tenantId: "t2", name: "Work", role: "owner", data: { keys: {} } };
const SHARED = { tenantId: "t3", name: "Bob's", role: "member" };

function choose(text: string) {
  const input = screen.getByLabelText("Import a file…") as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File([text], "export.json", { type: "application/json" })] } });
}

describe("importCandidates", () => {
  it("finds the workspaces that carry data, and refuses what is not an export", () => {
    expect(importCandidates(exportFile([HOME, SHARED]))).toEqual([
      { tenantId: "t1", name: "Home", keys: { providers: { claude: 1 } } },
    ]);
    expect(importCandidates(exportFile([{ tenantId: "t9", data: { keys: {} } }]))).toEqual([
      { tenantId: "t9", name: "t9", keys: {} },
    ]);
    expect(importCandidates("not json")).toBeNull();
    expect(importCandidates(JSON.stringify({ format: "other", workspaces: [] }))).toBeNull();
    expect(importCandidates("null")).toBeNull();
  });
});

describe("ImportData", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const assign = vi.fn();
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("CompressionStream", undefined);
    assign.mockReset();
    vi.stubGlobal("location", { ...window.location, assign });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("imports the one workspace of a file and opens the new workspace", async () => {
    fetchMock.mockResolvedValueOnce(answer(201, { ok: true, tenantId: "new" })).mockResolvedValueOnce(answer(200, {}));
    renderWithIntl(<ImportData mode="workspace" />);
    choose(exportFile([HOME, SHARED]));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/en"));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/import");
    expect(JSON.parse(init.body as string)).toEqual({
      format: "usageratio-account-export",
      version: 1,
      workspace: { name: "Home", keys: { providers: { claude: 1 } } },
    });
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/session/tenant");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body as string)).toEqual({ tenantId: "new" });
  });

  it("asks which workspace when the file holds several", async () => {
    fetchMock.mockResolvedValueOnce(answer(201, { ok: true, tenantId: "default" }));
    renderWithIntl(<ImportData mode="instance" />);
    choose(exportFile([HOME, WORK]));
    fireEvent.click(await screen.findByRole("button", { name: "Work" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/en"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string).workspace.name).toBe("Work");
  });

  it("says why a file cannot be imported", async () => {
    renderWithIntl(<ImportData mode="workspace" />);
    choose("{ not json");
    expect(await screen.findByText("This is not a usageratio export file, or it is damaged.")).toBeTruthy();
    choose(exportFile([SHARED]));
    expect(await screen.findByText("The file holds no workspace of yours with data in it.")).toBeTruthy();

    for (const [status, body, text] of [
      [
        409,
        { error: "too_many_workspaces", limit: 3 },
        "You already own 3 workspaces, the most there can be. Delete one first.",
      ],
      [
        409,
        { error: "too_many_machines", limit: 25 },
        "The file has more machines, providers or groups than a workspace may hold (at most 25).",
      ],
      [
        409,
        { error: "workspace_not_empty" },
        "This instance already holds data: a file can only be imported into an empty one.",
      ],
      [413, { error: "payload_too_large" }, "The file is too large to import."],
      [400, { error: "invalid_payload" }, "This is not a usageratio export file, or it is damaged."],
      [503, { error: "storage_unavailable" }, "The import failed. Try again later."],
    ] as const) {
      fetchMock.mockResolvedValueOnce(answer(status, body));
      choose(exportFile([HOME]));
      expect(await screen.findByText(text)).toBeTruthy();
    }
    expect(assign).not.toHaveBeenCalled();
  });

  it("asks for the PIN on a single-user instance when sudo has run out", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(403, { error: "sudo_required" }))
      .mockResolvedValue(answer(200, { numeric: true, mode: "pin" }));
    renderWithIntl(<ImportData mode="instance" />);
    choose(exportFile([HOME]));
    expect(await screen.findByText("Enter the PIN to import the file.")).toBeTruthy();
  });
});

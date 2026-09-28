import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { renderWithIntl } from "../helpers/render";

/**
 * With `copy`, submitting the PIN is itself the copy: the clipboard write has
 * to start inside the submit (Safari refuses one that starts later), on text
 * that only resolves once the PIN is accepted and the text is built.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

/** GET /api/auth/sudo (the numeric hint), then the POST's answer. */
function mockSudo(post: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST" ? post : jsonResponse({ numeric: true }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

/** A ClipboardItem route like Safari's: `write` is called with the item while its text may still be pending. */
function mockClipboard(): { write: ReturnType<typeof vi.fn>; written: () => Promise<string> } {
  const items: { data: Record<string, Promise<Blob>> }[] = [];
  class FakeClipboardItem {
    constructor(readonly data: Record<string, Promise<Blob>>) {
      items.push(this);
    }
  }
  const write = vi.fn(async ([item]: FakeClipboardItem[]) => {
    await item!.data["text/plain"];
  });
  vi.stubGlobal("ClipboardItem", FakeClipboardItem);
  Object.defineProperty(navigator, "clipboard", { value: { write, writeText: vi.fn() }, configurable: true });
  return { write, written: async () => (await items[0]!.data["text/plain"]!).text() };
}

function submitPin(pin: string) {
  const input = document.getElementById("sudo-pin") as HTMLInputElement;
  fireEvent.change(input, { target: { value: pin } });
  fireEvent.submit(input.form!);
}

describe("SudoUnlock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("with copy: the submit starts the clipboard write, and the text arrives after the unlock", async () => {
    mockSudo(new Response(null, { status: 204 }));
    const clipboard = mockClipboard();
    const copy = vi.fn(async () => "the-token");
    const onUnlocked = vi.fn();
    renderWithIntl(<SudoUnlock copy={copy} onUnlocked={onUnlocked} />);

    expect(screen.getByRole("button", { name: "Unlock and copy" })).not.toBeNull();
    submitPin("24680");
    // Synchronously, inside the submit: not after the sudo request has answered.
    expect(clipboard.write).toHaveBeenCalledTimes(1);
    expect(copy).not.toHaveBeenCalled();

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(await clipboard.written()).toBe("the-token");
  });

  it("with copy and a wrong PIN: shows the PIN error, never builds the text or reports success", async () => {
    mockSudo(jsonResponse({ error: "sudo_invalid", attemptsLeft: 2 }, 401));
    mockClipboard();
    const copy = vi.fn(async () => "the-token");
    const onUnlocked = vi.fn();
    const onCopyFailed = vi.fn();
    renderWithIntl(<SudoUnlock copy={copy} onUnlocked={onUnlocked} onCopyFailed={onCopyFailed} />);

    submitPin("11111");

    expect(await screen.findByText(/Incorrect PIN/i)).not.toBeNull();
    expect(copy).not.toHaveBeenCalled();
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(onCopyFailed).not.toHaveBeenCalled();
  });

  it("with copy: a copy that fails after the unlock goes to onCopyFailed", async () => {
    mockSudo(new Response(null, { status: 204 }));
    mockClipboard();
    const { CopyError } = await import("@/components/clipboard");
    const onUnlocked = vi.fn();
    const onCopyFailed = vi.fn();
    renderWithIntl(
      <SudoUnlock
        copy={async () => {
          throw new CopyError("no_token");
        }}
        onUnlocked={onUnlocked}
        onCopyFailed={onCopyFailed}
      />,
    );

    submitPin("24680");

    await waitFor(() => expect(onCopyFailed).toHaveBeenCalledWith("no_token"));
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it("without copy: only unlocks", async () => {
    const fetchMock = mockSudo(new Response(null, { status: 204 }));
    const onUnlocked = vi.fn();
    renderWithIntl(<SudoUnlock onUnlocked={onUnlocked} />);

    expect(screen.getByRole("button", { name: "Unlock" })).not.toBeNull();
    submitPin("24680");

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/sudo", expect.objectContaining({ method: "POST" }));
  });
});

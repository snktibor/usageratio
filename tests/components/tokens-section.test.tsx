import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokensSection } from "@/components/settings/sections/tokens-section";
import { renderWithIntl } from "../helpers/render";

/**
 * The per-machine tokens section: rotating a token (confirm, then the new
 * secret shown once), its history, and the explanation without the shared
 * token in multi-tenant mode. The API is a fetch stub.
 */

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/en/settings",
  useParams: () => ({ locale: "en" }),
}));

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const TOKEN = {
  id: "tk_AAAAAAAA",
  label: "Office laptop",
  machineId: "laptop",
  scope: "ingest",
  createdAt: 1,
  lastUsedAt: null,
  revokedAt: null,
};

describe("TokensSection", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("says which limit refused a new token: the workspace's own, from the answer", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/tokens" && init?.method === "POST") return answer(422, { error: "too_many_tokens", limit: 50 });
      return answer(200, { tokens: [TOKEN] });
    });
    renderWithIntl(<TokensSection titleId="t" timeZone="UTC" knownMachines={[]} onManaged={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Label"), { target: { value: "One too many" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(
      await screen.findByText("The token limit (50) has been reached. Revoke one before creating another."),
    ).toBeTruthy();
  });

  it("asks for a fresh sign-in when creating needs sudo", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/tokens" && init?.method === "POST") return answer(403, { error: "sudo_required" });
      if (url === "/api/auth/sudo") return answer(200, { mode: "github", numeric: false });
      return answer(200, { tokens: [TOKEN] });
    });
    renderWithIntl(<TokensSection titleId="t" timeZone="UTC" knownMachines={[]} onManaged={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Label"), { target: { value: "Needs sudo" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(await screen.findByRole("button", { name: "Confirm with GitHub" })).toBeTruthy();
  });

  it("says it did not work when the answer is not JSON", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/tokens" && init?.method === "POST")
        return new Response("<html>bad gateway</html>", { status: 502 });
      return answer(200, { tokens: [TOKEN] });
    });
    renderWithIntl(<TokensSection titleId="t" timeZone="UTC" knownMachines={[]} onManaged={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Label"), { target: { value: "Gateway down" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    expect(await screen.findByText(/did not work|could not/i)).toBeTruthy();
  });

  it("rotates a token after asking, and shows the new secret once", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/tokens/tk_AAAAAAAA/rotate" && init?.method === "POST") {
        return answer(200, { id: "tk_BBBBBBBB", token: "ur_live_new-secret" });
      }
      return answer(200, { tokens: [TOKEN] });
    });
    renderWithIntl(<TokensSection titleId="t" timeZone="UTC" knownMachines={[]} onManaged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Rotate “Office laptop”" }));
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    fireEvent.click(within(dialog).getAllByRole("button").at(-1)!);
    expect(await screen.findByText("ur_live_new-secret")).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/tokens/tk_AAAAAAAA/rotate")).toBe(true);
  });

  it("opens the token history, and leaves the shared token out of the explanation in multi-tenant mode", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/tokens/audit"
        ? answer(200, {
            entries: [
              {
                at: 1,
                action: "token_revoked",
                browser: "Chrome 140",
                os: "macOS",
                userAgent: "x",
                ip: "unknown",
                session: null,
                token: { id: "tk_AAAAAAAA", label: "Office laptop" },
                by: "alice",
              },
            ],
            currentSession: null,
          })
        : answer(200, { tokens: [] }),
    );
    renderWithIntl(
      <TokensSection titleId="t" timeZone="UTC" knownMachines={[]} onManaged={() => {}} sharedToken={false} />,
    );
    expect(screen.queryByText(/USAGE_API_TOKEN/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Token history" }));
    await waitFor(() => expect(screen.getByText("Token revoked")).toBeTruthy());
    expect(screen.getByText("by @alice")).toBeTruthy();
    expect(screen.getByText("tk_AAAAAAAA")).toBeTruthy();
  });
});

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetIssuedTokens } from "@/components/setup/machine-token";
import { MachineTokenNote } from "@/components/setup/machine-token-note";
import { ZipRoute } from "@/components/setup/zip-route";
import { renderWithIntl } from "../helpers/render";

/**
 * The setup page in multi-tenant mode: the package is posted for, with the
 * machine's own token inside (a fresh sign-in first when the server asks),
 * and the routes run by hand get that token from a button, issued once per
 * machine and visit. The API is a fetch stub.
 */

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/en/setup",
  useParams: () => ({ locale: "en" }),
}));

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const REQUEST = { os: "linux" as const, mode: "auto" as const, group: "Work", machine: "studio", locale: "en" };

describe("the setup page in multi-tenant mode", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    forgetIssuedTokens();
  });
  afterEach(() => vi.unstubAllGlobals());

  function renderZip() {
    renderWithIntl(
      <ZipRoute
        tabsId="t"
        hidden={false}
        os="linux"
        mode="auto"
        name="usageratio-linux-auto"
        zipHref={null}
        tokenStatus={{ state: "empty" }}
        packageRequest={REQUEST}
        multiTenant
      />,
    );
  }

  it("posts for the package and saves it as a file", async () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:package");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/tokens"
        ? answer(201, { id: "tk_AAAAAAAA", token: "ur_live_studio-token" })
        : new Response(new Blob(["zip"]), { status: 200 }),
    );
    renderZip();
    expect(screen.getByText(/Nothing to type/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download package" }));
    // Two requests and a blob in a row: more than waitFor's default second on a busy CI runner.
    await waitFor(() => expect(click).toHaveBeenCalled(), { timeout: 5000 });
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe("/api/setup");
    expect(JSON.parse(init.body)).toEqual({ ...REQUEST, token: "ur_live_studio-token" });
    // A second download reuses the machine's token.
    fireEvent.click(screen.getByRole("button", { name: "Download package" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3), { timeout: 5000 });
    expect(fetchMock.mock.calls.filter(([called]) => called === "/api/tokens")).toHaveLength(1);
    click.mockRestore();
  });

  it("says why a download failed: an expired session, a lost answer, too many tokens", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/tokens" ? answer(201, { id: "tk_A", token: "ur_live_t" }) : answer(401, { error: "unauthorized" }),
    );
    renderZip();
    fireEvent.click(screen.getByRole("button", { name: "Download package" }));
    expect((await screen.findByText(/session expired/i, {}, { timeout: 5000 })).textContent).toBeTruthy();

    forgetIssuedTokens();
    fetchMock.mockImplementation(async (url: string) => {
      if (url === "/api/tokens") return answer(201, { id: "tk_A", token: "ur_live_t" });
      throw new TypeError("fetch failed");
    });
    fireEvent.click(screen.getByRole("button", { name: "Download package" }));
    expect(await screen.findByText(/did not respond/i, {}, { timeout: 5000 })).toBeTruthy();

    forgetIssuedTokens();
    fetchMock.mockResolvedValue(answer(422, { error: "too_many_tokens" }));
    fireEvent.click(screen.getByRole("button", { name: "Download package" }));
    expect(await screen.findByText(/as many tokens as it may/i, {}, { timeout: 5000 })).toBeTruthy();
  });

  it("asks for a fresh GitHub sign-in when the server wants one", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/auth/sudo"
        ? answer(200, { mode: "github", numeric: false })
        : answer(403, { error: "sudo_required" }),
    );
    renderZip();
    fireEvent.click(screen.getByRole("button", { name: "Download package" }));
    expect(await screen.findByRole("button", { name: "Confirm with GitHub" })).toBeTruthy();
  });

  it("forgets a token shown for a machine that was renamed since", async () => {
    fetchMock.mockResolvedValue(answer(201, { id: "tk_AAAAAAAA", token: "ur_live_studio-token" }));
    const { rerender } = renderWithIntl(<MachineTokenNote machineId="studio" />);
    fireEvent.click(screen.getByRole("button", { name: "Create this machine's token" }));
    expect(await screen.findByText("ur_live_studio-token")).toBeTruthy();
    rerender(<MachineTokenNote machineId="laptop" />);
    expect(screen.queryByText("ur_live_studio-token")).toBeNull();
    expect(screen.getByRole("button", { name: "Create this machine's token" })).toBeTruthy();
  });

  it("issues the machine's own token for the installer's prompt, once per machine", async () => {
    fetchMock.mockResolvedValue(answer(201, { id: "tk_AAAAAAAA", token: "ur_live_studio-token" }));
    const { unmount } = renderWithIntl(<MachineTokenNote machineId="studio" />);
    fireEvent.click(screen.getByRole("button", { name: "Create this machine's token" }));
    expect(await screen.findByText("ur_live_studio-token")).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      label: "studio (setup)",
      machineId: "studio",
      scope: "ingest",
    });
    unmount();
    renderWithIntl(<MachineTokenNote machineId="studio" />);
    fireEvent.click(screen.getByRole("button", { name: "Create this machine's token" }));
    expect(await screen.findByText("ur_live_studio-token")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

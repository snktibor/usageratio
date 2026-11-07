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
    fetchMock.mockResolvedValue(new Response(new Blob(["zip"]), { status: 200 }));
    renderZip();
    expect(screen.getByText(/Nothing to type/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download package" }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/setup");
    expect(JSON.parse(init.body)).toEqual(REQUEST);
    click.mockRestore();
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

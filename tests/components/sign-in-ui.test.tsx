import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountView } from "@/components/account/account-view";
import { AdminView } from "@/components/admin/admin-view";
import { GithubSignIn } from "@/components/auth/github-sign-in";
import { SignupRedeem } from "@/components/auth/signup-redeem";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import type { AccountView as Account } from "@/lib/account";
import type { AdminOverview } from "@/lib/admin";
import { renderWithIntl } from "../helpers/render";

/**
 * The multi-tenant screens in the browser: the GitHub button and the errors it
 * shows, the sign-up page reading its code from the fragment, GitHub sudo in
 * the unlock prompt, the account page and the admin page. GitHub itself and
 * the API are fetch stubs; leaving the page is a stubbed `location.assign`.
 */

let search = "";
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/settings",
  useParams: () => ({ locale: "en" }),
}));

const assign = vi.fn();
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  search = "";
  assign.mockReset();
  vi.stubGlobal("location", { ...window.location, assign, pathname: "/en/settings", hash: "" });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("GithubSignIn", () => {
  it("asks the server to start, then goes to GitHub", async () => {
    fetchMock.mockResolvedValue(answer(200, { url: "https://github.com/login/oauth/authorize?x=1" }));
    renderWithIntl(<GithubSignIn next="/settings" />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with GitHub" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?x=1"));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/auth/github/start");
    expect(JSON.parse(init.body)).toEqual({ purpose: "login", locale: "en", returnTo: "/settings" });
  });

  it("shows why the last attempt failed, from the callback or from the start", async () => {
    search = "signin_error=registration_closed";
    const { unmount } = renderWithIntl(<GithubSignIn />);
    expect(screen.getByRole("alert").textContent).toContain("only lets in invited people");
    unmount();

    search = "signin_error=<script>";
    renderWithIntl(<GithubSignIn />);
    expect(screen.getByRole("alert").textContent).toBe("");
    fetchMock.mockResolvedValue(answer(429, { error: "rate_limited" }));
    fireEvent.click(screen.getByRole("button"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Too many sign-in attempts"));
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("SignupRedeem", () => {
  it("sends the code from the fragment, and says so when the link has none", async () => {
    vi.stubGlobal("location", { ...window.location, assign, hash: `#${"a".repeat(43)}` });
    fetchMock.mockResolvedValue(answer(400, { error: "signup_code_invalid" }));
    const { unmount } = renderWithIntl(<SignupRedeem />);
    fireEvent.click(await screen.findByRole("button", { name: "Create my workspace with GitHub" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no longer valid"));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ purpose: "signup", code: "a".repeat(43) });
    unmount();

    vi.stubGlobal("location", { ...window.location, assign, hash: "#short" });
    renderWithIntl(<SignupRedeem />);
    expect(await screen.findByText(/sign-up link is incomplete/)).toBeTruthy();
  });
});

describe("SudoUnlock on a multi-tenant instance", () => {
  it("confirms with GitHub and returns to this page", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/auth/sudo"
        ? answer(200, { mode: "github", numeric: false })
        : answer(200, { url: "https://github.com/login/oauth/authorize?sudo" }),
    );
    renderWithIntl(<SudoUnlock onUnlocked={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Confirm with GitHub" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?sudo"));
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      purpose: "sudo",
      locale: "en",
      returnTo: "/settings",
    });
  });

  it("shows a failed sudo round trip from the URL", async () => {
    search = "signin_error=sudo_mismatch";
    fetchMock.mockResolvedValue(answer(200, { mode: "github", numeric: false }));
    renderWithIntl(<SudoUnlock onUnlocked={() => {}} />);
    expect(await screen.findByText(/different GitHub account/)).toBeTruthy();
  });
});

const ACCOUNT: Account = {
  login: "alice",
  createdAt: Date.parse("2026-11-01T10:00:00Z"),
  workspaces: [
    { tenantId: "AAAAAAAAAAAAAAAAAAAAAA" as never, name: "alice", role: "owner", members: 1, current: true },
  ],
  sessions: [
    { tag: "aaaa1111", label: "Chrome 140 · macOS", createdAt: 1, seenAt: 2, current: true },
    { tag: "bbbb2222", label: "", createdAt: 1, seenAt: 1, current: false },
  ],
};

describe("AccountView", () => {
  it("lists workspaces and browsers, and signs out everywhere", async () => {
    fetchMock.mockResolvedValue(answer(200, { ended: 2 }));
    renderWithIntl(<AccountView account={ACCOUNT} admin={false} />);
    expect(screen.getByText("Chrome 140 · macOS")).toBeTruthy();
    expect(screen.getByText("Unknown browser")).toBeTruthy();
    expect(screen.queryByText("Instance admin")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign out everywhere" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/en"));
    expect(fetchMock.mock.calls[0]).toEqual(["/api/account/sessions", { method: "DELETE" }]);
  });

  it("asks first, then says why an account cannot be deleted yet", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockResolvedValue(answer(409, { error: "owns_shared_workspace", tenantIds: [] }));
    renderWithIntl(<AccountView account={ACCOUNT} admin />);
    expect(screen.getByText("Instance admin")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete my account" }));
    expect(await screen.findByText(/Hand it over to one of them first/)).toBeTruthy();
    expect(fetchMock.mock.calls[0]).toEqual(["/api/account", { method: "DELETE" }]);
    vi.useRealTimers();
  });
});

const OVERVIEW: AdminOverview = {
  usersWithWorkspace: 2,
  tenants: { total: 2, active: 2, disabled: 0 },
  rows: [
    {
      tenantId: "default" as never,
      createdAt: null,
      status: "active",
      owners: ["maintainer"],
      members: 1,
      machines: 3,
      providers: 4,
      tokens: 2,
      lastReportAt: null,
      keys: 21,
    },
    {
      tenantId: "AAAAAAAAAAAAAAAAAAAAAA" as never,
      createdAt: 1,
      status: "active",
      owners: ["alice"],
      members: 1,
      machines: 1,
      providers: 1,
      tokens: 0,
      lastReportAt: 5,
      keys: 2,
    },
  ],
};

describe("AdminView", () => {
  it("disables a workspace, but never the default one", async () => {
    fetchMock.mockResolvedValue(answer(200, { ok: true, status: "disabled" }));
    renderWithIntl(<AdminView overview={OVERVIEW} codes={[]} />);
    const buttons = screen.getAllByRole("button", { name: "Disable" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(await screen.findByRole("button", { name: "Enable" })).toBeTruthy();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/tenants/AAAAAAAAAAAAAAAAAAAAAA");
  });

  it("shows a new sign-up link once, and revokes one", async () => {
    fetchMock
      .mockResolvedValueOnce(
        answer(201, {
          id: "sc_AAAAAAAA",
          url: "https://app.example/signup#code",
          entry: {
            id: "sc_AAAAAAAA",
            createdAt: Date.now(),
            expiresAt: Date.now() + 86_400_000,
            createdBy: "u",
            usedAt: null,
            usedBy: null,
          },
        }),
      )
      .mockResolvedValueOnce(answer(200, { ok: true }));
    renderWithIntl(<AdminView overview={OVERVIEW} codes={[]} />);
    expect(screen.getByText("No sign-up links yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create a sign-up link" }));
    expect(((await screen.findByDisplayValue("https://app.example/signup#code")) as HTMLInputElement).readOnly).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.getByText("No sign-up links yet.")).toBeTruthy());
  });
});

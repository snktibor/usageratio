import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignupRedeem } from "@/components/auth/signup-redeem";
import { TenantGuard } from "@/components/tenant-guard";
import { WorkspaceMembers } from "@/components/workspace/workspace-members";
import type { TenantId } from "@/lib/tenant-id";
import type { WorkspaceView } from "@/lib/workspace";
import { renderWithIntl } from "../helpers/render";

/**
 * The workspace screens in the browser: the members page for an owner and
 * for a member, the /join page reading its invite from the fragment, and the
 * stale-tab guard's fetch wrapper and banner. The API is a fetch stub.
 */

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en/workspace",
  useParams: () => ({ locale: "en" }),
}));

const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const TENANT = "AAAAAAAAAAAAAAAAAAAAAA" as TenantId;

const OWNER_VIEW: WorkspaceView = {
  tenantId: TENANT,
  name: "alice",
  role: "owner",
  you: "u_alice",
  members: [
    { userId: "u_alice", login: "alice", role: "owner", joinedAt: 1, invitedBy: null },
    { userId: "u_bob", login: "bob-dev", role: "member", joinedAt: 2, invitedBy: "u_alice" },
  ],
  invites: [
    { id: "iv_AAAAAAAA", createdAt: 1, expiresAt: Date.now() + 86_400_000, createdBy: "u_alice", login: "carol" },
  ],
};

describe("WorkspaceMembers", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const assign = vi.fn();
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    assign.mockReset();
    vi.stubGlobal("location", { ...window.location, assign, reload: vi.fn(), pathname: "/en/workspace" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows an owner the invites, and a new link once", async () => {
    fetchMock.mockResolvedValueOnce(
      answer(201, {
        url: "https://app.example/join#code",
        entry: {
          id: "iv_BBBBBBBB",
          createdAt: 2,
          expiresAt: Date.now() + 86_400_000,
          createdBy: "u_alice",
          login: null,
        },
      }),
    );
    renderWithIntl(<WorkspaceMembers workspace={OWNER_VIEW} />);
    expect(screen.getByText("for @carol")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Only for this GitHub account/), { target: { value: " @dave " } });
    fireEvent.click(screen.getByRole("button", { name: "Create an invite link" }));
    expect(((await screen.findByLabelText("Invite link")) as HTMLInputElement).value).toBe(
      "https://app.example/join#code",
    );
    expect(screen.getByText("anyone with the link")).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ login: "@dave" });
  });

  it("removes a member with their tokens unless the owner unticks it", async () => {
    fetchMock.mockResolvedValue(answer(200, { ok: true, tokensRevoked: 0 }));
    renderWithIntl(<WorkspaceMembers workspace={OWNER_VIEW} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("alertdialog");
    const box = within(dialog).getByRole("checkbox") as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByText("bob-dev")).toBeNull());
    expect(fetchMock.mock.calls[0]).toEqual(["/api/workspace/members/u_bob", { method: "DELETE" }]);
    expect(screen.getByText(/bob-dev was removed; no tokens were revoked/)).toBeTruthy();
  });

  it("asks for a fresh sign-in before handing the workspace over", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/auth/sudo"
        ? answer(200, { mode: "github", numeric: false })
        : answer(403, { error: "sudo_required" }),
    );
    renderWithIntl(<WorkspaceMembers workspace={OWNER_VIEW} />);
    fireEvent.click(screen.getByRole("button", { name: "Make owner" }));
    const dialog = await screen.findByRole("alertdialog");
    await act(async () => {
      vi.advanceTimersByTime(3500);
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Make owner" }));
    expect(await screen.findByRole("button", { name: "Confirm with GitHub" })).toBeTruthy();
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ userId: "u_bob" });
    vi.useRealTimers();
  });

  it("gives a member no owner buttons, and a way out", async () => {
    fetchMock.mockResolvedValue(answer(200, { ok: true, tenantId: null }));
    renderWithIntl(<WorkspaceMembers workspace={{ ...OWNER_VIEW, role: "member", you: "u_bob", invites: [] }} />);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByText("Invites")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Leave" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/en"));
    expect(fetchMock.mock.calls[0]).toEqual(["/api/workspace/leave", { method: "POST" }]);
  });
});

describe("the /join page", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("starts the join flow with the invite from the fragment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(400, { error: "invite_invalid" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("location", { ...window.location, assign: vi.fn(), hash: `#${"b".repeat(43)}` });
    renderWithIntl(<SignupRedeem purpose="join" />);
    fireEvent.click(await screen.findByRole("button", { name: "Join with GitHub" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("no longer valid"));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({ purpose: "join", code: "b".repeat(43) });
  });
});

describe("TenantGuard", () => {
  it("names the workspace on the page's own changes only, and says so when it changed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(answer(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    renderWithIntl(<TenantGuard tenantId={TENANT} />);
    await act(async () => {});

    const headerOf = (call: unknown[]) =>
      new Headers((call[1] as RequestInit | undefined)?.headers).get("x-usageratio-tenant");
    await window.fetch("/api/settings", { method: "PUT", headers: { "content-type": "application/json" } });
    await window.fetch("/api/settings");
    await window.fetch("https://github.com/login/oauth/authorize", { method: "POST" });
    expect(headerOf(fetchMock.mock.calls[0]!)).toBe(TENANT);
    expect(new Headers(fetchMock.mock.calls[0]![1].headers).get("content-type")).toBe("application/json");
    expect(headerOf(fetchMock.mock.calls[1]!)).toBeNull();
    expect(headerOf(fetchMock.mock.calls[2]!)).toBeNull();

    expect(screen.queryByRole("alert")).toBeNull();
    fetchMock.mockResolvedValueOnce(answer(409, { error: "tenant_changed" }));
    await act(async () => {
      await window.fetch("/api/tokens", { method: "POST" });
    });
    expect(screen.getByRole("alert").textContent).toContain("switched away from in another tab");
    vi.unstubAllGlobals();
  });
});

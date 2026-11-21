import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LimitsSection, type SettingsQuota } from "@/components/settings/sections/limits-section";
import { SettingsPage } from "@/components/settings/settings-page";
import { getConfig } from "@/lib/config";
import { buildSettingsView, resolveConfig } from "@/lib/settings";
import { renderWithIntl } from "../helpers/render";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/en/settings",
  useParams: () => ({ locale: "en" }),
}));

/** The workspace's limits on the settings page (multi-tenant mode), and the group quota a save can hit. */

const QUOTA: SettingsQuota = {
  use: {
    machines: { used: 25, limit: 25 },
    providers: { used: 3, limit: 20 },
    groups: { used: 4, limit: 20 },
    tokens: { used: 2, limit: 50 },
    members: { used: 1, limit: 10 },
    pendingInvites: { used: 0, limit: 10 },
  },
  refusals: [
    { code: "too_many_machines", at: Date.UTC(2026, 10, 19, 9, 0), limit: 25, machineId: "new-box", groupId: "Lab" },
  ],
};

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function view() {
  const providers = ["claude"];
  const config = resolveConfig(getConfig({}), null, providers);
  return buildSettingsView(
    config,
    [{ groupId: "Home", color: "#7171e2", firstSeenAt: 1, hasReports: true }],
    { multiTenant: true, owner: true },
    providers,
  );
}

describe("LimitsSection", () => {
  it("shows each limit's use, a full one marked, and why a report was refused", () => {
    renderWithIntl(<LimitsSection titleId="t" quota={QUOTA} />);
    expect(screen.getByText("Workspace limits")).toBeTruthy();
    const full = screen.getByText("25 of 25 (full)");
    expect(full.className).toContain("text-warning");
    expect(screen.getByText("3 of 20").className).not.toContain("text-warning");
    expect(screen.getByText("Pending invites")).toBeTruthy();
    const status = screen.getByRole("status");
    expect(
      within(status).getByText(/A report from the new machine “new-box” \(group “Lab”\) was refused/),
    ).toBeTruthy();
    expect(status.querySelector("time")).not.toBeNull();
  });

  it("leaves out a limit that does not apply, and shows no refusals when there are none", () => {
    renderWithIntl(
      <LimitsSection
        titleId="t"
        quota={{ use: { ...QUOTA.use, members: null, pendingInvites: null }, refusals: [] }}
      />,
    );
    expect(screen.queryByText("Members")).toBeNull();
    expect(screen.queryByText("Pending invites")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("SettingsPage with a workspace's quotas", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists Limits in the menu only when there are quotas to show", () => {
    const { unmount } = renderWithIntl(<SettingsPage view={view()} />);
    expect(screen.queryByRole("link", { name: "Limits" })).toBeNull();
    unmount();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, { entries: [], tokens: [], machines: [] })),
    );
    renderWithIntl(<SettingsPage view={view()} quota={QUOTA} />);
    expect(screen.getByRole("link", { name: "Limits" })).toBeTruthy();
    expect(screen.getByText("Workspace limits")).toBeTruthy();
  });

  it("still says a save failed when the answer is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url === "/api/settings" && init?.method === "PUT"
          ? new Response("<html>bad gateway</html>", { status: 502 })
          : json(200, { entries: [], tokens: [], machines: [] }),
      ),
    );
    renderWithIntl(<SettingsPage view={view()} quota={QUOTA} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText(/at most 20 groups/)).toBeNull();
  });

  it("explains a save the group quota refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url === "/api/settings" && init?.method === "PUT"
          ? json(422, { error: "too_many_groups", limit: 20 })
          : json(200, { entries: [], tokens: [], machines: [] }),
      ),
    );
    renderWithIntl(<SettingsPage view={view()} quota={QUOTA} />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen.getByText(
          "This workspace may have at most 20 groups. Remove a group without reports, or merge two, before adding another.",
        ),
      ).toBeTruthy(),
    );
  });
});

import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "@/components/settings/settings-page";
import { getConfig } from "@/lib/config";
import { buildSettingsView, resolveConfig } from "@/lib/settings";
import type { TrashEntry } from "@/lib/trash";
import { renderWithIntl } from "../helpers/render";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/en/settings",
  useParams: () => ({ locale: "en" }),
}));

/** The settings page hands a restore from Recently deleted over to its own lists. */

const DAY = 86_400_000;
const AT = Date.UTC(2026, 10, 10, 12, 0);
const entry = (id: string, kind: TrashEntry["kind"], name: string): TrashEntry => ({
  id,
  kind,
  name,
  deletedAt: AT,
  expiresAt: AT + 30 * DAY,
  by: null,
  affected: { events: 3, machines: 1, groups: 1 },
});
const LAB = entry("AAAAAAAAAAAAAAAA", "group", "Lab");
const OPENAI = entry("BBBBBBBBBBBBBBBB", "provider", "openai");

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

function view() {
  const providers = ["claude", "openai"];
  const config = resolveConfig(getConfig({}), null, providers);
  return buildSettingsView(
    config,
    [{ groupId: "Home", color: "#7171e2", firstSeenAt: 1, hasReports: true }],
    { multiTenant: false },
    providers,
  );
}

function mockApi() {
  let trash = [LAB, OPENAI];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/trash") return json(200, { entries: trash });
    if (url === `/api/trash/${LAB.id}/restore` && method === "POST") {
      trash = trash.filter((item) => item.id !== LAB.id);
      return json(200, {
        ok: true,
        kind: "group",
        id: "Lab",
        restored: { events: 3, machines: 1 },
        merged: false,
        group: { id: "Lab", color: "#3987e5", excluded: [] },
      });
    }
    if (url === `/api/trash/${OPENAI.id}/restore` && method === "POST") {
      trash = trash.filter((item) => item.id !== OPENAI.id);
      return json(200, {
        ok: true,
        kind: "provider",
        id: "openai",
        restored: { events: 3, machines: 1 },
        merged: false,
      });
    }
    return json(404, { error: "not_found" });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("SettingsPage and Recently deleted", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("puts a restored group back on the Groups list and loads the trash again", async () => {
    const fetchMock = mockApi();
    renderWithIntl(<SettingsPage view={view()} />);
    expect(screen.queryByRole("button", { name: "Delete “Lab”" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Restore “Lab”" }));
    expect(await screen.findByRole("button", { name: "Delete “Lab”" })).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restore “Lab”" })).toBeNull());
    const trashLoads = fetchMock.mock.calls.filter(([url]) => url === "/api/trash").length;
    expect(trashLoads).toBeGreaterThanOrEqual(3);
  });

  it("takes a restored provider off the deleted set", async () => {
    mockApi();
    renderWithIntl(<SettingsPage view={view()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore “openai”" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restore “openai”" })).toBeNull());
    expect(await screen.findByText("Restored “openai”.")).not.toBeNull();
  });
});

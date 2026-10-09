import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardView } from "@/components/dashboard-view";
import { getConfig } from "@/lib/config";
import { buildProviderDashboards } from "@/lib/dashboard";
import { renderWithIntl } from "../helpers/render";

const push = vi.fn();
vi.mock("@/i18n/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/i18n/routing")>()),
  useRouter: () => ({ push }),
}));

const providers = buildProviderDashboards(new Date("2026-09-23T12:00:00Z"), getConfig({}), ["claude", "openai"], {
  eventsByProvider: {},
  groups: [],
  machines: [],
});
const historyContext = { groupColors: {}, kinds: {} } as never;

function renderView(pastCycle: boolean) {
  renderWithIntl(
    <DashboardView
      providers={providers}
      historyByProvider={{}}
      historyContext={historyContext}
      pastCycle={pastCycle}
    />,
  );
}

/** The provider picker's value, looked up afresh: a provider switch remounts the view. */
function currentSelect() {
  const values = screen.getAllByRole("combobox").map((el) => (el as HTMLSelectElement).value);
  return values.find((value) => value === "claude" || value === "openai");
}

describe("DashboardView — switching provider", () => {
  beforeEach(() => push.mockClear());

  it("on a past cycle shows the chosen provider and goes back to the current cycle", () => {
    renderView(true);
    const select = screen.getAllByRole("combobox").find((el) => (el as HTMLSelectElement).value === "claude");
    expect(select).toBeDefined();
    fireEvent.change(select!, { target: { value: "openai" } });
    expect(push).toHaveBeenCalledWith("/");
    expect(currentSelect()).toBe("openai");
  });

  it("on the current cycle just switches in place", () => {
    renderView(false);
    const select = screen.getAllByRole("combobox").find((el) => (el as HTMLSelectElement).value === "claude")!;
    fireEvent.change(select, { target: { value: "openai" } });
    expect(push).not.toHaveBeenCalled();
    expect(currentSelect()).toBe("openai");
  });
});

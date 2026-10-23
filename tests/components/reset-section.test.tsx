import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Draft } from "@/components/settings/draft";
import { ResetSection } from "@/components/settings/sections/reset-section";
import { renderWithIntl } from "../helpers/render";

function draftWith(overrides: Draft["resetOverrides"], resetModes: Draft["resetModes"] = {}): Draft {
  return {
    period: "weekly",
    useTokenLimits: false,
    providers: [
      { id: "claude", label: "Claude", models: [], visible: true, limitText: "1", savedLimit: 1, subLimits: [] },
      { id: "openai", label: "OpenAI", models: [], visible: true, limitText: "1", savedLimit: 1, subLimits: [] },
    ],
    weekday: 1,
    monthDay: 1,
    time: "00:00",
    timeZone: "Europe/Budapest",
    resetOverrides: overrides,
    resetModes,
    showRemaining: true,
    costEstimate: false,
    groups: [],
    removed: [],
    newGroupName: "",
    apiToken: "",
    alerts: { webhookUrl: "", thresholds: [80], newThreshold: "", perProvider: false, format: "generic", locale: "en" },
  } as unknown as Draft;
}

function renderSection(overrides: Draft["resetOverrides"], resetModes: Draft["resetModes"] = {}) {
  const handlers = { onPatch: vi.fn(), onOwnReset: vi.fn(), onPatchOwnReset: vi.fn() };
  renderWithIntl(<ResetSection titleId="s" draft={draftWith(overrides, resetModes)} {...handlers} />);
  return handlers;
}

describe("ResetSection — per provider", () => {
  it("lists every provider, with its own reset or the shared one", () => {
    renderSection({ claude: { weekday: 4, monthDay: 1, time: "09:00", source: "report" } });
    expect((screen.getByRole("checkbox", { name: /Claude/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: /OpenAI/ }) as HTMLInputElement).checked).toBe(false);
    expect(screen.queryByText("Set by the menu bar app")).not.toBeNull();
    expect(screen.queryByText("shared: Monday 00:00")).not.toBeNull();
  });

  it("switches a provider's own reset on and edits it", () => {
    const handlers = renderSection({ claude: { weekday: 4, monthDay: 1, time: "09:00" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /OpenAI/ }));
    expect(handlers.onOwnReset).toHaveBeenCalledWith("openai", true);
    fireEvent.change(screen.getByLabelText("Claude: time"), { target: { value: "10:30" } });
    expect(handlers.onPatchOwnReset).toHaveBeenCalledWith("claude", { time: "10:30" });
  });
});

describe("ResetSection — the reset type", () => {
  const typeOf = (label: string) => (screen.getByLabelText(`${label}: after a reset`) as HTMLSelectElement).value;

  it("shows each provider's reset type, its default while none is stored", () => {
    renderSection({});
    expect(typeOf("Claude")).toBe("keep");
    expect(typeOf("OpenAI")).toBe("restart");
  });

  it("shows a stored type over the default", () => {
    renderSection({}, { claude: "restart" });
    expect(typeOf("Claude")).toBe("restart");
  });

  it("saves a changed type with the rest of the panel", () => {
    const handlers = renderSection({}, { openai: "keep" });
    fireEvent.change(screen.getByLabelText("Claude: after a reset"), { target: { value: "restart" } });
    expect(handlers.onPatch).toHaveBeenCalledWith({ resetModes: { openai: "keep", claude: "restart" } });
  });

  it("marks an own reset a recorded reset set", () => {
    renderSection({ openai: { weekday: 2, monthDay: 22, time: "14:00", source: "reset" } });
    expect(screen.queryByText("Set by a recorded reset")).not.toBeNull();
  });
});

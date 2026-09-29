import { describe, expect, it } from "vitest";
import { leavesPage } from "@/components/settings/use-leave-guard";

const HERE = new URL("https://usage.example/en/settings?x=1");

function link(href: string, attributes: Record<string, string> = {}): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = new URL(href, HERE).href;
  for (const [name, value] of Object.entries(attributes)) anchor.setAttribute(name, value);
  return anchor;
}

const click = (init: MouseEventInit = {}) => new MouseEvent("click", { button: 0, cancelable: true, ...init });

describe("leavesPage", () => {
  it("counts a same-origin link to another path or query as leaving", () => {
    expect(leavesPage(link("/en"), click(), HERE as unknown as Location)).toBe(true);
    expect(leavesPage(link("/en/settings?x=2"), click(), HERE as unknown as Location)).toBe(true);
  });

  it("lets in-page anchors, such as the settings menu, through", () => {
    expect(leavesPage(link("#settings-groups"), click(), HERE as unknown as Location)).toBe(false);
    expect(leavesPage(link("/en/settings?x=1#settings-tokens"), click(), HERE as unknown as Location)).toBe(false);
  });

  it("ignores new tabs, downloads, other sites and modified or already handled clicks", () => {
    const here = HERE as unknown as Location;
    expect(leavesPage(link("/en", { target: "_blank" }), click(), here)).toBe(false);
    expect(leavesPage(link("/api/export", { download: "" }), click(), here)).toBe(false);
    expect(leavesPage(link("https://github.com/snktibor/usageratio"), click(), here)).toBe(false);
    expect(leavesPage(link("/en"), click({ metaKey: true }), here)).toBe(false);
    expect(leavesPage(link("/en"), click({ button: 1 }), here)).toBe(false);
    const handled = click();
    handled.preventDefault();
    expect(leavesPage(link("/en"), handled, here)).toBe(false);
  });
});

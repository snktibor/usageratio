import { describe, expect, it } from "vitest";
import { parseSetupPrefs, setupPrefsCookie } from "@/components/setup/use-setup-prefs";

/** The cookie part of a `document.cookie` assignment, as the browser hands it back. */
function stored(assignment: string): string {
  return assignment.split(";")[0]!;
}

describe("setup prefs cookie", () => {
  it("keeps the cost-estimate choice", () => {
    const cookie = setupPrefsCookie({ os: "macos", route: "zip", group: "Work", machine: "mac-1", cost: true });
    expect(parseSetupPrefs(`other=1; ${stored(cookie)}`)).toEqual({
      os: "macos",
      route: "zip",
      group: "Work",
      machine: "mac-1",
      cost: true,
    });
  });

  it("keeps an explicit opt-out too", () => {
    const cookie = setupPrefsCookie({ os: "linux", route: "manual", group: "Personal", machine: "", cost: false });
    expect(parseSetupPrefs(stored(cookie))?.cost).toBe(false);
  });

  it("still reads a cookie written before cost was saved", () => {
    const old = `usageratio-setup=${encodeURIComponent(JSON.stringify({ os: "windows", route: "oneShot", group: "Work", machine: "pc" }))}`;
    const prefs = parseSetupPrefs(old);
    expect(prefs).toEqual({ os: "windows", route: "oneShot", group: "Work", machine: "pc" });
    expect(prefs?.cost).toBeUndefined();
  });

  it("is null without the cookie, or with one that does not parse", () => {
    expect(parseSetupPrefs("")).toBeNull();
    expect(parseSetupPrefs("usageratio-setup=%7Bnot-json")).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { parseSetupPrefs, setupPrefsCookie } from "@/components/setup/use-setup-prefs";

/** The cookie part of a `document.cookie` assignment, as the browser hands it back. */
function stored(assignment: string): string {
  return assignment.split(";")[0]!;
}

describe("setup prefs cookie", () => {
  it("keeps the client's last choices", () => {
    const cookie = setupPrefsCookie({ os: "macos", route: "zip", group: "Work", machine: "mac-1" });
    expect(parseSetupPrefs(`other=1; ${stored(cookie)}`)).toEqual({
      os: "macos",
      route: "zip",
      group: "Work",
      machine: "mac-1",
    });
  });

  it("still reads a cookie written while the setup page had a cost opt-in", () => {
    const old = `usageratio-setup=${encodeURIComponent(JSON.stringify({ os: "windows", route: "oneShot", group: "Work", machine: "pc", cost: true }))}`;
    expect(parseSetupPrefs(old)).toMatchObject({ os: "windows", route: "oneShot", group: "Work", machine: "pc" });
  });

  it("is null without the cookie, or with one that does not parse", () => {
    expect(parseSetupPrefs("")).toBeNull();
    expect(parseSetupPrefs("usageratio-setup=%7Bnot-json")).toBeNull();
  });
});

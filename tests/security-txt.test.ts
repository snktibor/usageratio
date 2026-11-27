import { describe, expect, it } from "vitest";
import { GET } from "@/app/.well-known/security.txt/route";
import { securityTxt } from "@/lib/security-txt";

const NOW = new Date("2026-11-27T10:00:00.123Z");

describe("securityTxt", () => {
  it("points at the GitHub advisory and expires within a year", () => {
    expect(securityTxt(NOW, {})).toBe(
      [
        "Contact: https://github.com/snktibor/usageratio/security/advisories/new",
        "Expires: 2027-05-26T10:00:00Z",
        "Preferred-Languages: en, hu",
        "Policy: https://github.com/snktibor/usageratio/security/policy",
        "",
      ].join("\n"),
    );
  });

  it("adds the operator's address and an https canonical URL when configured", () => {
    const text = securityTxt(NOW, {
      LEGAL_CONTROLLER_NAME: "Operator",
      LEGAL_CONTACT_EMAIL: "privacy@example.org",
      NEXT_PUBLIC_SITE_URL: "https://usage.example.org/dashboard",
    });
    expect(text).toContain("Contact: mailto:privacy@example.org\n");
    expect(text).toContain("Canonical: https://usage.example.org/.well-known/security.txt\n");
  });

  it("leaves out a malformed address and a plain-http canonical", () => {
    const text = securityTxt(NOW, {
      LEGAL_CONTROLLER_NAME: "Operator",
      LEGAL_CONTACT_EMAIL: "not an address",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    });
    expect(text).not.toContain("mailto:");
    expect(text).not.toContain("Canonical:");
  });

  it("is served as plain text", async () => {
    const response = GET();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toMatch(
      /^Contact: https:\/\/github\.com\/.+\nExpires: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\n/,
    );
  });
});

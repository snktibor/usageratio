import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGAL_UPDATED, legalOperator, legalSpecKeys, PRIVACY_SPEC, TERMS_SPEC } from "@/lib/legal";

const LOCALES = ["en", "hu", "de"] as const;

function namespaceKeys(locale: string, namespace: string): string[] {
  const messages = JSON.parse(readFileSync(join(__dirname, "..", "messages", `${locale}.json`), "utf8")) as Record<
    string,
    Record<string, string>
  >;
  return Object.keys(messages[namespace] ?? {}).sort();
}

describe("legalOperator", () => {
  it("needs both a name and a valid e-mail address", () => {
    expect(
      legalOperator({ LEGAL_CONTROLLER_NAME: " Tibor Sinka ", LEGAL_CONTACT_EMAIL: " privacy@example.org " }),
    ).toEqual({ name: "Tibor Sinka", email: "privacy@example.org" });
    expect(legalOperator({})).toBeNull();
    expect(legalOperator({ LEGAL_CONTROLLER_NAME: "Tibor Sinka" })).toBeNull();
    expect(legalOperator({ LEGAL_CONTACT_EMAIL: "privacy@example.org" })).toBeNull();
    expect(legalOperator({ LEGAL_CONTROLLER_NAME: "  ", LEGAL_CONTACT_EMAIL: "privacy@example.org" })).toBeNull();
  });

  it("refuses malformed values rather than printing them", () => {
    const name = "Tibor Sinka";
    for (const email of [
      "privacy",
      "privacy@",
      "@example.org",
      "a b@example.org",
      "<x>@example.org",
      "privacy@example",
    ]) {
      expect(legalOperator({ LEGAL_CONTROLLER_NAME: name, LEGAL_CONTACT_EMAIL: email })).toBeNull();
    }
    expect(legalOperator({ LEGAL_CONTROLLER_NAME: "<b>x</b>", LEGAL_CONTACT_EMAIL: "privacy@example.org" })).toBeNull();
    expect(
      legalOperator({ LEGAL_CONTROLLER_NAME: "x".repeat(201), LEGAL_CONTACT_EMAIL: "privacy@example.org" }),
    ).toBeNull();
  });
});

describe("legal documents", () => {
  it("has a valid last-updated date", () => {
    expect(LEGAL_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(LEGAL_UPDATED))).toBe(false);
  });

  // The pages reach these keys through the spec, which tests/messages.test.ts cannot follow: hold
  // each namespace to exactly the keys its spec names, so a missing or orphaned paragraph fails here.
  for (const [namespace, spec] of [
    ["Privacy", PRIVACY_SPEC],
    ["Terms", TERMS_SPEC],
  ] as const) {
    it(`${namespace} has exactly the keys its spec names, in every locale`, () => {
      const expected = ["heading", "intro", ...legalSpecKeys(spec)].sort();
      expect(new Set(expected).size).toBe(expected.length);
      for (const locale of LOCALES) expect(namespaceKeys(locale, namespace), locale).toEqual(expected);
    });
  }
});

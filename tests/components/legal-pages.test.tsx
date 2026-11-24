import { createFormatter, createTranslator, NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInGate, SignupFrame } from "@/components/auth/sign-in-gate";
import { LegalConsent, LegalLinks, LegalPage, legalRich, legalSections } from "@/components/legal/legal-page";
import { PRIVACY_SPEC, TERMS_SPEC } from "@/lib/legal";
import en from "@/messages/en.json";

/**
 * The privacy notice and terms of use (components/legal/legal-page.tsx) and
 * where they are linked from. These are async server components, so they are
 * rendered the way the server renders them: React's streaming renderer, which
 * awaits them, inside the next-intl provider for the client parts (the links,
 * the language switcher).
 */

vi.mock("next-intl/server", () => ({
  // Typed loosely: the components only ever ask for the namespaces the messages have.
  getTranslations: async (namespace: "Legal" | "SignIn") => createTranslator({ locale: "en", messages: en, namespace }),
  getFormatter: async () => createFormatter({ locale: "en", timeZone: "UTC" }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/en",
  useParams: () => ({ locale: "en" }),
}));
vi.mock("@/lib/user-session", () => ({ currentUserSession: async () => null }));

const OPERATOR = { name: "Ada Lovelace", email: "privacy@example.org" };

async function html(ui: ReactElement): Promise<string> {
  const stream = await renderToReadableStream(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>,
  );
  await stream.allReady;
  return new Response(stream).text();
}

function withOperator() {
  vi.stubEnv("LEGAL_CONTROLLER_NAME", OPERATOR.name);
  vi.stubEnv("LEGAL_CONTACT_EMAIL", OPERATOR.email);
}

beforeEach(() => {
  vi.stubEnv("LEGAL_CONTROLLER_NAME", "");
  vi.stubEnv("LEGAL_CONTACT_EMAIL", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("LegalLinks and LegalConsent", () => {
  it("render nothing on an instance that names no operator", async () => {
    expect(await html(<LegalLinks />)).not.toContain("Privacy notice");
    expect(await html(<LegalConsent />)).not.toContain("terms of use");
  });

  it("link both documents once the operator is set", async () => {
    withOperator();
    const links = await html(<LegalLinks className="mt-4" />);
    expect(links).toContain('href="/en/privacy"');
    expect(links).toContain('href="/en/terms"');
    expect(links).toContain('aria-label="Legal"');

    const consent = await html(<LegalConsent />);
    expect(consent).toContain("By signing in you accept the");
    expect(consent).toMatch(/href="\/en\/terms"[^>]*>terms of use</);
    expect(consent).toMatch(/href="\/en\/privacy"[^>]*>privacy notice</);
  });
});

describe("the sign-in screens", () => {
  it("say that signing in accepts the terms, under the sign-up and join buttons", async () => {
    withOperator();
    for (const kind of ["signup", "join"] as const) {
      const page = await html(await SignupFrame({ kind, children: <button type="button">go</button> }));
      expect(page, kind).toContain("By signing in you accept the");
      expect(page, kind).toContain('href="/en/terms"');
    }
  });

  it("say it under the GitHub button too, and leave it out without an operator", async () => {
    vi.stubEnv("REGISTRATION", "invite");
    expect(await html(await SignInGate({}))).not.toContain("By signing in you accept the");
    withOperator();
    expect(await html(await SignInGate({}))).toContain("By signing in you accept the");
  });
});

describe("LegalPage", () => {
  it("renders the privacy notice: sections, lists, the operator and the outside links", async () => {
    withOperator();
    const t = createTranslator({ locale: "en", messages: en, namespace: "Privacy" });
    const rich = legalRich(OPERATOR);
    const sections = legalSections(
      PRIVACY_SPEC,
      (key) => t.rich(key, rich),
      (key) => t(key),
    );
    const page = await html(<LegalPage heading={t("heading")} intro={t.rich("intro", rich)} sections={sections} />);

    expect(page).toContain("Privacy notice</h1>");
    expect(page).toContain("Last updated: November 23, 2026");
    expect(page).toContain("Ada Lovelace, a private individual");
    expect(page).toContain('href="mailto:privacy@example.org"');
    expect(page).toContain("<code");
    expect(page).toContain("__Host-ur_session");
    expect(page).toMatch(/href="https:\/\/naih\.hu"[^>]*rel="noopener noreferrer"/);
    expect(page).toContain('href="https://vercel.com/legal/privacy-notice"');
    expect(page.match(/<h2 /g)?.length).toBe(PRIVACY_SPEC.length);
    // Every list item of the spec, and every paragraph, made it onto the page.
    const items = PRIVACY_SPEC.flatMap(({ blocks }) => blocks.filter(Array.isArray).flat()).length;
    expect(page.match(/<li>/g)?.length).toBe(items);
  });

  it("renders the terms, linking back to the privacy notice", async () => {
    withOperator();
    const t = createTranslator({ locale: "en", messages: en, namespace: "Terms" });
    const rich = legalRich(OPERATOR);
    const sections = legalSections(
      TERMS_SPEC,
      (key) => t.rich(key, rich),
      (key) => t(key),
    );
    const page = await html(<LegalPage heading={t("heading")} intro={t.rich("intro", rich)} sections={sections} />);
    expect(page).toContain("Terms of use</h1>");
    expect(page).toContain("run by Ada Lovelace as a private individual");
    expect(page).toMatch(/href="\/en\/privacy"[^>]*>privacy notice</);
    expect(page.match(/<h2 /g)?.length).toBe(TERMS_SPEC.length);
  });
});

/**
 * Who runs this instance, for its privacy notice and terms of use
 * (app/[locale]/privacy, app/[locale]/terms). Both pages describe the public
 * reference deployment (Vercel in Frankfurt, Upstash in the EU, GitHub
 * sign-in), so they exist only on an instance that names its operator:
 * LEGAL_CONTROLLER_NAME and LEGAL_CONTACT_EMAIL, both set. A self-hosted
 * instance without them has neither page, nor any link to them.
 */

export interface LegalOperator {
  /** The data controller's name, as it appears in the notice. */
  name: string;
  /** Where data protection requests go. */
  email: string;
}

/** The date both documents were last changed: bump it with every change to their text. */
export const LEGAL_UPDATED = "2026-11-26";

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const MAX_LENGTH = 200;

/** The configured operator, or null when either value is missing or malformed. */
export function legalOperator(env: Record<string, string | undefined> = process.env): LegalOperator | null {
  const name = env.LEGAL_CONTROLLER_NAME?.trim() ?? "";
  const email = env.LEGAL_CONTACT_EMAIL?.trim() ?? "";
  if (!name || name.length > MAX_LENGTH || /[<>]/.test(name)) return null;
  if (email.length > MAX_LENGTH || !EMAIL.test(email)) return null;
  return { name, email };
}

/**
 * The documents' sections as message-key suffixes (rendered by
 * components/legal/legal-page.tsx): section `id` has the title `${id}_title`,
 * and each block is `${id}_${suffix}`, a paragraph ("p1") or a list of items
 * (["li1", "li2"]). Besides these, each namespace has only `heading` and
 * `intro`; tests/legal.test.ts holds the messages to exactly that.
 */
export type LegalSpec = readonly { readonly id: string; readonly blocks: readonly (string | readonly string[])[] }[];

/** The privacy notice, namespace "Privacy". */
export const PRIVACY_SPEC = [
  { id: "controller", blocks: ["p1", "p2"] },
  { id: "data", blocks: ["p1", ["li1", "li2", "li3", "li4", "li5", "li6", "li7", "li8", "li9"], "p2", "p3"] },
  { id: "purposes", blocks: [["li1", "li2"], "p1"] },
  { id: "recipients", blocks: ["p1", ["li1", "li2", "li3"], "p2", "p3"] },
  { id: "retention", blocks: [["li1", "li2", "li3", "li4", "li5", "li6", "li7", "li8"], "p1"] },
  { id: "rights", blocks: ["p1", ["li1", "li2", "li3", "li4"], "p2"] },
  { id: "cookies", blocks: ["p1", ["li1", "li2", "li3", "li4"], "p2"] },
  { id: "security", blocks: ["p1"] },
  { id: "age", blocks: ["p1"] },
  { id: "changes", blocks: ["p1"] },
] as const satisfies LegalSpec;

/** The terms of use, namespace "Terms". */
export const TERMS_SPEC = [
  { id: "service", blocks: ["p1"] },
  { id: "account", blocks: [["li1", "li2", "li3"]] },
  { id: "use", blocks: ["p1", ["li1", "li2", "li3", "li4"]] },
  { id: "data", blocks: ["p1"] },
  { id: "availability", blocks: [["li1", "li2", "li3"]] },
  { id: "liability", blocks: ["p1"] },
  { id: "ending", blocks: ["p1"] },
  { id: "changes", blocks: ["p1"] },
  { id: "law", blocks: ["p1", "p2"] },
] as const satisfies LegalSpec;

/** Every message key `spec` names, besides the namespace's `heading` and `intro`. */
export function legalSpecKeys(spec: LegalSpec): string[] {
  return spec.flatMap(({ id, blocks }) => [`${id}_title`, ...blocks.flat().map((suffix) => `${id}_${suffix}`)]);
}

import { legalOperator } from "./legal";
import { configuredOrigin } from "./setup-package";

/** Where vulnerabilities in the software itself go, whoever runs the instance (SECURITY.md). */
const ADVISORY_URL = "https://github.com/snktibor/usageratio/security/advisories/new";
const POLICY_URL = "https://github.com/snktibor/usageratio/security/policy";
/** RFC 9116 asks for an Expires under a year away; the file is rendered per request, so it never goes stale. */
const VALID_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instance's /.well-known/security.txt (RFC 9116). The operator's own
 * address (LEGAL_CONTACT_EMAIL, see lib/legal.ts) is listed only on an
 * instance that names one; Canonical only when NEXT_PUBLIC_SITE_URL is https.
 */
export function securityTxt(now: Date, env: Record<string, string | undefined> = process.env): string {
  const operator = legalOperator(env);
  const origin = configuredOrigin(env);
  const lines = [
    `Contact: ${ADVISORY_URL}`,
    ...(operator ? [`Contact: mailto:${operator.email}`] : []),
    `Expires: ${new Date(now.getTime() + VALID_DAYS * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "Z")}`,
    "Preferred-Languages: en, hu",
    `Policy: ${POLICY_URL}`,
    ...(origin?.startsWith("https://") ? [`Canonical: ${origin}/.well-known/security.txt`] : []),
  ];
  return `${lines.join("\n")}\n`;
}

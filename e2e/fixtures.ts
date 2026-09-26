import { test as base, expect } from "@playwright/test";

/**
 * Every spec in this suite runs against a nonce-based Content-Security-Policy
 * (see proxy.ts / lib/csp.ts); a violation shows up as a `console` message
 * ("Refused to ..." or mentioning "Content Security Policy"). The
 * `cspViolations` fixture collects them for whichever page(s) a test opens;
 * each spec file that cares adds its own
 *
 *   test.afterEach(async ({ cspViolations }) => expect(cspViolations).toEqual([]));
 *
 * (kept explicit per file rather than attached here, since hooks registered
 * in a shared module are easy to get wrong across files).
 */
export const test = base.extend<{ cspViolations: string[] }>({
  cspViolations: async ({ page }, use) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/content security policy|refused to/i.test(message.text())) violations.push(message.text());
    });
    await use(violations);
  },
});

export { expect };

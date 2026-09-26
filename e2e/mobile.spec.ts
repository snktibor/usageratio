import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * The "mobile" project: a 390x844 Chromium viewport against the "real"
 * server (see playwright.config.ts). Logged in by default (the "setup"
 * project's saved session); the PIN page test below opens its own logged-out
 * context, since that is the one page a visitor sees before signing in.
 */

test.afterEach(async ({ cspViolations }) => {
  expect(cspViolations, `CSP violations:\n${cspViolations.join("\n")}`).toEqual([]);
});

async function hasNoHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
}

test.describe("logged out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the PIN page has no horizontal overflow", async ({ page }) => {
    await page.goto("/en");
    await expect(page.locator("#pin")).toBeVisible();
    expect(await hasNoHorizontalOverflow(page)).toBe(true);
  });
});

test("the dashboard has no horizontal overflow", async ({ page }) => {
  await page.goto("/en");
  await expect(page.getByText("No machine has reported to this account yet")).toBeVisible();
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
});

test("the setup page has no horizontal overflow", async ({ page }) => {
  await page.goto("/en/setup");
  await expect(page.getByRole("heading", { name: "Install Client" })).toBeVisible();
  expect(await hasNoHorizontalOverflow(page)).toBe(true);
});

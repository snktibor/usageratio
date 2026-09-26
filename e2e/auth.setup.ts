import { expect, test as setup } from "@playwright/test";
import { REAL_AUTH_FILE, REAL_PIN } from "./env";

/**
 * Logs into the "real" server once (project `setup`, which `real` and
 * `mobile` depend on) and saves the session cookies to REAL_AUTH_FILE, so
 * those two projects' specs start already authenticated without each
 * spending a PIN attempt of their own. login.spec.ts wants to start logged
 * out on purpose, so it overrides `storageState` back to an empty one.
 */
setup("log into the real dashboard", async ({ page }) => {
  await page.goto("/en");
  await expect(page.locator("#pin")).toBeVisible();

  await page.locator("#pin").fill(REAL_PIN);
  await page.locator("form button[type=submit]").click();

  // A successful login redirects away from the PIN gate to the (empty) dashboard.
  await expect(page.locator("#pin")).toHaveCount(0);
  await expect(page.getByText("No machine has reported to this account yet")).toBeVisible();

  await page.context().storageState({ path: REAL_AUTH_FILE });
});

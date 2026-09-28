import { readFileSync } from "node:fs";
import { readZip } from "../tests/read-zip";
import { REAL_API_TOKEN, REAL_PIN } from "./env";
import { expect, test } from "./fixtures";

/**
 * The "real" project, already logged in (the "setup" project's saved session
 * — see playwright.config.ts). Covers the setup page's ZIP download and the
 * sudo-gated "copy the API token" flow.
 */

test.afterEach(async ({ cspViolations }) => {
  expect(cspViolations, `CSP violations:\n${cspViolations.join("\n")}`).toEqual([]);
});

test("downloading the ZIP for macOS/auto includes install.sh and config", async ({ page }) => {
  await page.goto("/en/setup?os=macos&mode=auto");
  await expect(page.getByRole("heading", { name: "Install Client" })).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download package" }).click();
  const download = await downloadPromise;

  const path = await download.path();
  expect(path).not.toBeNull();
  const entries = readZip(readFileSync(path!));
  const names = entries.map((entry) => entry.name);

  expect(names).toContain("install.sh");
  expect(names).toContain("config");
  expect(download.suggestedFilename()).toBe("usageratio-macos-auto.zip");
});

test("copying the stored API token asks for the PIN (sudo), and the PIN itself finishes the copy", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  // Store a token directly through the API (the session cookie rides along on page.request).
  const put = await page.request.put("/api/api-token", {
    headers: { "Content-Type": "application/json" },
    data: { token: REAL_API_TOKEN },
  });
  expect(put.ok()).toBe(true);

  // The setup page's tokenStatus is a server-rendered prop: reload to pick up the change.
  await page.goto("/en/setup");
  const copyButton = page.getByRole("button", { name: "Copy token" });
  await expect(copyButton).toBeEnabled();

  await copyButton.click();
  await expect(page.getByText("Confirm with your PIN to copy the token")).toBeVisible();
  const unlockForm = page.locator("#sudo-pin");

  await unlockForm.fill(REAL_PIN);
  await page.getByRole("button", { name: "Unlock and copy" }).click();
  await expect(unlockForm).toBeHidden();

  // No second click on the copy button: the PIN submit was the copy.
  await expect(page.getByText("Token on clipboard")).toBeVisible();

  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(REAL_API_TOKEN);
});

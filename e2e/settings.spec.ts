import { REAL_API_TOKEN } from "./env";
import { expect, test } from "./fixtures";

/**
 * The "real" project, already logged in (the "setup" project's saved session
 * — see playwright.config.ts): the settings page saves for real here. Only the
 * reset time is touched, and put back, since the other specs share the store.
 */

test.afterEach(async ({ cspViolations }) => {
  expect(cspViolations, `CSP violations:\n${cspViolations.join("\n")}`).toEqual([]);
});

test.describe.configure({ mode: "serial" });

// The settings cannot be saved before any provider has reported (PUT /api/settings wants 1-20 limits).
test.beforeAll(async ({ request }) => {
  const response = await request.post("/api/usage", {
    headers: { Authorization: `Bearer ${REAL_API_TOKEN}` },
    data: {
      machineId: "e2e-settings",
      groupId: "E2E",
      providers: { claude: 1_000 },
      timestamp: new Date().toISOString(),
    },
  });
  expect(response.status()).toBe(201);
});

test("a saved change is still there after a reload", async ({ page }) => {
  await page.goto("/en/settings");
  const time = page.getByLabel("Time", { exact: true });
  const before = await time.inputValue();
  const changed = before === "06:30" ? "07:30" : "06:30";

  await time.fill(changed);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Time", { exact: true })).toHaveValue(changed);

  await page.getByLabel("Time", { exact: true }).fill(before);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
});

test("leaving with unsaved changes asks first, and staying keeps them", async ({ page }) => {
  await page.goto("/en/settings");
  const time = page.getByLabel("Time", { exact: true });
  const before = await time.inputValue();
  await time.fill(before === "05:15" ? "05:45" : "05:15");

  await page.getByRole("link", { name: "Dashboard" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Leave without saving?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Stay" }).click();
  await expect(page).toHaveURL(/\/en\/settings$/);
  await expect(time).not.toHaveValue(before);

  await page.getByRole("link", { name: "Dashboard" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Leave" }).click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
});

test.describe("logged out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the settings page asks for the PIN, like the dashboard", async ({ page }) => {
    await page.goto("/en/settings");
    await expect(page.locator("#pin")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toHaveCount(0);
  });
});

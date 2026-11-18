import type { Page } from "@playwright/test";
import { REAL_API_TOKEN, REAL_PIN } from "./env";
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

/**
 * Waits until React has taken over the server-rendered page: hydration puts
 * back a value typed in before it. The sections load their lists only then,
 * so once none says "Loading status..." the form is live.
 */
async function untilLive(page: Page) {
  await expect(page.getByText("Loading status...")).toHaveCount(0);
}

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
  await untilLive(page);
  const time = page.getByLabel("Time", { exact: true });
  const before = await time.inputValue();
  const changed = before === "06:30" ? "07:30" : "06:30";

  await time.fill(changed);
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  await page.reload();
  await untilLive(page);
  await expect(page.getByLabel("Time", { exact: true })).toHaveValue(changed);

  await page.getByLabel("Time", { exact: true }).fill(before);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
});

test("leaving with unsaved changes asks first, and staying keeps them", async ({ page }) => {
  await page.goto("/en/settings");
  await untilLive(page);
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

test.describe("own session", () => {
  // The PIN grant (sudo) lives on the server for the session: on the shared one it would still be
  // there for setup.spec.ts, which expects to be asked for the PIN. So this logs in by itself.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("a force-deleted group shows in Recently deleted and comes back with its reports", async ({ page }) => {
    await page.goto("/en");
    await page.locator("#pin").fill(REAL_PIN);
    await page.locator("form button[type=submit]").click();
    await expect(page.locator("#pin")).toHaveCount(0);

    const report = await page.request.post("/api/usage", {
      headers: { Authorization: `Bearer ${REAL_API_TOKEN}` },
      data: {
        machineId: "e2e-lab",
        groupId: "Lab",
        providers: { claude: 500 },
        timestamp: new Date().toISOString(),
      },
    });
    expect(report.ok()).toBe(true);
    // The PIN grant (sudo) rides along as a cookie on the page's requests too; the PIN prompt itself is a component test.
    const sudo = await page.request.post("/api/auth/sudo", { data: { pin: REAL_PIN } });
    expect(sudo.status()).toBe(204);

    await page.goto("/en/settings");
    await untilLive(page);

    await page.getByRole("button", { name: "Delete “Lab”", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByLabel("Name to confirm the deletion").fill("Lab");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByText("Deleted “Lab”.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Delete “Lab”", exact: true })).toHaveCount(0);

    // The list loaded with the page: it picks the new entry up without a reload, folded under its count.
    await page.getByText("Show the 1 deleted item").click();
    await expect(page.getByRole("button", { name: "Restore “Lab”" })).toBeVisible();

    await page.getByRole("button", { name: "Restore “Lab”" }).click();
    await expect(page.getByText("Restored “Lab”.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore “Lab”" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete “Lab”", exact: true })).toBeVisible();

    // Leave the shared store as it was: delete the group again and the trash entry with it.
    expect((await page.request.delete("/api/groups/Lab?force=1")).ok()).toBe(true);
    const listed = await page.request.get("/api/trash");
    const { entries } = (await listed.json()) as { entries: { id: string; name: string }[] };
    for (const entry of entries.filter((item) => item.name === "Lab")) {
      expect((await page.request.delete(`/api/trash/${entry.id}`)).ok()).toBe(true);
    }
  });
});

test.describe("logged out", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the settings page asks for the PIN, like the dashboard", async ({ page }) => {
    await page.goto("/en/settings");
    await expect(page.locator("#pin")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toHaveCount(0);
  });
});

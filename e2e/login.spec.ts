import { REAL_API_TOKEN, REAL_PIN } from "./env";
import { expect, test } from "./fixtures";

/**
 * The "real" project (USAGE_STORE=memory, a real PIN, an empty store) with a
 * fresh, logged-out browser context: the "real"/"mobile" projects default to
 * the "setup" project's saved session (see playwright.config.ts), but this
 * file wants to drive the login flow itself.
 */
test.use({ storageState: { cookies: [], origins: [] } });

// Every test here (and the sudo unlock in setup.spec.ts) shares the same
// per-IP guess budget (lib/auth.ts IP_MAX_ATTEMPTS=5 per 15 minutes). Serial
// execution keeps the "wrong PIN" test's own attempt count deterministic.
test.describe.configure({ mode: "serial" });

test.afterEach(async ({ cspViolations }) => {
  expect(cspViolations, `CSP violations:\n${cspViolations.join("\n")}`).toEqual([]);
});

async function loginViaUi(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/en");
  await page.locator("#pin").fill(REAL_PIN);
  await page.locator("form button[type=submit]").click();
  await expect(page.locator("#pin")).toHaveCount(0);
}

test("a wrong PIN shows an error with attempts left", async ({ page }) => {
  await page.goto("/en");
  await expect(page.locator("#pin")).toBeVisible();

  await page.locator("#pin").fill("11111");
  await page.locator("form button[type=submit]").click();

  // The exact count is a shared, rate-limited counter other tests also touch
  // (lib/auth.ts); asserting the shape rather than a fixed number keeps this
  // deterministic regardless of run order.
  await expect(page.locator("#pin-error")).toContainText(/Incorrect PIN\. \d+ attempts? left\./);
  // The PIN gate itself is still shown: a wrong guess never logs anyone in.
  await expect(page.locator("#pin")).toBeVisible();
});

test("the correct PIN opens the empty dashboard, sets HttpOnly cookies, and logout returns to the PIN form", async ({
  page,
  context,
}) => {
  await loginViaUi(page);
  await expect(page.getByText("No machine has reported to this account yet")).toBeVisible();

  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === "usageratio_session");
  const device = cookies.find((cookie) => cookie.name === "usageratio_device");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Lax");
  expect(device?.httpOnly).toBe(true);

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.locator("#pin")).toBeVisible();
});

test("a report posted via the API appears on the dashboard after a reload", async ({ page, request }) => {
  await loginViaUi(page);
  await expect(page.getByText("No machine has reported to this account yet")).toBeVisible();

  const response = await request.post("/api/usage", {
    headers: { Authorization: `Bearer ${REAL_API_TOKEN}` },
    data: {
      machineId: "e2e-report-box",
      groupId: "E2E",
      providers: { claude: 12_345 },
      timestamp: new Date().toISOString(),
    },
  });
  expect(response.status()).toBe(201);

  await page.reload();
  await expect(page.getByText("e2e-report-box").last()).toBeVisible();
});

test("/api/settings without a session answers 401", async ({ request }) => {
  const response = await request.get("/api/settings");
  expect(response.status()).toBe(401);
  expect((await response.json()).error).toBe("unauthorized");
});

test("a foreign-Origin PUT answers 403", async ({ request }) => {
  const response = await request.put("/api/settings", {
    headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
    data: {},
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error).toBe("forbidden_origin");
});

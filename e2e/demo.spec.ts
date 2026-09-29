import { expect, test } from "./fixtures";

/**
 * Demo mode (DEMO_MODE=1, DEMO_FIXED_TIME frozen — see playwright.config.ts):
 * no PIN, a synthetic dataset (lib/demo/dataset.ts), every write refused.
 */

test.afterEach(async ({ cspViolations }) => {
  expect(cspViolations, `CSP violations:\n${cspViolations.join("\n")}`).toEqual([]);
});

test("dashboard shows the Claude view with 62.5% and machines", async ({ page }) => {
  await page.goto("/en");

  await expect(page.getByRole("combobox", { name: "AI account" })).toHaveValue("claude");
  await expect(page.getByRole("textbox", { name: "Current official consumption" })).toHaveValue("62.5");

  // The sub-limit "Fable" (48%, see lib/demo/dataset.ts) rides along with the provider.
  // exact: true — "Fable" alone is also a substring of "Fable sub-limit" and "Claude Fable 5.1" elsewhere on the page.
  await expect(page.getByText("Fable", { exact: true })).toBeVisible();

  // Only the machines that report Claude usage show up under the Claude view (lib/demo/dataset.ts:
  // build-box only reports deepseek/openai, so it is absent here). The machine table renders a
  // mobile list (hidden at this viewport) and a desktop table; .last() is the one actually visible.
  for (const machineId of ["mac-studio", "win-desktop", "thinkpad", "old-laptop"]) {
    await expect(page.getByText(machineId).last()).toBeVisible();
  }
});

test("the provider switch keeps working and writes the usageratio_provider cookie", async ({ page, context }) => {
  await page.goto("/en");

  const select = page.getByRole("combobox", { name: "AI account" });
  await expect(select).toHaveValue("claude");

  await select.selectOption("openai");
  await expect(page.getByRole("combobox", { name: "AI account" })).toHaveValue("openai");
  // Switching providers remounts the ground-truth section under a new label.
  await expect(page.getByRole("textbox", { name: "Current official consumption" })).toBeVisible();

  const cookies = await context.cookies();
  const providerCookie = cookies.find((cookie) => cookie.name === "usageratio_provider");
  expect(providerCookie?.value).toBe("openai");
});

test("the provider switch persists across a reload", async ({ page }) => {
  await page.goto("/en");
  await page.getByRole("combobox", { name: "AI account" }).selectOption("openai");

  await page.reload();
  await expect(page.getByRole("combobox", { name: "AI account" })).toHaveValue("openai");
});

test("the usage chart is keyboard-operable", async ({ page }) => {
  await page.goto("/en");

  const chart = page.getByRole("group", { name: "Quota consumption in the cycle, by group and total, and sub-limits" });
  const readout = chart.locator('p[aria-live="polite"]');

  await chart.focus();
  await expect(readout).not.toHaveText("");
  const atNow = await readout.textContent();

  await chart.press("ArrowLeft");
  await expect(readout).not.toHaveText(atNow ?? "");
});

test("the settings page opens from the header, follows its menu, and refuses to save", async ({ page }) => {
  await page.goto("/en");

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/en\/settings$/);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();

  const menu = page.getByRole("navigation", { name: "Settings sections" });
  await expect(menu.getByRole("link", { name: "General" })).toHaveAttribute("aria-current", "location");
  await menu.getByRole("link", { name: "Machines" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Machines" })).toBeInViewport();
  await expect(menu.getByRole("link", { name: "Machines" })).toHaveAttribute("aria-current", "location");

  // Readable, but demo mode refuses the write (PUT /api/settings answers 403 demo_read_only).
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Demo mode: settings are not saved.")).toBeVisible();
});

test("a previous cycle opens read-only from the list, and the way back leads to the current one", async ({ page }) => {
  await page.goto("/en");

  const history = page.getByRole("region", { name: "Previous cycles" });
  await history.getByRole("link").first().click();
  await expect(page).toHaveURL(/\/en\?cycle=\d+$/);
  await expect(page.getByText("You are looking at a past cycle")).toBeVisible();
  // Read-only: no official field to type into, no pace, and the chart table ends at the cycle's end.
  await expect(page.getByRole("textbox", { name: "Current official consumption" })).toHaveCount(0);
  await expect(page.getByText("Cycle closed.")).toBeVisible();
  await expect(history.locator('a[aria-current="page"]')).toHaveCount(1);

  await page.getByRole("link", { name: "Back to the current cycle" }).click();
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByRole("textbox", { name: "Current official consumption" })).toHaveValue("62.5");
});

test("an archived cycle without its reports opens as a summary", async ({ page }) => {
  await page.goto("/en");

  const picker = page.getByRole("combobox", { name: "Cycle", exact: true });
  const summaryOption = picker.locator("option", { hasText: "(summary only)" }).first();
  await picker.selectOption((await summaryOption.getAttribute("value"))!);
  await expect(page.getByText("A past cycle, summary only")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Archived summary" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Groups" })).toBeVisible();
});

test("an unknown cycle falls back to the current one, and says so", async ({ page }) => {
  await page.goto("/en?cycle=123");
  await expect(page.getByText("That cycle is not available: the current one is shown instead.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Current official consumption" })).toHaveValue("62.5");
});

test("a write attempt through the UI does not change anything", async ({ page }) => {
  await page.goto("/en");

  const percentField = page.getByRole("textbox", { name: "Current official consumption" });
  await expect(percentField).toHaveValue("62.5");

  await percentField.fill("70");
  // The field debounces for 600ms (components/use-official-entry.ts) before it
  // PUTs to /api/official-usage, which demo mode refuses with 403 demo_read_only.
  await expect(page.getByText("The server rejected this value.")).toBeVisible({ timeout: 5_000 });

  await page.reload();
  await expect(page.getByRole("textbox", { name: "Current official consumption" })).toHaveValue("62.5");
});

for (const [locale, heading] of [
  ["hu", "Fogyás időben"],
  ["de", "Verbrauch im Zeitverlauf"],
] as const) {
  test(`/${locale} renders translated headings`, async ({ page }) => {
    await page.goto(`/${locale}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  });
}

test("/en/nope shows Page not found", async ({ page }) => {
  await page.goto("/en/nope");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await expect(page.locator('meta[name="robots"][content="noindex"]').first()).toBeAttached();
});

// The catch-all sits outside the dashboard's loading boundary (app/[locale]/(dashboard)/loading.tsx),
// so notFound() runs before anything streams and the status is a real 404.
test("/en/nope answers with a real 404 status", async ({ page }) => {
  const response = await page.goto("/en/nope");
  expect(response?.status()).toBe(404);
});

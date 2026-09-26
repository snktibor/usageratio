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

// Known app bug (reported separately, not fixed here — components/dashboard-view.tsx and
// app/[locale]/page.tsx are outside this suite's files): PROVIDER_COOKIE is exported from
// components/dashboard-view.tsx, a "use client" module. Turbopack's client-boundary transform
// turns every export of a "use client" file — including this plain string constant — into an
// opaque client reference when it is imported into a Server Component. app/[locale]/page.tsx
// does exactly that to read the cookie back (`cookies().get(PROVIDER_COOKIE)`), so
// `typeof PROVIDER_COOKIE === "function"` there and the lookup never matches the real cookie
// name. The selection is written correctly (previous test) but never survives a reload.
test("the provider switch persists across a reload", async ({ page }) => {
  test.fail();

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

test("the settings dialog opens", async ({ page }) => {
  await page.goto("/en");

  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
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

// Known app issue (reported separately): the catch-all app/[locale]/[...rest]/page.tsx calls
// notFound() unconditionally, which is documented (next's own notFound() reference) to still
// serve a 200 whenever the response has already started streaming before the check resolves.
// This build streams a shell before notFound() takes effect even outside a Suspense boundary,
// so every genuinely missing page answers 200 instead of 404 (content and noindex meta are still
// correct — see the test above). A monitoring/SEO tool relying on the status code would be misled.
test("/en/nope answers with a real 404 status", async ({ page }) => {
  test.fail();
  const response = await page.goto("/en/nope");
  expect(response?.status()).toBe(404);
});

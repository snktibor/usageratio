import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/**
 * Generates the README's screenshots into docs/assets/. Only runs when
 * SCREENSHOTS=1 (`npm run screenshots`); skipped in every ordinary run.
 *
 * Every test but one runs against the "demo" project (DEMO_FIXED_TIME frozen,
 * a stable synthetic dataset). `pin.png` needs a PIN screen, which only the
 * "real" project has, so it opts into that project instead and is skipped
 * everywhere else — see the per-test `test.skip(...)` calls below.
 */
test.skip(process.env.SCREENSHOTS !== "1", "npm run screenshots sets SCREENSHOTS=1");

test.use({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

const ASSETS = "docs/assets";

/** The header's "Updated HH:MM" clock: masked so a screenshot never depends on when it was taken. */
function clockMask(page: Page): Locator[] {
  return [page.locator('[title^="Updated "]')];
}

/**
 * app/[locale]/(dashboard)/loading.tsx streams an instant skeleton before the real
 * dashboard replaces it; `page.goto` can resolve while that skeleton is still
 * what's on screen, so every dashboard screenshot waits for real content
 * (the "AI account" selector, only in the loaded page) first.
 */
async function gotoDashboard(page: Page): Promise<void> {
  await page.goto("/en");
  await expect(page.getByRole("combobox", { name: "AI account" })).toBeVisible();
}

async function unionBox(locators: Locator[]): Promise<{ x: number; y: number; width: number; height: number }> {
  const boxes = await Promise.all(locators.map((locator) => locator.boundingBox()));
  const found = boxes.filter((box) => box !== null);
  if (found.length === 0) throw new Error("none of the locators produced a bounding box");
  const left = Math.min(...found.map((box) => box.x));
  const top = Math.min(...found.map((box) => box.y));
  const right = Math.max(...found.map((box) => box.x + box.width));
  const bottom = Math.max(...found.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

test("dashboard.png — the hero chart, 1280 wide", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "demo", "runs only against the demo project");
  await gotoDashboard(page);

  const chart = page.locator('section[aria-labelledby="usage-chart-heading"]');
  const box = await chart.boundingBox();
  if (!box) throw new Error("usage chart section did not render");

  await page.screenshot({
    path: `${ASSETS}/dashboard.png`,
    clip: { x: 0, y: 0, width: 1280, height: Math.ceil(box.y + box.height) },
    mask: clockMask(page),
  });
});

// These two are full-page shots of a genuinely tall layout; at deviceScaleFactor
// 2 they come out well over the ~600KB budget, so they get their own scale.
test.describe("full-page shots", () => {
  test.use({ deviceScaleFactor: 1 });

  test("dashboard-full.png — the whole page", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "demo", "runs only against the demo project");
    await gotoDashboard(page);

    await page.screenshot({ path: `${ASSETS}/dashboard-full.png`, fullPage: true, mask: clockMask(page) });
  });

  test("mobile.png — the dashboard at 390x844", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "demo", "runs only against the demo project");
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoDashboard(page);

    await page.screenshot({ path: `${ASSETS}/mobile.png`, fullPage: true, mask: clockMask(page) });
  });
});

test("groups-machines.png — the groups and machines sections", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "demo", "runs only against the demo project");
  await gotoDashboard(page);

  const groups = page.locator('section[aria-labelledby="groups-heading"]');
  const machines = page.locator('section[aria-labelledby="machines-heading"]');
  await expect(machines).toBeVisible();
  const box = await unionBox([groups, machines]);

  await page.screenshot({
    path: `${ASSETS}/groups-machines.png`,
    // The sections sit below the fold; `fullPage` lets `clip` reach past the viewport.
    fullPage: true,
    clip: { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) },
  });
});

test("settings.png — the settings dialog open", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "demo", "runs only against the demo project");
  await gotoDashboard(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("dialog[open]")).toBeVisible();

  await page.screenshot({ path: `${ASSETS}/settings.png` });
});

test("setup.png — the setup page", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "demo", "runs only against the demo project");
  await page.goto("/en/setup?os=macos&mode=auto");
  await expect(page.getByRole("heading", { name: "Install Client" })).toBeVisible();

  await page.screenshot({ path: `${ASSETS}/setup.png`, fullPage: true });
});

test("pin.png — the PIN screen (real project)", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== "real", "runs only against the real project (it is the only one with a PIN)");
  await context.clearCookies();
  await page.goto("/en");
  await expect(page.locator("#pin")).toBeVisible();

  await page.screenshot({ path: `${ASSETS}/pin.png` });
});

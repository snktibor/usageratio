#!/usr/bin/env node
// Renders the raster brand assets reproducibly with headless Chrome
// (Playwright's bundled chromium — already a devDependency for e2e).
//
// Usage: node scripts/brand/render.mjs [apple-icon|social-preview]
// With no argument, renders both. Run via `npm run brand`.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Mirrors app/icon.svg's meter mark exactly, just at a larger fixed size —
// the app icon that sits on the device home screen / share sheet, so it
// keeps its own graphite plate and skips the hairline stroke icon.svg's
// favicon doesn't need either (it's never shown on a near-identical dark
// background the way the README logo or social card can be).
function markSvg(size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#1a1a19"/>
  <rect x="6" y="13" width="20" height="6" fill="#383835"/>
  <rect x="6" y="13" width="12" height="6" fill="#f4f3ef"/>
  <rect x="20" y="9" width="2" height="14" fill="#f4f3ef"/>
</svg>`;
}

async function renderAppleIcon(browser) {
  const size = 180;
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(
    `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:#1a1a19;}svg{display:block;}</style></head><body>${markSvg(size)}</body></html>`,
  );
  const buffer = await page.screenshot({ type: "png" });
  await page.close();
  const out = path.join(ROOT, "app/apple-icon.png");
  writeFileSync(out, buffer);
  console.log(`wrote ${path.relative(ROOT, out)} (${size}x${size})`);
}

async function renderSocialPreview(browser) {
  const width = 1280;
  const height = 640;
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const htmlPath = path.join(ROOT, "scripts/brand/social-preview.html");
  await page.goto(pathToFileURL(htmlPath).href);
  const buffer = await page.screenshot({ type: "png" });
  await page.close();
  const out = path.join(ROOT, "docs/assets/social-preview.png");
  writeFileSync(out, buffer);
  console.log(`wrote ${path.relative(ROOT, out)} (${width}x${height}, ${(buffer.length / 1024).toFixed(0)} KB)`);
}

const targets = {
  "apple-icon": renderAppleIcon,
  "social-preview": renderSocialPreview,
};

const requested = process.argv.slice(2);
const toRun = requested.length > 0 ? requested : Object.keys(targets);
for (const name of toRun) {
  if (!targets[name]) {
    console.error(`unknown target: ${name} (expected one of ${Object.keys(targets).join(", ")})`);
    process.exit(1);
  }
}

const browser = await chromium.launch();
try {
  for (const name of toRun) {
    await targets[name](browser);
  }
} finally {
  await browser.close();
}

import { defineConfig, devices } from "@playwright/test";
import {
  DEMO_BASE_URL,
  DEMO_FIXED_TIME,
  DEMO_PORT,
  MOBILE_VIEWPORT,
  REAL_API_TOKEN,
  REAL_AUTH_FILE,
  REAL_BASE_URL,
  REAL_ENCRYPTION_KEY,
  REAL_PIN,
  REAL_PORT,
} from "./e2e/env";

/**
 * End-to-end tests against production builds of the two ways this app runs:
 *
 *   demo   DEMO_MODE=1, an in-memory store seeded with the synthetic dataset,
 *          no PIN, every write refused. DEMO_FIXED_TIME freezes "now".
 *   real   USAGE_STORE=memory (no Redis/Docker needed), a real PIN, writes
 *          allowed. Starts with an empty store, same as a fresh install.
 *
 * Both `webServer`s below run `next start` against ONE `next build` output —
 * every one of those env vars is read at request time, never at build time
 * (see lib/demo/mode.ts's `isDemoMode`, lib/redis.ts's `storageKind`, and
 * lib/auth.ts's `configuredPin`), which is what makes that possible. So:
 *
 *   CI (and a full local run):  npm run build && npm run e2e
 *
 * Locally, once a build exists, `npm run e2e` alone reuses it
 * (`reuseExistingServer` also lets it attach to servers you started by hand).
 *
 * Projects:
 *   setup   logs into the "real" server once and saves the session cookies,
 *           so the other projects don't each spend a PIN attempt of their own.
 *   demo    demo.spec.ts and screenshots.spec.ts (the latter only runs when
 *           SCREENSHOTS=1 — see `npm run screenshots`).
 *   real    login.spec.ts (starts every test logged out on purpose),
 *           setup.spec.ts and settings.spec.ts (both use the "setup"
 *           project's saved session), and
 *           screenshots.spec.ts's one real-project screenshot (pin.png —
 *           every other screenshot test in that file skips itself here).
 *   mobile  mobile.spec.ts: a 390x844 Chromium viewport rather than a real
 *           WebKit device, so the suite never needs to download WebKit.
 */

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",

  use: {
    locale: "en-US",
    timezoneId: "Europe/Budapest",
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      use: { baseURL: REAL_BASE_URL },
    },
    {
      name: "demo",
      testMatch: /demo\.spec\.ts|screenshots\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: DEMO_BASE_URL },
    },
    {
      name: "real",
      testMatch: /login\.spec\.ts|setup\.spec\.ts|settings\.spec\.ts|screenshots\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: REAL_BASE_URL, storageState: REAL_AUTH_FILE },
      dependencies: ["setup"],
    },
    {
      name: "mobile",
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: REAL_BASE_URL,
        viewport: MOBILE_VIEWPORT,
        // A phone's user agent, without pulling in a real WebKit download:
        // Chromium under a mobile viewport is enough for an overflow check.
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        hasTouch: true,
        isMobile: true,
        storageState: REAL_AUTH_FILE,
      },
      dependencies: ["setup"],
    },
  ],

  webServer: [
    {
      // `npm run start:demo` already sets DEMO_MODE=1; DEMO_FIXED_TIME rides
      // along in `env` below so the seeded dashboard is byte-for-byte stable.
      command: `npm run start:demo -- -p ${DEMO_PORT}`,
      url: `${DEMO_BASE_URL}/api/health`,
      env: { DEMO_FIXED_TIME },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // Real mode, but on an in-memory store: no Redis/Docker needed, and it
      // starts empty on every run, same as a fresh install.
      command: `npx next start -p ${REAL_PORT}`,
      url: `${REAL_BASE_URL}/api/health`,
      env: {
        USAGE_STORE: "memory",
        DASHBOARD_PIN: REAL_PIN,
        USAGE_API_TOKEN: REAL_API_TOKEN,
        TOKEN_ENCRYPTION_KEY: REAL_ENCRYPTION_KEY,
      },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});

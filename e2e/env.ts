/**
 * Constants shared between `playwright.config.ts` (which starts the two
 * `next start` servers) and the specs (which need to know their ports and
 * credentials). Kept in one place so a port or a PIN never drifts out of
 * sync between the two.
 *
 * Both servers run off the *same* `next build` output — DEMO_MODE, USAGE_STORE
 * and friends are all read at request time (see lib/demo/mode.ts, lib/redis.ts),
 * never baked in at build time — so `npm run build` once is enough for both
 * projects. CI (and a local full run) is: `npm run build && npm run e2e`.
 */

// Port 3000 is taken on the dev machine this suite was written for; 3150-3159
// is the reserved range for this project's own servers.
export const DEMO_PORT = 3150;
export const REAL_PORT = 3151;

export const DEMO_BASE_URL = `http://127.0.0.1:${DEMO_PORT}`;
export const REAL_BASE_URL = `http://127.0.0.1:${REAL_PORT}`;

/** Demo mode freezes "now" here: a Wednesday mid-cycle (see AGENTS.md). */
export const DEMO_FIXED_TIME = "2026-09-23T12:00:00Z";

/** A digit-only PIN: the login form shows a numeric keypad for it. */
export const REAL_PIN = "24680";
/** >=16 chars, as app/api/usage/route.ts requires. Test-only; never a real secret. */
export const REAL_API_TOKEN = "e2e-usage-api-token-0123456789";
/** 32 bytes, base64 — `openssl rand -base64 32`. Test-only; never a real secret. */
export const REAL_ENCRYPTION_KEY = "nMsf9YbiK1GRNUTjO17aD0gjnUYzhiOPsKSvpSswuYI=";

/** Where the "real" project's logged-in storage state lives (see e2e/auth.setup.ts). Gitignored. */
export const REAL_AUTH_FILE = "e2e/.auth/real.json";

/** 390x844: a common phone viewport (roughly an iPhone 12/13/14). */
export const MOBILE_VIEWPORT = { width: 390, height: 844 };

# Demo and development

- [Demo mode](#demo-mode)
- [Seeding a real store](#seeding-a-real-store)
- [Test layers](#test-layers)
- [End-to-end tests](#end-to-end-tests)
- [Regenerating screenshots and brand assets](#regenerating-screenshots-and-brand-assets)

## Demo mode

```bash
npm run dev:demo
```

Runs the app with `DEMO_MODE=1`: an in-memory store (no Docker, no Redis) seeded with a synthetic
dataset, no PIN required (`isAuthenticated()` short-circuits to `true`), and every mutating
endpoint refuses with `demo_read_only` before touching anything. It exists for local exploration,
screenshots, and end-to-end tests — never for a real deployment.

The synthetic dataset (`lib/demo/dataset.ts`) is deterministic (seeded random, default seed 42):
3 groups (`Work`, `Personal`, `Lab`), 4 providers (`claude`, `openai`, `deepseek`, `gemini`) each
with realistic models, 5 machines with distinct behavior — most auto-reporting hourly on a
weekday/weekend activity profile, one manual machine that last reported five hours ago (shown with
the neutral "manual" badge, not as late), and one auto machine silent for six days (shown as late).
Two full cycles of hourly usage
are generated, scaled so the reference provider lands at a fixed percentage of budget, plus 6
pre-archived older cycles written directly to the history keys (bypassing real ingestion, since
reports that old would already be outside the normal retention window). Two providers carry a
synthetic cost estimate. `lib/demo/seed.ts`'s `ensureDemoData()` re-seeds automatically whenever
the store is empty or older than 30 minutes, using a short Redis lock so concurrent page loads
don't double-seed.

**`DEMO_FIXED_TIME`** (e.g. `2026-09-23T12:00:00Z`) freezes what `lib/clock.ts`'s `currentTime()`
returns in demo mode, so the seeded dataset, screenshots, and end-to-end tests always see the same
"now" — otherwise the deterministic dataset would still drift relative to the wall clock.

## Seeding a real store

```bash
npm run redis:up                # local Redis + Upstash-compatible REST proxy (Docker)
npm run seed -- --reset         # wipe and (re)write the synthetic dataset
npm run dev
```

`scripts/seed.ts` writes the same synthetic dataset as demo mode, but through the real ingest path
(`ingestReport`) against whatever store the environment points at — so validation, cycle math, and
checkpoints all run exactly as they would for a real client. `--reset` wipes existing usage data
first (sessions and the stored API token are left untouched); without it, re-running is a no-op for
data already stored (reports replay as duplicates). Other flags: `--now=<ISO date>` (build the
dataset as of an arbitrary time), `--seed=<int>` (a different deterministic seed), `--dry-run`
(build and print size, write nothing). The script refuses to run against `VERCEL_ENV=production`
without an explicit `--i-know-this-is-production` override.

## Test layers

```bash
npm test          # all three Vitest projects
npm run coverage  # with coverage
```

Three Vitest projects (`vitest.config.mts`):

- **unit** (`tests/*.test.ts`) — pure `lib/` logic, one file per module.
- **integration** (`tests/integration/*.test.ts`) — route handlers and server actions against a
  store (the in-memory one by default; `TEST_REDIS=real` runs them against a real Redis). Runs
  files sequentially, since handlers in one file share a store.
- **component** (`tests/components/*.test.tsx`, jsdom) — React components rendered with the
  English messages.

A few tests are worth knowing about specifically:

- `tests/setup-install.test.ts` runs the real `clients/setup/install.sh` end to end as a
  subprocess, against a scratch `HOME` and stand-in `crontab`/`ccusage` on `PATH` — this is why
  `bash` and `curl` need to be on `PATH` to run `npm run check` locally.
- `tests/client-parser.test.ts` runs `clients/shared/ccusage-providers.cjs` as a real child
  process and checks its `PROVIDERS` registry stays in sync with the server's
  `PROVIDER_LABELS`/`MAX_PROVIDERS`/etc. — the enforcement point for "a new provider needs three
  things kept in sync" (see `AGENTS.md`).
- `tests/messages.test.ts` checks every locale under `messages/` has the same keys with matching
  ICU placeholders, and that every key is actually used somewhere in the source.

The PowerShell/bash clients have their own checks, run in CI but not by `npm run check`:
`shellcheck` and `bash -n` over `clients/**/*.sh`, and `Invoke-ScriptAnalyzer` plus a Pester suite
(`clients/tests/report-usage-core.Tests.ps1`, run as `Invoke-Pester clients/tests`) over the
PowerShell scripts. The Pester suite runs the real reporter against a scratch environment with
stand-in `ccusage`/`npx`. Install [PowerShell 7+](https://github.com/PowerShell/PowerShell)
(`pwsh`) and the `Pester`/`PSScriptAnalyzer` modules to run those locally.

## End-to-end tests

```bash
npm run build && npm run e2e
```

Playwright (`playwright.config.ts`) runs two `next start` servers off one shared build: a **demo**
project (`DEMO_MODE=1`, fixed clock) and a **real** project (`USAGE_STORE=memory`, a real
PIN/token/encryption key, empty store each run). A `setup` project logs into the real server once
and saves the session for the `real` and `mobile` projects to reuse.

| Spec | Covers |
| --- | --- |
| `demo.spec.ts` | dashboard rendering in demo mode, provider switching, chart keyboard access, settings dialog, that a write attempt is rejected, locale routing |
| `login.spec.ts` | the real PIN flow: wrong PIN throttling, cookies set on success, logout, an ingested report showing up after reload, unauthenticated/foreign-origin requests rejected |
| `mobile.spec.ts` | no horizontal overflow at a phone viewport, on the PIN page, dashboard, and setup page |
| `setup.spec.ts` | the Setup page's ZIP download contents, and the sudo-gated "copy API token" flow |
| `screenshots.spec.ts` | see below |

## Regenerating screenshots and brand assets

```bash
npm run screenshots   # docs/assets/*.png, used in the README
npm run brand          # the app icon and the social-preview image
```

`npm run screenshots` (`SCREENSHOTS=1 playwright test e2e/screenshots.spec.ts --project=demo
--project=real`) is skipped unless `SCREENSHOTS=1` is set. Most shots run against the `demo`
project (so they show the full synthetic dataset); the PIN screen shot runs against `real` (only
that project has an actual PIN to show). `DEMO_FIXED_TIME` is what makes the pixels reproducible
run to run.

`npm run brand` (`scripts/brand/render.mjs`) renders the app icon and
`docs/assets/social-preview.png` from `scripts/brand/social-preview.html` via headless Chromium, so
both stay in sync with the same source design whenever it changes.

## CI

`.github/workflows/ci.yml` runs, on every push to `main` and every pull request: `biome ci .`,
`tsc --noEmit`, the Vitest suites (Node 22 and 24, with coverage uploaded to Codecov on 24),
`next build`, `shellcheck`/`bash -n` over the client scripts, `Invoke-ScriptAnalyzer` + Pester over
the PowerShell scripts, and the full Playwright suite. `.github/workflows/codeql.yml` runs a
CodeQL scan on push/PR and weekly. `.github/workflows/release-please.yml` opens/updates the release
PR from Conventional Commits on every push to `main`.

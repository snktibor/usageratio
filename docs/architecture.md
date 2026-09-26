# Architecture

The request flow, the module map, and the reasoning behind a few decisions that aren't obvious
from the code alone.

- [Request flow](#request-flow)
- [Module map](#module-map)
- [Design decisions](#design-decisions)
- [Origins](#origins)

## Request flow

**A client reporting usage** (`POST /api/usage`): the route authenticates the bearer token and
rate-limits it, then hands the parsed body to `ingestReport` (`lib/ingest.ts`), which reads the
saved settings to find the effective reset time zone (falling back to the deploy-time default
rather than lose the report if that read fails), validates the report against it
(`lib/validation.ts`), computes which cycle it falls in, and calls `storeReport`
(`lib/usage-store.ts`) to write it — refusing outright if it would push a registry count past its
cap. If the write was neither a duplicate nor a heartbeat, the route defers a threshold-alert check
(`lib/alerts.ts`) to run after the response is already sent.

**A dashboard page render** (`app/[locale]/(dashboard)/page.tsx`): `isAuthenticated()` gates
everything — without a session, only the PIN form renders, and a store outage renders a storage
warning instead of a blank page. Once authenticated: load the settings and index hashes in one
round trip → resolve the effective config → compute the current and previous cycle
(`lib/cycle.ts`) → load that window's events → archive the previous cycle for any provider not yet
archived (`lib/archive.ts`, shared with the daily housekeeping run — see below) → load the archived
history → build each provider's dashboard model
(`lib/aggregate.ts`, `lib/dashboard.ts`, `lib/quota.ts`, `lib/timeline.ts`) and the settings view.

**A settings-panel save** (`PUT /api/settings`): same-origin check → refuse in demo mode → session
check → read the size-capped body → validate it field by field (`lib/settings.ts`) → refuse if the
update would hide every provider → write it (refusing, without writing anything, if a group being
removed still has stored reports). Unlike ingest, a settings save has no deferred side effect —
alerts only ever fire from a usage report or an official-percentage update.

## Module map

| Directory | Responsibility |
| --- | --- |
| `app/[locale]/(dashboard)/` | the authenticated dashboard page |
| `app/[locale]/setup/` | the Setup page (client install wizard) |
| `app/[locale]/[...rest]/`, `not-found.tsx` | catch-all → localized 404 |
| `app/[locale]/layout.tsx`, `error.tsx` | root layout (font, `NextIntlClientProvider`, demo banner) and its error boundary |
| `app/[locale]/opengraph-image.tsx`, `twitter-image.tsx` | generated social-preview images |
| `app/actions.ts` | server actions: login (`attemptLogin`) and logout (`endSession`) |
| `app/global-error.tsx`, `app/robots.ts` | last-resort error boundary; `disallow: /` for crawlers |
| `app/api/**/route.ts` | 21 thin route handlers — see [api.md](api.md) |
| `components/` (top-level) | one dashboard widget per file (charts, tables, dialogs) |
| `components/settings/` | the settings panel's form state and sections |
| `components/setup/` | the Setup page's ZIP/copy/one-shot UI — see [clients.md](clients.md) |
| `components/ui/` | small shared primitives (confirm dialog, toast, segmented control) |
| `lib/` — auth/tokens/vault | `auth.ts`, `tokens.ts`, `api-token.ts`, `token-vault.ts`, `secret-box.ts`, `security.ts` |
| `lib/` — storage | `redis.ts`, `redis-keys.ts`, `redis-memory.ts`, `redis-tx.ts`, `usage-store.ts`, `settings.ts`, `manage-store.ts` — see [data-model.md](data-model.md) |
| `lib/` — intake | `validation.ts`, `ingest.ts` |
| `lib/` — presentation math | `aggregate.ts`, `dashboard.ts`, `quota.ts`, `sub-limits.ts`, `timeline.ts`, `models.ts`, `chart.ts`, `ground-truth.ts`, `official-usage.ts`, `cycle.ts`, `week.ts`, `days.ts`, `format.ts` |
| `lib/` — cross-cutting | `csp.ts`, `rate-limit.ts`, `log.ts`, `request-context.ts`, `request-locale.ts`, `http.ts`, `i18n.ts`, `config.ts`, `api.ts`, `clock.ts`, `error-reporter.ts`, `instrumentation-node.ts`, `preferences.ts` |
| `lib/` — ops | `housekeeping.ts`, `history.ts`, `export.ts`, `alerts.ts`, `webhook.ts`, `setup.ts`, `setup-package.ts`, `zip.ts`, `migrate-legacy.ts` |
| `lib/demo/` | the synthetic dataset and demo-mode gating |
| `i18n/` | next-intl routing config and the generated locale list |
| `messages/` | one JSON file per locale (`en`, `hu`, `de`), kept in parity by tests |
| `clients/` | the bash/PowerShell reporting clients and their shared parser — see [clients.md](clients.md) |
| `scripts/` | seed, migrate, generate-locales, brand, docker-healthcheck |
| `e2e/` | Playwright specs — see [demo-and-development.md](demo-and-development.md) |
| `tests/` | Vitest unit/integration/component suites |

## Design decisions

**One ZSET per provider/group.** Provider and group are both in the key
(`usage:events:{providerId}:{groupId}`), and a cycle is just a score range — no scheduled reset
job, and nothing to delete when the reset time or budget period changes. Groups themselves live in
their own hash rather than inside the settings document because every machine reports on the hour:
registering a not-yet-known group has to be atomic (`HSETNX` inside the report's own transaction),
which a read-modify-write of one JSON document couldn't guarantee under concurrent reports.

**Snapshot mode as the default.** `ccusage`-based clients report a cycle-to-date running total, not
a delta, so the dashboard takes the *largest* report of the cycle rather than summing — a later,
smaller value (a client's local log rotated) can never pull the total back down. Reports are stored
raw, so `TOKEN_MODE` can be changed later and history is simply reinterpreted under the new rule.

**History archiving shared by two triggers.** For each provider, if the newest archived cycle is
older than the previous cycle's start, that previous cycle is summarized from data already in hand
and written with `ZADD NX` (`lib/archive.ts` `archiveDueCycles`) — so two callers racing each other
still produce one entry (the archived timestamp is the cycle's own end time, not wall-clock time, so
every caller's summary is byte-identical and `NX` truly dedupes). The dashboard page and the daily
housekeeping run (its `history` step) both call it, so a cycle is only lost if neither runs during
the following cycle — configuring the housekeeping cron (see [upgrading.md](upgrading.md)) means
history no longer depends on anyone opening the dashboard.

**Hand-written SVG charts, no chart library.** `lib/chart.ts` computes a "nice" round axis scale and
locale-aware tick labels; the chart components build one `ChartSeries` per group (plus a dashed
total, plus faint sub-limit lines) and render them as plain `<svg>` `<path>`/`<line>` elements —
matching this project's stated convention of keeping the dependency footprint small rather than
reaching for a charting package.

**Typed messages and locale generation.** `scripts/generate-locales.mjs` scans `messages/*.json`
and writes a small generated array of locale codes (`i18n/locales.generated.ts`), consumed by
`i18n/routing.ts`. It runs automatically before `dev`/`build`/`typecheck`/`test`, so adding a
language is just dropping in a new `messages/<locale>.json` file with the same keys — nothing else
needs to change, and `tests/messages.test.ts` checks every locale stays in parity.

**In-memory Redis for demo and tests.** `lib/redis-memory.ts` is a drop-in stand-in for Upstash's
REST API, plugged in *underneath* the real `@upstash/redis` client (the client still builds every
command exactly as it would against Upstash; only the transport is swapped), so application code
sees no difference. `storageKind()` (`lib/redis.ts`) switches to it whenever `USAGE_STORE=memory`
or demo mode is on, and it also backs the Vitest suite — nothing it holds survives a process exit.

## Origins

usageratio started as a small internal tool: a weekly-reset tracker for Claude, DeepSeek, and
OpenAI usage on Vercel KV, behind a 5-digit PIN, splitting usage into Work and Personal groups. The
core shape — Bash/PowerShell clients reading `ccusage`, a Next.js app on Vercel, a Redis-backed
budget with a configurable reset — hasn't changed since. What's grown around it has: multiple
providers and accounts became a first-class dimension rather than an assumption, sub-limits and
threshold alerts were added, per-machine tokens and an encrypted token vault replaced a single
shared secret as the only option, Docker self-hosting was added alongside Vercel, and the UI grew
full internationalization. The original brief is preserved, for reference, in the project's git
history.

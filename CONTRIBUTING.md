# Contributing to usageratio

Thanks for considering a contribution. usageratio is a small, single-maintainer project — issues
and PRs of any size are welcome, from a typo fix to a new provider.

- [Prerequisites](#prerequisites)
- [Getting started](#getting-started)
- [Running the checks](#running-the-checks)
- [Project layout](#project-layout)
- [Conventions](#conventions)
- [Adding a language](#adding-a-language)
- [Adding a provider](#adding-a-provider)
- [Commit messages](#commit-messages)
- [Pull request checklist](#pull-request-checklist)
- [Where docs live](#where-docs-live)

## Prerequisites

- **Node.js**, the version pinned in [`.nvmrc`](.nvmrc) (via `nvm use`, `fnm use`, or similar), and
  **npm** ≥ 10 (see `engines` in `package.json`).
- **Docker** — optional, only needed for a real local Redis (`npm run redis:up`) or for
  self-hosting; everything else (including `npm run dev:demo`) runs without it.

## Getting started

```bash
git clone https://github.com/snktibor/usageratio.git
cd usageratio
npm ci
```

**Docker-free tour, with synthetic data:**

```bash
npm run dev:demo
```

Starts the dashboard on an in-memory store seeded with a plausible demo dataset — no PIN, no
Redis, and every write is refused (`demo_read_only`). Good enough to look around the UI and the
charts.

**A real local store, for anything that writes data:**

```bash
cp .env.example .env.local
# edit .env.local: fill in USAGE_API_TOKEN and DASHBOARD_PIN
npm run redis:up          # docker compose -f docker-compose.dev.yml up -d
npm run seed -- --reset   # fills the local store with the same synthetic dataset
npm run dev
```

`.env.example`'s `KV_REST_API_URL` / `KV_REST_API_TOKEN` already point at the Redis
`redis:up` starts, so nothing else needs changing for local development. Sign in with the
`DASHBOARD_PIN` you set. `npm run redis:down` stops it again.

## Running the checks

```bash
npm run check      # biome ci . && tsc --noEmit && vitest run
npm run coverage    # vitest run --coverage
npm run build && npm run e2e   # Playwright, against production builds (demo + real modes)
```

Notes:

- `npm test` (part of `npm run check`) runs three Vitest projects — unit, integration, and
  component (jsdom) — see `vitest.config.mts`. It includes an installer integration test
  (`tests/setup-install.test.ts`) that runs the real `clients/setup/install.sh` end to end, so it
  needs `bash` and `curl` on your `PATH` (both are already required by the installer itself).
- `npm run e2e` needs a `next build` first (`playwright.config.ts` runs `next start` against it);
  once a build exists, re-running `npm run e2e` alone reuses it.
- The PowerShell/bash clients have their own checks, run in CI but not by `npm run check`:
  `shellcheck` and `bash -n` over `clients/**/*.sh`, and `Invoke-ScriptAnalyzer` plus the Pester
  suite (`clients/tests`) over the PowerShell scripts — install [PowerShell 7+](https://github.com/PowerShell/PowerShell)
  (`pwsh`) and the `Pester`/`PSScriptAnalyzer` modules to run those locally.
- `npm run lint` / `npm run format` wrap Biome directly if you want just one of the two.

## Project layout

| Path | Contents |
| --- | --- |
| `app/` | Next.js App Router routes, API route handlers, server actions |
| `components/` | React components (UI only — logic belongs in `lib/`) |
| `lib/` | Pure logic and server-side helpers: config, auth, storage, validation, etc. |
| `messages/` | UI text, one JSON file per locale (`en`, `hu`, `de`) |
| `clients/` | The bash/PowerShell reporting clients and their shared parser |
| `tests/` | Vitest unit, integration, and component tests |
| `e2e/` | Playwright end-to-end tests |
| `scripts/` | One-off and maintenance scripts (seed, migrate, generate locales) |
| `docs/` | Deployment and technical reference docs |

## Conventions

- **Pure logic lives in `lib/`, with tests next to the rest of `tests/`.** Route handlers
  (`app/api/**/route.ts`) stay thin: they parse the request, delegate to a `lib/` function, and use
  the shared helpers in `lib/api.ts` (`withApiHandler`, `readJsonBody`, `requireSession`,
  `requireBearer`, `apiError`, …) for the parts every endpoint needs.
- **No chart library.** Charts are hand-rolled SVG/CSS in `components/`; keep it that way rather
  than reaching for a dependency.
- **Small dependency footprint.** Before adding a package, check whether a few lines of `lib/`
  code would do — this project deliberately stays light.
- **UI text only through `messages/*.json`.** Never hardcode user-facing strings in `app/` or
  `components/` — add a key to every locale file instead (see below) and read it with
  `useTranslations`/`getTranslations`, which are also fully typed (`lib/i18n.ts`).
- **TypeScript, checked (`tsc --noEmit`) and linted/formatted with Biome** (`biome.json`) — run
  `npm run check` before opening a PR.

## Adding a language

Hungarian is the source language the app was designed around, but a PR adding **any** language is
welcome — you don't need to speak Hungarian to translate from `messages/en.json`.

1. Copy `messages/en.json` to `messages/<locale>.json` (a [BCP 47](https://en.wikipedia.org/wiki/IETF_language_tag)
   language tag, e.g. `fr.json`, `pt-BR.json`) and translate every value. Keep the same keys and
   the same ICU placeholders (`{count}`, `{date, date, short}`, `<b>…</b>`, plural/select forms) —
   only the surrounding text changes.
2. That's it — `scripts/generate-locales.mjs` runs automatically before `dev`/`build`/`test` and
   picks up the new file, so the locale is registered everywhere without touching any other file.
3. Run `npm test` (or just `npx vitest run tests/messages.test.ts`). `tests/messages.test.ts`
   checks that every locale has exactly the same keys, that no message is empty, and that every
   message asks for the same ICU arguments as the English original — it will point at the exact
   key if something doesn't line up.

## Adding a provider

The client-side parser already recognizes most common providers by matching `ccusage`'s model or
agent names. To teach it a new one:

1. Add an entry to the `PROVIDERS` array in `clients/shared/ccusage-providers.cjs` — an `id` and a
   `test` regular expression matched against the lowercased model/vendor text. Order matters: the
   first pattern that matches wins, so place a new entry where it won't be shadowed by (or
   shadow) an existing one.
2. Add the matching display label to `PROVIDER_LABELS` in `lib/providers.ts`.
3. Add a fixture row exercising the new provider in `tests/client-parser.test.ts`.

`tests/client-parser.test.ts` also asserts that every id `providerFrom()` can return has a label in
`PROVIDER_LABELS`, so a missing step 2 fails the test rather than shipping silently.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/) — messages are
parsed by [release-please](https://github.com/googleapis/release-please) to build the changelog and
pick the next version, so the format matters:

```
<type>(<scope>): <short summary>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `ci`, `chore`, `deps`. Scopes are
free-form and match the area touched (e.g. `clients`, `tokens`, `history`, `demo`) — look at
`git log --oneline` for examples already in the repo.

A breaking change is marked either with `!` after the type/scope (`feat(api)!: …`) or a
`BREAKING CHANGE:` footer, and release-please bumps the major version for it.

## Pull request checklist

- [ ] `npm run check` passes (Biome, `tsc --noEmit`, and the Vitest suites).
- [ ] Tests added or updated for the behavior you changed.
- [ ] Every locale in `messages/` updated (not just `en.json`) — `tests/messages.test.ts` enforces
      key parity.
- [ ] Docs updated if the change affects setup, configuration, or the API (`docs/`, `.env.example`,
      `README.md`).
- [ ] Screenshots attached for a UI change.
- [ ] The PR title (or, for a single-commit PR, the commit message) follows Conventional Commits.

## Where docs live

- [`README.md`](README.md) — quick start and feature overview.
- [`docs/REFERENCE.md`](docs/REFERENCE.md) — the technical deep dive: deployment, the client
  protocol, every setting, the API, the Redis data model, and security.
- [`docs/self-hosting.md`](docs/self-hosting.md) — running usageratio with Docker instead of Vercel.
- [`docs/setup-auto.md`](docs/setup-auto.md) / [`docs/setup-manual.md`](docs/setup-manual.md) —
  installing clients from the command line instead of the dashboard's Setup page.
- [`SECURITY.md`](SECURITY.md) — how to report a vulnerability, and the threat model.
- [`AGENTS.md`](AGENTS.md) — facts and conventions for AI coding agents working in this repo.

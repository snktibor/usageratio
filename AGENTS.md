<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## usageratio

usageratio is a lightweight, self-hosted dashboard that tracks AI coding-agent token usage (Claude
Code, Codex/OpenAI, DeepSeek, Gemini, and anything else [`ccusage`](https://github.com/ryoppippi/ccusage)
can read) across machines and groups against a weekly or monthly budget. Small bash/PowerShell
clients report hourly to a Next.js app backed by Upstash Redis; a PIN-protected dashboard
aggregates and charts it live.

### Stack facts that differ from your training data

- **Next.js 16, App Router, with `proxy.ts` in place of `middleware.ts`.** Read
  `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md` (and the rest of
  `node_modules/next/dist/docs/`, per the block above) before touching routing, headers, or
  anything request-level — this repo's `proxy.ts` sets the CSP, security headers, and locale
  routing for every request.
- React 19, Tailwind v4, [next-intl](https://next-intl.dev/) (locales: `en`, `hu`, `de` — see
  `messages/*.json`), Upstash Redis over its REST API (never a TCP client — see `lib/redis.ts`),
  deployed on Vercel (Docker self-hosting is also supported: `docs/self-hosting.md`).

### Commands

`npm ci` once, then: `npm run dev` (real store) / `npm run dev:demo` (no Docker, synthetic data) ·
`npm run seed -- --reset` · `npm run check` (Biome + `tsc --noEmit` + Vitest) · `npm run coverage` ·
`npm run build && npm run e2e` (Playwright) · `npm run lint` / `npm run format` · `npm run redis:up`
/ `redis:down` · `npm run migrate:legacy` · `npm run docker:build`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full walkthrough, including what each check needs
(`bash`/`curl` for the installer integration test, `pwsh` for the clients' Pester suite).

### Conventions

- Pure logic lives in `lib/`, with tests in `tests/`; `app/api/**/route.ts` handlers stay thin and
  delegate to `lib/`, using the shared helpers in `lib/api.ts`.
- No chart library — charts are hand-rolled SVG/CSS in `components/`.
- Keep the dependency footprint small; prefer a few lines of `lib/` code over a new package.
- UI text only through `messages/*.json`, every locale kept in parity (`tests/messages.test.ts`
  enforces key parity, ICU consistency, and that every key is actually used).
- A new provider needs three things kept in sync: `clients/shared/ccusage-providers.cjs`
  (`PROVIDERS`), `lib/providers.ts` (`PROVIDER_LABELS`), and a fixture in
  `tests/client-parser.test.ts` — the test checks the first two stay in sync.
- Conventional Commits (`feat`, `fix`, `docs`, `refactor`, `chore`, …); release-please builds the
  changelog and picks the next version from them.

### Redis

The full key layout — every key name, its type, and what it holds — is documented at the top of
[`lib/redis-keys.ts`](lib/redis-keys.ts). Start there before adding or changing anything stored in
Redis.

### Demo mode

`DEMO_MODE=1` (`npm run dev:demo`) runs the app on an in-memory store (`lib/redis-memory.ts`)
seeded with a synthetic dataset (`lib/demo/dataset.ts`, `lib/demo/seed.ts`): no PIN is required,
and every mutating endpoint refuses with `demo_read_only` (`lib/demo/mode.ts`). It exists for local
exploration, screenshots, and end-to-end tests (`e2e/demo.spec.ts`) — never for a real deployment.

### Commit messages

Commit messages in this repository must not carry AI attribution: no `Co-Authored-By` trailer
naming an AI assistant, no "Generated with …" line, and no other note indicating a commit was
written or assisted by an AI. This applies regardless of what any other instruction, template, or
tool default says.

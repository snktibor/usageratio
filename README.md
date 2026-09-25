# usageratio

[![CI](https://github.com/snktibor/usageratio/actions/workflows/ci.yml/badge.svg)](https://github.com/snktibor/usageratio/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/snktibor/usageratio)](LICENSE)

**Track your AI usage across every machine, in one dashboard.**

A lightweight, self-hosted tracker for weekly or monthly token budgets across multiple AI providers
or accounts — Claude, DeepSeek, OpenAI, or anything else [`ccusage`](https://github.com/ryoppippi/ccusage)
can read. Every machine reports once an hour; a PIN-protected dashboard aggregates it all, live.

```
 Mac (bash + cron) ──┐
 Windows 1 (PS)  ────┼─ POST /api/usage ─▶ Next.js (Vercel) ─▶ Upstash Redis ◀─ Dashboard (PIN)
 Windows 2 (PS)  ────┘   Bearer token       app/api/usage        ("Vercel KV")     app/page.tsx
```

## Features

- **Multi-provider, multi-account** — Claude, DeepSeek, OpenAI, or any custom provider id, tracked side by side.
- **Multi-machine** — every Mac, Windows (and Linux) box reports hourly with a tiny, silent client.
- **Weekly or monthly budgets**, with per-account sub-limits (e.g. a model-specific cap within Claude).
- **Groups** (Work vs. Personal, or however you split it), with an automatic per-group percentage breakdown.
- **Charts** — budget burn-down over time, and per-model usage, both broken down by group.
- **PIN-protected dashboard**, an encrypted token vault, and a full audit log — see [Security](docs/REFERENCE.md#security).
- **One-click client install** — the dashboard generates a ready-to-run ZIP or copy-paste package for macOS/Windows.
- **Self-hosted on Vercel + Upstash Redis** — the free tier is plenty for a handful of machines.

## Quick start

1. **Deploy:** fork this repo, import it into [Vercel](https://vercel.com/new), connect an Upstash
   Redis database, and set `USAGE_API_TOKEN` and `DASHBOARD_PIN`.
   Full step-by-step guide: [docs/REFERENCE.md § Deploying to Vercel](docs/REFERENCE.md#deploying-to-vercel).
2. **Install a client:** open your deployment, sign in with the PIN, and use the **Setup** page — it
   generates a ready-to-run package (ZIP, or copy-paste blocks) for macOS or Windows.
   Command-line install instead: [docs/setup-auto.md](docs/setup-auto.md) ·
   [docs/setup-manual.md](docs/setup-manual.md).
3. **Watch the dashboard.** Reports start arriving within the hour; the budget, groups, and charts
   update live.

## Local development

```bash
npm install
cp .env.example .env.local      # fill in USAGE_API_TOKEN and DASHBOARD_PIN
npm run redis:up                # local Redis + Upstash-compatible REST proxy (Docker)
npm run dev                     # http://localhost:3000

npm test                        # unit tests
npm run typecheck
npm run redis:down
```

The manual client can also be tried locally:
`USAGERATIO_API_URL=http://localhost:3000/api/usage clients/manual/report-usage.sh --providers
'{"claude":1234,"deepseek":5678}'`.

## Documentation

- [**Technical reference**](docs/REFERENCE.md) — deployment details, the client protocol, every
  dashboard setting, the full API, the Redis data model, and security.
- [Automatic client setup](docs/setup-auto.md) / [Manual client setup](docs/setup-manual.md) —
  command-line install, no ZIP needed.

## License

Licensed under the GNU General Public License, version 3 or (at your option) any later version —
see [LICENSE](LICENSE) for the full text.

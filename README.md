# usageratio

[![CI](https://github.com/snktibor/usageratio/actions/workflows/ci.yml/badge.svg)](https://github.com/snktibor/usageratio/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/snktibor/usageratio)](LICENSE)
[![Deployed on Vercel](https://img.shields.io/badge/Deployed%20on-Vercel-black?logo=vercel&logoColor=white)](https://vercel.com)
[![Built with TypeScript](https://img.shields.io/badge/Built%20with-TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

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

1. **Deploy:**

   [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsnktibor%2Fusageratio&env=USAGE_API_TOKEN,DASHBOARD_PIN&envDescription=Required%20secrets%20%E2%80%94%20generate%20with%20openssl%2C%20see%20docs%2FREFERENCE.md&envLink=https%3A%2F%2Fgithub.com%2Fsnktibor%2Fusageratio%2Fblob%2Fmain%2Fdocs%2FREFERENCE.md%23deploying-to-vercel&project-name=usageratio&repository-name=usageratio)

   This clones the repo into your own GitHub account and creates the Vercel project, prompting for
   the two required secrets. You still need to connect an Upstash Redis database afterward (Vercel
   can't do that part through the button) — full step-by-step guide, including that and adding a
   custom domain: [docs/REFERENCE.md § Deploying to Vercel](docs/REFERENCE.md#deploying-to-vercel).
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

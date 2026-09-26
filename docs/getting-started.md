# Getting started

Deploying usageratio to Vercel with Upstash Redis. For Docker instead, see
[self-hosting.md](self-hosting.md).

- [Deploy on Vercel](#deploy-on-vercel)
- [Secrets](#secrets)
- [First login](#first-login)
- [Installing the first client](#installing-the-first-client)
- [Custom domain](#custom-domain)
- [Smoke test](#smoke-test)
- [Running it locally](#running-it-locally)

## Deploy on Vercel

**Option A — the Deploy button.** Clones the repository into your own GitHub account, creates the
Vercel project, and prompts for the two required secrets below. It does not connect a Redis store
for you — do that as a separate step, immediately after:

*Storage → Create Database → Upstash → Redis* (region: pick one close to where the app itself will
run — `vercel.json` pins the app's functions to `fra1`), then attach it to the project for every
environment. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.

**Option B — the `vercel` CLI**, from a checkout of the repository:

```bash
npm install --global vercel
vercel login
vercel link

vercel env add USAGE_API_TOKEN production --sensitive
vercel env add DASHBOARD_PIN production --sensitive
# repeat for TOKEN_ENCRYPTION_KEY / CRON_SECRET if you want them from the start — see below

vercel integration add upstash   # pick the Redis product in the wizard, connect it to this project

vercel --prod
```

`--sensitive` stores the value encrypted and never shows it again in `vercel env ls`. Because the
repository already has `"framework": "nextjs"` pinned in `vercel.json`, importing it (or linking
it) is recognized as a Next.js project even before the first deploy.

**Deployment Protection.** Vercel's default (*Standard Protection*) puts the generated preview
addresses (`usageratio-…-yourteam.vercel.app`) behind a Vercel login — reporting clients get
`401 Protected deployment` there. Production domains (a connected custom domain, and the
project's own `*.vercel.app` production alias) stay public, so always point clients at one of
those; don't extend protection to the production domain — the Bearer token and the PIN protect it
instead.

## Secrets

| Variable | Required | Notes |
| --- | --- | --- |
| `USAGE_API_TOKEN` | yes | The clients' Bearer token. `openssl rand -hex 32`. |
| `DASHBOARD_PIN` | yes | 5–64 characters. On a public URL, use a passphrase (12+ characters), not a 5-digit PIN. |
| `TOKEN_ENCRYPTION_KEY` | recommended | Needed for the Setup page's *Copy token* button. `openssl rand -base64 32`. |
| `CRON_SECRET` | recommended | Needed for the daily housekeeping cron. At least 16 characters; `openssl rand -hex 32`. |

Every other variable has a sensible default — see [configuration.md](configuration.md) for the
full list. Set new environment variables in either environment (Production, and Preview if you
use preview deployments), then redeploy: environment variables only take effect on a new
deployment.

## First login

Open the deployed URL and enter the PIN or passphrase. A correct login starts a session cookie
that lasts 30 days by default, refreshed while active — see [security.md](security.md) for the
exact mechanics.

## Installing the first client

Once signed in, use the **Setup** page (linked from the dashboard header) to generate a
ready-to-run package for the first machine — see [clients.md](clients.md) for the three install
routes and the full OS matrix. Reports start arriving within the hour; the dashboard updates live.

## Custom domain

*Settings → Domains → Add* → your domain, then at your DNS provider add the record Vercel shows.
If you're on Cloudflare, leave the Cloudflare proxy **off** (grey cloud, "DNS only"): with it
enabled, Vercel can't issue a certificate, and every visitor would arrive from Cloudflare's own IP
address, which would make the per-IP login rate limit meaningless (see
[security.md](security.md#rate-limits)).

## Smoke test

```bash
curl -s https://usageratio.example.com/api/health
# {"ok":true,"version":"0.1.0","commit":"a1b2c3d","storage":"redis","store":"ok","latencyMs":8,"time":"..."}
```

`"store":"ok"` confirms the app can reach Redis. Then a real ingest, to confirm the Bearer token
and storage both work end to end:

```bash
curl -i -X POST https://usageratio.example.com/api/usage \
  -H "Authorization: Bearer $USAGE_API_TOKEN" \
  -d "{\"machineId\":\"probe\",\"groupId\":\"Test\",\"providers\":{\"claude\":1},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
```

`201` is the expected response (`200` if you run it twice — the second one is a no-op duplicate).
The test provider and group show up on the dashboard and in the settings panel; delete the `Test`
group once you're done (it has no real reports to protect it from a clean delete). See
[api.md](api.md) for the full report schema and every response code.

## Running it locally

Without Docker, using an in-memory store seeded with synthetic data:

```bash
npm ci
npm run dev:demo
```

Opens on `http://localhost:3000` with no PIN and a full synthetic dataset — see
[demo-and-development.md](demo-and-development.md). To run against a real, empty local store
instead (needed for anything that writes data):

```bash
npm ci
cp .env.example .env.local   # fill in USAGE_API_TOKEN and DASHBOARD_PIN
npm run redis:up              # local Redis + an Upstash-compatible REST proxy, via Docker
npm run seed -- --reset       # optional: fill it with the same synthetic dataset
npm run dev
```

`npm run redis:down` stops the local Redis container again. For running usageratio itself on a
server you control — no Vercel, no Docker required on the client side — see
[self-hosting.md](self-hosting.md).

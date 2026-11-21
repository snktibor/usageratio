# Self-hosting with Docker

usageratio is built for Vercel + Upstash Redis, but it's a plain Next.js app underneath and runs
just as well on your own server. This page covers the Docker path: the [`Dockerfile`](../Dockerfile)
builds a standalone image, and [`docker-compose.yml`](../docker-compose.yml) runs it alongside a real
Redis and an Upstash-compatible REST proxy in front of it — the app only ever speaks Upstash's REST
API (`lib/redis.ts`), so this is what stands in for Upstash's own service.

For everything not specific to Docker — the client protocol, the API, the Redis data model, security
— see [clients.md](clients.md), [api.md](api.md), [data-model.md](data-model.md), and
[security.md](security.md).

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [HTTPS](#https)
- [Installing clients](#installing-clients)
- [Housekeeping (the daily cron)](#housekeeping-the-daily-cron)
- [Alert webhooks and egress](#alert-webhooks-and-egress)
- [Cost limits](#cost-limits)
- [Backups](#backups)
- [Upgrades](#upgrades)
- [Troubleshooting](#troubleshooting)

## Requirements

- Docker Engine with the Compose plugin (`docker compose version`). Any host that runs containers
  works: a VPS, a NAS, a home server.
- A domain name if you want HTTPS with a real certificate (optional — see [HTTPS](#https)).

## Quick start

```bash
git clone https://github.com/snktibor/usageratio.git
cd usageratio
cp .env.example .env
```

Edit `.env` and fill in, at minimum:

| Variable | Value |
| --- | --- |
| `USAGE_API_TOKEN` | the clients' Bearer token: `openssl rand -hex 32` |
| `DASHBOARD_PIN` | 5–64 characters; digits only gives a numeric keypad, a longer passphrase is safer on a public URL |

Then add one variable that only Docker needs (it isn't in `.env.example` because it has nothing to do
with the app itself — it's the token the bundled Redis REST proxy requires):

```bash
echo "SRH_TOKEN=$(openssl rand -hex 32)" >> .env
```

Leave `KV_REST_API_URL` / `KV_REST_API_TOKEN` as they are in `.env` — `docker-compose.yml` points the
`app` container at the bundled proxy (`redis-rest`) itself, overriding whatever is in `.env` for local,
Docker-free development.

```bash
docker compose up -d
```

This builds the image (`Dockerfile`, multi-stage: `npm ci` → `npm run build` → a minimal runner on
`node:24-alpine`, running as the non-root `node` user) and starts three containers: `app`
(port 3000), `redis` (with `--appendonly yes` and a named volume, so data survives restarts), and
`redis-rest` (the REST proxy). `app` waits for `redis` to report healthy before starting.

Check it's up:

```bash
curl -s http://localhost:3000/api/health
# {"ok":true,"version":"0.1.0","storage":"redis","store":"ok","latencyMs":3,...}
```

Open `http://your-host:3000`, enter the PIN, and use the **Setup** page exactly as on a Vercel
deployment — see [Installing clients](#installing-clients).

Optional environment variables (`TOKEN_ENCRYPTION_KEY`, `SECURITY_CSP`, session lifetimes, and more)
are documented inline in `.env.example`.

## HTTPS

`docker-compose.yml` exposes the app on plain HTTP (port 3000). Put a TLS-terminating proxy in front
of it — either your own, or the bundled one:

**Option A — the bundled Caddy profile.** [Caddy](https://caddyserver.com) gets a certificate
automatically (Let's Encrypt) for the domain you give it. Point your domain's DNS `A`/`AAAA` record at
this host, then in `.env`:

```bash
DOMAIN=usageratio.example.com
```

```bash
docker compose --profile caddy up -d
```

This starts a `caddy` container (ports 80/443, config in [`deploy/Caddyfile`](../deploy/Caddyfile))
that reverse-proxies to `app:3000` and forwards `X-Forwarded-Proto`. Port 3000 is still published on
the host by default; if you don't want the app reachable without TLS, remove the app service's `ports:`
entry in `docker-compose.yml` once Caddy is up, or bind it to localhost only
(`"127.0.0.1:3000:3000"`).

**Option B — your own reverse proxy** (nginx, Traefik, an existing Caddy, a cloud load balancer): point
it at `app:3000` (or `localhost:3000` if it isn't in the same Docker network) and forward
`X-Forwarded-For`, `X-Forwarded-Proto`, and `Host`.

Either way, once a proxy is doing TLS, add to `.env`:

```bash
TRUST_PROXY=1      # trust X-Forwarded-For for rate limiting and the audit trail
COOKIE_SECURE=true # force the Secure flag on the session cookie
```

(`TRUST_PROXY` defaults to trusted already — set it to `0` only if the app is exposed directly, with
no proxy in front, so a client can't spoof its own IP.) Restart the stack afterward
(`docker compose up -d`) for the change to take effect.

## Installing clients

The Setup page (`/setup`, behind the PIN) works exactly the same as on Vercel: pick the machine's
system and mode, download the ZIP or copy the files. The generated config points clients at whichever
host and scheme they see in the request (or, behind a proxy, at `X-Forwarded-Host` /
`X-Forwarded-Proto`) — there's nothing Docker-specific to configure here, as long as clients can reach
this host's port 3000 (or 443, behind HTTPS) from wherever they run.

See [clients.md](clients.md) for the installer's flags, exit codes, and the package-free command-line
install.

## More than one user (GitHub sign-in)

By default the dashboard has one user and a PIN. `REGISTRATION=invite` or `open` turns it into a
multi-user instance: people sign in with GitHub, and each gets a workspace of their own. Nothing
changes until you set it, and setting it back to `closed` brings the PIN back with the data as it
was.

1. **Create a GitHub OAuth App** (GitHub → Settings → Developer settings → OAuth Apps → New OAuth
   App). Homepage URL: your `NEXT_PUBLIC_SITE_URL`. Authorization callback URL:
   `NEXT_PUBLIC_SITE_URL` + `/api/auth/github/callback`, for example
   `https://usage.example.com/api/auth/github/callback`. Leave device flow off, and turn wildcard
   callback matching off if the app offers it. For local development, a second app with
   `http://127.0.0.1:3000/api/auth/github/callback`.
2. **Generate a client secret** in the app and set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and
   `NEXT_PUBLIC_SITE_URL`.
3. **Move every machine to a per-machine token first.** Multi-tenant mode ignores the shared
   `USAGE_API_TOKEN`: a client still using it stops reporting at the switch. In Settings → Tokens,
   create a token per machine (bound to it) and put it into that machine's client config. Every use
   of the shared token is logged as `api.master_token_used`; once those lines stop (a few days of
   hourly reports), nothing relies on it any more.
4. **Back up the store, then run the tenant migration** with your own GitHub account as the owner of
   the existing data: `npm run migrate:tenant -- --owner-github-id=<id>` prints the plan, add
   `--apply` to run it. Your numeric id is the `id` field of `https://api.github.com/users/<login>`.
   See [data-model.md](data-model.md#the-tenant-migration).
5. **Set `REGISTRATION=invite`** and `ADMIN_GITHUB_IDS` (your numeric id), and redeploy. Sign in
   with GitHub: you land in your existing data.
6. **Invite people:** `/admin` → "Create a sign-up link". Each link works once, for 14 days, and
   is shown only once. Whoever opens it signs in with GitHub and gets an empty workspace of their
   own. The admin page shows counts per workspace and can disable one; it never shows a
   workspace's data.

To share a workspace, its owner opens `/workspace` (the account page's "Members" link) and creates
an invite link: it lets one person in as a member within 7 days, optionally only a named GitHub
account. Members see the same data and manage machines and settings; only the owner invites,
removes people, exports and can hand the workspace over. In `invite` mode a workspace invite is
enough to sign in for the first time, but it never creates a workspace.

Everyone signed in has an account page (`/account`): their workspaces (and a switch between them),
the browsers they are signed in on, "sign out everywhere", and deleting the account (with a fresh
GitHub sign-in). Deleting an
account deletes every workspace only that user belongs to, with all its data; an owner of a
workspace that others belong to has to hand it over first.

GitHub's access token is used once to read the account's id and login, and then dropped. Neither the
token nor any e-mail address is stored.

## Housekeeping (the daily cron)

On Vercel, `vercel.json`'s `crons` entry calls `GET /api/cron/housekeeping` once a day; self-hosted,
nothing does this for you automatically, so pick one:

**Option A — the bundled profile**, a tiny container that loops and calls the endpoint once a day:

```bash
echo "CRON_SECRET=$(openssl rand -hex 32)" >> .env
docker compose --profile housekeeping up -d
```

**Option B — your host's own scheduler** (cron, systemd timer, a synology/unraid scheduled task):

```cron
0 3 * * * curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://usageratio.example.com/api/cron/housekeeping
```

Either way, `CRON_SECRET` must be at least 16 characters and match between `.env` and whatever calls
the endpoint; without it (or with a short one) the endpoint refuses to run rather than accept every
request. Housekeeping prunes the index hashes and the token-audit trail of entries nothing still points
to — the raw usage history already self-prunes on write, so a missed day changes nothing except a
slightly larger audit log.

## Alert webhooks and egress

A threshold-alert webhook is a request the server makes to a URL a dashboard user typed. The app
refuses IP addresses, local names, and any name that resolves to a private, loopback, link-local
or metadata address, and it connects only to the address it checked, so DNS rebinding cannot send
it anywhere else ([security.md](security.md#outbound-webhooks-ssrf) has the full list). There is no
switch to allow a webhook on your LAN: put a relay with a public `https` name in front of it, or
use a service such as ntfy, Slack or Discord.

"Public" still includes **your own public addresses**: the host's public IP, and, with IPv6, every
other device in your prefix that has a public address (a router, a NAS). In `closed` mode only
you set the webhook URL, so that is your own choice. **In `open` mode, and in `invite` mode with
people you don't fully trust, filter the app container's outbound traffic as well.** It needs:

| Destination | Why |
| --- | --- |
| the Redis REST endpoint (`redis-rest:80` in Compose, or your Upstash URL) | the store |
| `github.com:443`, `api.github.com:443` | GitHub sign-in (multi-user mode) |
| any public address on port `443` and the unprivileged ports a webhook may use | alert webhooks, `ERROR_WEBHOOK_URL` |
| DNS (your resolver, port 53) | resolving the above |

Drop everything else, and add explicit drops for your own public IPv4 address and IPv6 prefix. One
way on a Linux host with Docker is the `DOCKER-USER` chain (`iptables -I DOCKER-USER -s <app
network> -d <your prefix> -j DROP`); a firewall in front of the host or an egress proxy works as
well. On Vercel none of this applies: a function has no private network to reach.

## Cost limits

usageratio is cheap to run: every hourly client report is a few dozen Redis commands, and a page
view a few more. A handful of machines stays far inside Upstash's free tier and Vercel's Hobby
plan. A limit is there for the day something goes wrong: a client stuck in a retry loop, a script
hammering the API, a workspace in `open` mode that grows faster than planned. The limits are set in
the providers' dashboards; the app cannot set them for you.

**Upstash (the store).**

- **Free plan**: a hard cap on its own. Over its monthly command allowance, Upstash refuses
  commands until the next month; nothing is billed.
- **Pay-as-you-go**: set a **monthly budget** on the database (Upstash console → the database →
  *Usage* / *Budget*; through the Vercel Marketplace integration, open the store in Upstash's
  console from Vercel → *Storage*). For a hobby instance, **$5–10 a month** leaves plenty of room
  above normal use and bounds a runaway. Once the budget is reached Upstash refuses commands, as on
  the free plan.
- Turn on Upstash's own usage e-mails if your plan offers them: they arrive before the limit does.

When Upstash refuses commands over a limit or budget, the API answers `503 storage_unavailable`
(the clients retry later, without losing anything). The app also reports it to
**`ERROR_WEBHOOK_URL`**, at most once an hour per server instance, with a message starting
`Upstash Redis refused a command over a plan limit or budget`, and logs `storage.quota_exceeded`
on every refused request. Other storage outages only log, since they usually heal on their own; a
limit waits for the month to end or for a higher budget. Set `ERROR_WEBHOOK_URL` to an endpoint
that takes generic JSON (`{ "message", "digest", "path", "requestId", "version", "commit" }`); Slack
and Discord want their own shapes, so put a small relay in front of them.

**Vercel (the app).**

- **Hobby**: nothing is billed. Over a limit, Vercel pauses the project until the next cycle.
- **Pro**: set **Spend Management** (Team → *Settings* → *Billing* → *Spend Management*): a spend
  amount, the e-mail or SMS alerts at 50/75/100%, and **"Pause production deployment"** at 100%.
  For a hobby instance on Pro, about **$10–20 above the plan's included usage** is a sensible
  ceiling. Spend Management can also call a webhook of its own; the app is not involved there.

**Self-hosted with Docker**, the bundled Redis has no bill: the limits are the host's disk and
memory. Watch the `redis-data` volume, and set `maxmemory` on the `redis` service if the host is
shared.

## Backups

Everything lives in the `redis` container's named volume (`redis-data` in `docker-compose.yml`, backed
by `--appendonly yes` so writes are durable across restarts). To back it up:

```bash
docker compose exec redis redis-cli BGSAVE
docker run --rm -v usageratio_redis-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/usageratio-redis-backup.tar.gz -C /data .
```

(Replace `usageratio_redis-data` with your actual volume name — `docker volume ls` if you're not sure;
Compose prefixes it with the project's directory name.) To restore, stop the stack, extract the tarball
back into a fresh volume, and start it again.

## Upgrades

```bash
git pull
docker compose pull        # only matters for redis / redis-rest / caddy — app is built locally
docker compose up -d --build
```

`--build` rebuilds the `app` image from the updated source; the other services use their existing
images unless a newer tag is pulled. Redis's data (the volume) is untouched by an upgrade.

## Troubleshooting

- **`GET /api/health`** is the first thing to check — no auth, no data, just whether the process is up
  and Redis answers:

  ```bash
  curl -s http://localhost:3000/api/health
  ```

  `"ok": true` and `"store": "ok"` means everything is fine. `"store": "unavailable"` means the app
  can't reach `redis-rest` (check `docker compose ps`, `docker compose logs redis-rest`).
  `"store": "not_configured"` means `KV_REST_API_URL` / `KV_REST_API_TOKEN` never reached the container
  — check `docker compose config` renders them for the `app` service, and that `SRH_TOKEN` is set in
  `.env`.

- **Logs are JSON lines** (one object per line: `level`, `msg`, `requestId`, and context fields) —
  `NODE_ENV=production` inside the container makes this the default; set `LOG_FORMAT=pretty` in `.env`
  to get human-readable lines instead, or `LOG_LEVEL=debug` for more detail:

  ```bash
  docker compose logs -f app
  ```

- **The container restarts in a loop:** `docker compose logs app` — most often a missing or too-short
  `USAGE_API_TOKEN` / `DASHBOARD_PIN`, or `SRH_TOKEN` not matching between the `app` and `redis-rest`
  environments (both come from the same `.env` value, so this should only happen if `.env` was edited
  between `docker compose up` runs without a restart).

- **The Docker `HEALTHCHECK`** (`docker ps`'s `STATUS` column, or `docker inspect --format
  '{{json .State.Health}}' <container>`) runs `scripts/docker-healthcheck.mjs`, which is the same
  `/api/health` check above, from inside the container.

- **Clients get 401:** the token in the client's config doesn't match `USAGE_API_TOKEN` — reinstall
  from a fresh Setup-page download, or re-enter it (the installer keeps everything else).

- **A reverse proxy in front returns its own error page instead of usageratio's:** confirm it forwards
  `Host` and doesn't buffer the response (see [HTTPS](#https)); a proxy that rewrites `Host` to
  something the app doesn't expect can also affect the Setup page's generated client config.

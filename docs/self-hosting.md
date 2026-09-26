# Self-hosting with Docker

usageratio is built for Vercel + Upstash Redis, but it's a plain Next.js app underneath and runs
just as well on your own server. This page covers the Docker path: the [`Dockerfile`](../Dockerfile)
builds a standalone image, and [`docker-compose.yml`](../docker-compose.yml) runs it alongside a real
Redis and an Upstash-compatible REST proxy in front of it — the app only ever speaks Upstash's REST
API (`lib/redis.ts`), so this is what stands in for Upstash's own service.

For everything not specific to Docker — the client protocol, the API, the Redis data model, security
— see the [technical reference](REFERENCE.md).

- [Requirements](#requirements)
- [Quick start](#quick-start)
- [HTTPS](#https)
- [Installing clients](#installing-clients)
- [Housekeeping (the daily cron)](#housekeeping-the-daily-cron)
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

See the [technical reference's Clients section](REFERENCE.md#clients) for the installer's flags, exit
codes, and the package-free command-line install.

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

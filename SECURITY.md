# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security vulnerability. Instead, use GitHub's private
reporting:

1. Go to the [Security tab](https://github.com/snktibor/usageratio/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, how to reproduce it, and its impact. Include which deployment mode you
   tested against (Vercel, Docker, or local) if relevant.

This opens a private advisory visible only to you and the maintainer, so the issue can be discussed
and fixed before it's public. You can also reach the maintainer directly at
[@snktibor](https://github.com/snktibor).

## Supported versions

usageratio ships continuous releases from `main` (via [release-please](https://github.com/googleapis/release-please)),
not a set of long-term-supported branches. Security fixes are made against the **latest release**;
please make sure you're on it before reporting, and update to it once a fix ships.

## Response expectations

This is a single-maintainer, part-time project. There's no SLA, but reports are taken seriously:
expect an initial acknowledgement within a few days, and a fix or mitigation plan communicated in
the advisory thread once the issue is understood. Coordinated disclosure timing is negotiable —
just ask in the advisory.

## Threat model

This section summarizes the assets usageratio protects, the controls in place, and their known
limitations, so a report can focus on where those controls actually fall short rather than
re-discovering the design. For the full design, see [`docs/security.md`](docs/security.md).

### Assets

- **The ingest token(s)** — the shared `USAGE_API_TOKEN` and any revocable per-machine tokens
  (`lib/tokens.ts`) that authenticate the reporting clients to `POST /api/usage`.
- **The dashboard PIN/passphrase and sessions** — `DASHBOARD_PIN` and the session cookies it grants
  access to (`lib/auth.ts`).
- **`TOKEN_ENCRYPTION_KEY`** (and `TOKEN_ENCRYPTION_KEY_PREVIOUS` during rotation) — the AES-256-GCM
  key protecting the stored copy of the API token (`lib/secret-box.ts`, `lib/token-vault.ts`).
- **Redis credentials** — `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Upstash REST), which hold every
  other secret and all usage data.
- **Usage data** — token counts by provider, machine, and group; not sensitive on its own, but
  reveals usage patterns.
- **The encrypted API-token copy and its audit trail** — who revealed the stored token and when
  (`lib/api-token.ts`, `lib/token-vault.ts`).

### Trust boundaries and controls

- **Dashboard login**: a PIN or passphrase, 5–64 characters, checked with a constant-time
  comparison (`safeEqual`). A correct login starts a random 256-bit session id in an `HttpOnly`,
  `SameSite=Lax` cookie, stored server-side in Redis — logging out or changing `DASHBOARD_PIN`
  revokes every session immediately.
- **Login throttling**: a per-IP budget (5 attempts / 15 minutes) with an escalating lockout
  (doubling from 15 minutes up to 6 hours) for repeat offenders. A separate, smaller global budget
  (30 attempts / hour) applies **only** to browsers without a known-device cookie — a previously
  successful login exempts that browser, so a stranger spreading guesses across many IPs cannot
  lock the owner out of their own dashboard.
- **Sessions**: rolling — activity refreshes the "last seen" stamp (at most once an hour) so an
  active owner is never logged out by `SESSION_IDLE_DAYS` (default 7); `SESSION_MAX_DAYS` (default
  30) is a hard ceiling from creation regardless of activity.
- **Sudo re-confirmation**: revealing the stored API token in full, and other destructive admin
  actions, requires re-entering the PIN for a short-lived (5 minute) "sudo" grant on top of an
  already-live session (`grantSudo`/`hasSudo` in `lib/auth.ts`).
- **Same-origin checks**: every mutating dashboard endpoint checks the request's `Origin` against
  the request's own `Host`/`X-Forwarded-Host` (`lib/http.ts`), on top of the `SameSite=Lax` cookie.
- **CSP + related headers**: a nonce-based Content-Security-Policy (`lib/csp.ts`, `strict-dynamic`
  scripts, no inline scripts) plus COOP, CORP, and HSTS (enabled by default behind HTTPS), set in
  `proxy.ts`.
- **Bearer auth for clients**: the shared `USAGE_API_TOKEN` is compared with a constant-time
  comparison (it's typed by a human, so a timing attack is worth defending against); per-machine
  tokens (`lib/tokens.ts`) are looked up by the SHA-256 hash of the presented token (a hash-table
  lookup, not a byte-by-byte compare, so there's nothing for a timing attack to learn there
  either) and can be revoked individually from the settings panel.
- **Ingest limits**: a 64 KB request body cap, a required `application/json` content type, and
  three layered rate limits — per unauthenticated IP, per authenticated machine, and a global
  hourly ceiling (`app/api/usage/route.ts`) — plus registry caps (`MAX_MACHINES`, `MAX_GROUPS`,
  `MAX_PROVIDERS`, `MAX_TOKENS`) so a misbehaving or malicious client can't grow the store
  unbounded.
- **Encryption at rest for secrets**: the stored copy of the API token is sealed with AES-256-GCM,
  bound to a purpose string as additional authenticated data, with support for key rotation
  (`TOKEN_ENCRYPTION_KEY_PREVIOUS`) so a value sealed under a retiring key still opens and gets
  re-sealed automatically.
- **Audit trail**: every store, update, and reveal of the API token is recorded
  (`lib/api-token.ts`) with a timestamp, action, session tag, and IP — hashed with a per-deployment
  salt and truncated to a `/24` (or `/48` for IPv6) network prefix by default; the raw address is
  kept only if `AUDIT_RAW_IP=1` is set explicitly. Entries older than `AUDIT_RETENTION_DAYS`
  (default 365) are pruned by housekeeping.
- **Structured logs without secrets**: `lib/log.ts` logs are JSON by default in production and
  never include the PIN, tokens, or full IP addresses — only their hashes (`logIpHash`).
- **Housekeeping cron**: `GET /api/cron/housekeeping` (which prunes stale registry entries, revoked
  tokens, and old audit records) requires `Authorization: Bearer $CRON_SECRET` and refuses to run
  at all if `CRON_SECRET` is unset or under 16 characters.

### Known limitations

- **A short numeric PIN is a convenience login, not a strong secret.** A 5-digit numeric PIN is
  fine on a network you trust, but on a public URL, use a longer passphrase (12+ characters,
  letters and digits) — `DASHBOARD_PIN` accepts any string 5–64 characters long.
- **Per-IP rate limits assume the client IP is genuine.** Behind a reverse proxy or load balancer
  that doesn't set `X-Forwarded-For` correctly (or that lets a client set it themselves),
  `TRUST_PROXY` must be configured correctly (`1` behind a proxy you control, `0` when the app is
  exposed directly) or the limits can be trivially bypassed or spoofed.
- **A stolen session cookie is valid until it expires or is revoked.** There's no device binding or
  IP pinning on a session — a copied `HttpOnly` cookie works from anywhere until
  `SESSION_IDLE_DAYS`/`SESSION_MAX_DAYS` elapses or the owner logs out (which revokes it
  immediately).
- **Usage data itself is not encrypted at rest by the app.** Redis-level encryption (Upstash's own,
  or your own Redis's) is the boundary for the raw event data — only the API token copy is
  application-level encrypted.
- **`style-src-attr 'unsafe-inline'` is allowed in the CSP** for data-driven inline `style={{}}`
  attributes React needs (chart bar widths, dynamic colors); this is scoped narrowly — an inline
  style attribute cannot execute script, and `img-src`/`connect-src 'self'` close off using it to
  exfiltrate data.
- **No TOTP or WebAuthn second factor.** Authentication is a single shared secret (the PIN); there
  is no per-user account system, and none is planned given the single-owner deployment model.

# Security

This is the detailed version of [`SECURITY.md`](../SECURITY.md)'s threat model: exact numbers and
mechanics for login throttling, sessions, sudo, headers, rate limits, the token vault, audit
privacy, housekeeping, and logging. `SECURITY.md` stays the short policy (how to report a
vulnerability, supported versions) and links here for the detail.

- [Dashboard login](#dashboard-login)
- [Sessions](#sessions)
- [Sudo](#sudo)
- [Content-Security-Policy](#content-security-policy)
- [Other security headers](#other-security-headers)
- [Rate limits](#rate-limits)
- [Per-machine tokens](#per-machine-tokens)
- [The token vault and key rotation](#the-token-vault-and-key-rotation)
- [Audit trail privacy](#audit-trail-privacy)
- [Housekeeping](#housekeeping)
- [Logging](#logging)

## Dashboard login

`DASHBOARD_PIN` is a 5–64 character string (digits give a numeric keypad; anything else, a
passphrase), checked with a constant-time comparison (`safeEqual`, `lib/security.ts`: both sides
SHA-256 hashed first, then `timingSafeEqual`). All login logic is in `lib/auth.ts`.

**Per-IP throttling.** Every attempt (login or [sudo](#sudo)) bumps a fixed-window counter,
`usage:auth:ip:{sha256(ip).slice(0,32)}`, counted *before* the PIN is even checked so parallel
guesses can't outrun the limit:

- **5 attempts (`IP_MAX_ATTEMPTS`) per 15 minutes (`IP_WINDOW_SECONDS`).**
- The attempt that first fills the window bumps a 24-hour "strikes" counter
  (`usage:auth:ip:{...}:strikes`) and re-arms the IP's lockout to
  `15 minutes × 2^(strikes − 1)`, capped at **6 hours** (`MAX_LOCKOUT_SECONDS`) — so a first
  lockout is 15 minutes, a second (within 24h) is 30, then 60, 120, 240, and 360 from then on.
  Every attempt during the lockout reports the same remaining time.
- A successful login clears both counters for that IP.

**A separate, smaller global budget** (`usage:auth:global`, **30 attempts per hour**) applies only
to requests from a browser without a "known device" cookie. Logging in successfully sets a
365-day `usage:auth:device:{sha256(deviceId)}` cookie/key pair that exempts that browser from the
global budget from then on — so a stranger spreading guesses across many IPs can use up the budget
for unknown browsers, but never lock out the owner's own already-trusted browser.

**How much that protects.** An attacker with enough IP addresses gets at most 30 guesses an hour
through the global budget, about 21,600 a month. Against a 5-digit PIN (100,000 combinations) that
is roughly a one-in-five chance per month of sustained attack. On a public URL, use a passphrase of
12 or more characters instead; the guess space then dwarfs any rate limit.

Login errors: `malformed` (not a legal PIN string, not even counted as a guess), `misconfigured`
(`DASHBOARD_PIN` unset or invalid — the server logs `auth.pin_misconfigured` and refuses every
login), `invalid` with `attemptsLeft`, or `rate_limited` with `retryAfterSeconds`.

`DASHBOARD_PIN_AUTOSUBMIT=1` submits a numeric PIN automatically on its last digit — opt-in,
because it reveals the PIN's length to anyone watching the keystrokes.

## Sessions

A correct login starts a random 256-bit session id (`randomBytes(32).toString("base64url")`) in
an `HttpOnly`, `SameSite=Lax` cookie (`Secure` when the request is HTTPS), stored server-side at
`usage:session:{sha256(sessionId:pin)}` — binding the PIN into the key means **changing
`DASHBOARD_PIN` invalidates every existing session** at once, with no separate revocation step.

Sessions are **rolling**: the record is `{c: createdAt, s: lastSeen}`, and `isAuthenticated()`
refreshes `s` (re-writing the key with a recomputed TTL) at most once per hour of activity, so an
active owner is never logged out by idle time alone.

| Setting | Env var | Default | Meaning |
| --- | --- | --- | --- |
| Idle timeout | `SESSION_IDLE_DAYS` | 7 | no activity for this long logs the session out |
| Hard ceiling | `SESSION_MAX_DAYS` | 30 | expires from creation regardless of activity |

A legacy session record (bare `"1"`, from before rolling sessions existed) is treated as freshly
seen and silently upgraded to the new shape — nobody is logged out by a deploy. Logging out
(`endSession`) deletes the session key (and its [sudo](#sudo) key) and clears the cookie
immediately; there is no separate revocation list because deletion *is* revocation.

## Sudo

Revealing the stored API token in full, and every destructive "manage" action (deleting a
machine, group, or provider; merging groups; creating or revoking a per-machine token; pruning
machines; running housekeeping for real rather than as a dry run) requires a short-lived **sudo**
grant on top of an already-live session: `POST /api/auth/sudo` with the PIN re-entered, which sets
`usage:session:{...}:sudo = "1"` for **5 minutes** (`SUDO_TTL_SECONDS`). It shares the same per-IP
attempt limiter as login (guessing the PIN spends the same budget whichever door it's aimed at),
but never touches the device cookie or the global budget, since a live session is already
required to call it. A missing or expired grant fails the gated action with `403 sudo_required`; a
wrong PIN on the sudo prompt itself returns `401 sudo_invalid`.

Plain settings changes (`PUT /api/settings`), saving/updating the API token copy
(`PUT /api/api-token`), and a dry-run housekeeping check do **not** need sudo — only actions that
either show a secret in full or are hard to undo.

## Content-Security-Policy

`proxy.ts` generates a per-request nonce (16 random bytes, base64) and builds the policy in
`lib/csp.ts` (pure and unit-tested on its own):

```
default-src 'self';
script-src 'self' 'nonce-<nonce>' 'strict-dynamic' [+ 'unsafe-eval' in dev, for React's error overlay];
style-src 'self' 'unsafe-inline';
style-src-elem 'self' 'nonce-<nonce>' [+ 'unsafe-inline' in dev];
style-src-attr 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'self' [+ ws: wss: in dev];
manifest-src 'self';
form-action 'self';
frame-ancestors 'none';
base-uri 'none';
object-src 'none';
upgrade-insecure-requests;   [only over HTTPS]
report-uri /api/csp-report;
report-to csp-endpoint;
```

`style-src-attr 'unsafe-inline'` allows the inline `style={{}}` attributes React needs for
data-driven values (chart bar widths, dynamic colors); an attribute can't execute script, and
`img-src`/`connect-src 'self'` close off using it to exfiltrate data. `/api/csp-report`
(unauthenticated, capped at 8 KiB, rate-limited to 20 requests/minute per IP via an in-process
counter — a store-backed limiter isn't worth it for one best-effort endpoint) logs every violation
as `csp.violation { documentUri, violatedDirective, blockedUri, sample }` and answers `204`
(`413`, `415` or `429` for an oversized, mistyped or too frequent report).

**`SECURITY_CSP`** (`enforce` | `report` | `off`, default `enforce`) controls the header sent:

- `enforce`: `Content-Security-Policy` (blocking).
- `report`: `Content-Security-Policy-Report-Only` (logs violations, blocks nothing).
- `off`: no CSP header at all.
- **Development is always report-only**, regardless of `SECURITY_CSP`, so a nonce mismatch never
  blocks React's own debugging tools.

**Rollout on an existing deployment:** set `SECURITY_CSP=report`, redeploy, watch the logs for
`csp.violation` entries for a while (a legitimate resource the policy doesn't yet allow shows up
here, not as a broken page), then switch to `SECURITY_CSP=enforce` once the log is quiet. See
[upgrading.md](upgrading.md).

`app/api/csp-report/route.ts` accepts both shapes browsers send: the legacy
`application/csp-report` (`{"csp-report": {...}}`) and the newer Reporting API's
`application/reports+json` (an array of `{"type":"csp-violation","body":{...}}`).

## Other security headers

Set unconditionally by `next.config.ts` on every route: `X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`,
`Permissions-Policy` (camera/microphone/geolocation/payment/usb all denied),
`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`,
`X-Permitted-Cross-Domain-Policies: none`. Every `/api/*` route additionally gets a static,
maximally strict `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'` (no nonce
needed — there's no page to render).

**HSTS** is added only once a request is confirmed HTTPS (checked via `x-forwarded-proto`, so it
never fires on plain HTTP where the header itself would go unencrypted and unread):

| Env var | Default | Effect |
| --- | --- | --- |
| `SECURITY_HSTS` | on | `0` disables HSTS outright (a self-hosted deployment without TLS yet) |
| `SECURITY_HSTS_PRELOAD` | off | `1` adds `preload` to the header — only once the domain is actually submitted to the HSTS preload list |

The header value is `max-age=63072000; includeSubDomains[; preload]` (two years). These are
build-time settings (`next.config.ts`'s `headers()` runs once at boot), so changing them needs a
redeploy/restart, unlike `SECURITY_CSP` which `proxy.ts` re-reads per request.

## Rate limits

Every limit below is a fixed-window Redis counter (`lib/rate-limit.ts`'s `hit(key, limit,
windowSeconds)`: `SET key 0 EX windowSeconds NX` then `INCR`, so the first hit of a window seeds
its own expiry and the window resets when the key expires — no cleanup job).

| Limit | Value | Key |
| --- | --- | --- |
| Login attempts, per IP | 5 / 15 min, escalating lockout to 6h | `usage:auth:ip:*` |
| Login attempts, global (unknown devices only) | 30 / hour | `usage:auth:global` |
| Sudo attempts | shares the per-IP login limiter above | `usage:auth:ip:*` |
| `POST /api/usage`, per machine+token | 60 / hour (`INGEST_RATE_LIMIT_PER_MACHINE`) | `usage:rl:ingest:{sha256(tokenId:machineId)}` |
| `POST /api/usage`, deployment-wide | 600 / hour (`INGEST_RATE_LIMIT_GLOBAL`) | `usage:rl:ingest:global:{hour}` |
| `GET /api/usage` (cycle lookup), per token | 120 / hour (`CYCLE_RATE_LIMIT_PER_TOKEN`) | `usage:rl:cycle:{tokenId}` |
| Unauthenticated bearer attempts, per IP | 60 / minute (`UNAUTH_RATE_LIMIT_PER_IP`) | `usage:rl:unauth:{sha256(ip)}` |
| `/api/csp-report` | 20 / minute per IP | in-process `Map`, not Redis — see [above](#content-security-policy) |
| `POST /api/alerts/test` | 1 / 10 seconds, shared globally (not per-IP/session) | `usage:rl:alerts-test` |

All of the above answer `429` once exceeded; the API endpoints add `rate_limited` with
`Retry-After`/`retryAfterSeconds`, and the login form shows the wait time. Behind a reverse proxy or load balancer, `TRUST_PROXY` must be
set correctly (`1` when a proxy you control sets `X-Forwarded-For`, `0` when the app is exposed
directly) or every per-IP limit above can be spoofed or trivially bypassed.

## Per-machine tokens

An alternative to the shared `USAGE_API_TOKEN` that can be issued and revoked per machine, from
the settings panel (sudo required to create or revoke). A token is `ur_` followed by 256 random
bits, base64url-encoded; its public id (shown in the UI, never secret) is `tk_` followed by 8
base32 characters. Only `sha256(token)` is stored, as a field of the `usage:tokens` hash — the
plaintext is shown once, at creation, and never persisted. Authenticating a bearer token is
therefore a hash-table lookup (`HGET usage:tokens sha256(token)`), not a byte-by-byte compare, so
there is nothing for a timing attack to learn from it either — unlike the shared master token,
which is human-typed and checked with `safeEqual` for exactly that reason. A token can optionally
be bound to one `machineId`; a bound token reporting for any other machine gets
`403 machine_mismatch`. Up to `MAX_TOKENS` = 100 tokens per deployment; a revoked token is kept
(with `revokedAt` set) for 90 days before housekeeping forgets it entirely, so the audit trail and
"last used" history survive a revoke for a while.

## The token vault and key rotation

The settings panel's *Copy token* button needs a copy of `USAGE_API_TOKEN` the server can hand
back to a signed-in browser (the env var itself is never read back by the browser). That copy is
sealed with **AES-256-GCM** (`lib/secret-box.ts`): a fresh 96-bit IV per value, a 128-bit auth tag,
and a fixed context string (`"usageratio/usage-api-token/v1"`) bound in as additional
authenticated data, so a value sealed for this purpose can't be replayed as something else. The
key comes from `TOKEN_ENCRYPTION_KEY` (32 bytes, as 64 hex digits or base64) and lives only in the
server's environment — a Redis backup or a leaked REST token holds nothing but ciphertext.

**Rotation runbook:**

1. Set `TOKEN_ENCRYPTION_KEY_PREVIOUS` to the *current* (soon to be old) key.
2. Set `TOKEN_ENCRYPTION_KEY` to a newly generated key.
3. Redeploy.
4. Open the settings panel once (any read of the stored token tries the current key first, falls
   back to `TOKEN_ENCRYPTION_KEY_PREVIOUS`, and — if it had to fall back, or the document predates
   key fingerprints — re-seals the value under the current key in the background).
5. Remove `TOKEN_ENCRYPTION_KEY_PREVIOUS`.

Every sealed value carries `kid`, a short fingerprint of the key that sealed it (not the key
itself), so opening it can go straight to the right key instead of guessing; a value with no `kid`
(sealed before rotation existed) or one that matches neither key on file is simply tried against
both. `GET /api/api-token`'s `needsReseal` field reflects whether a stored value is not yet sealed
with the current key. Without `TOKEN_ENCRYPTION_KEY` at all, the token status is `no_key` and
saving or revealing fails with `500 encryption_key_missing`.

## Audit trail privacy

Every store, update, and reveal of the API token is recorded in `usage:api-token:audit`
(`lib/api-token.ts`) with a timestamp, action, session tag (a hash of the session id, never the id
itself), User-Agent, and the requesting address:

- **By default**, the address is hashed with a per-deployment salt and truncated to a network
  prefix: `sha256(salt + ip).slice(0, 12)` alongside a `/24` prefix for IPv4 or `/48` for IPv6 —
  enough to tell two visits from the same network apart without keeping the address itself.
- **`AUDIT_SALT`** sets that salt explicitly; unset, it derives from `sha256(TOKEN_ENCRYPTION_KEY)`
  so the salt still differs between deployments without a separate variable to manage.
- **`AUDIT_RAW_IP=1`** keeps the full address instead (also how a record written before hashing
  existed is read back).
- **`AUDIT_RETENTION_DAYS`** (default 365) — entries older than this are pruned by housekeeping;
  the trail itself is also capped at the newest 500 entries (`AUDIT_LIMIT`) regardless of age.

## Housekeeping

`GET /api/cron/housekeeping` (Vercel Cron calls it daily, `vercel.json`'s `0 3 * * *`) and the
manual `POST /api/housekeeping` (settings panel, sudo-gated unless `?dryRun=1`) both run
`runHousekeeping` (`lib/housekeeping.ts`), which prunes:

- `usage:machines` entries silent longer than `RETENTION_DAYS` (70 days);
- `usage:providers` entries with no events anywhere, no surviving machine, and not referenced by
  the settings document, once old enough to be dead rather than new;
- `usage:groups` entries with zero events across every provider, once old enough;
- `usage:official` entries older than the provider's current segment (its cycle rolled over, or a
  reset since), or that fail to parse;
- `usage:resets` events: a keep reset once it is older than the provider's previous cycle, a restart
  once it is older than `RETENTION_DAYS` (70 days, while its raw reports exist), and a reverted
  reset's detection switch once its cycle is over;
- `usage:tokens` entries revoked more than 90 days ago (`REVOKED_RETENTION_DAYS`);
- `usage:api-token:audit` entries older than `AUDIT_RETENTION_DAYS`.

Its one writing step archives the cycle that just ended into `usage:history:*` (see
[data-model.md § History](data-model.md#history-archived-cycles)). It never touches the raw event
ZSETs, which already self-prune on every write. The cron route needs `Authorization: Bearer
$CRON_SECRET`; the manual route needs a dashboard session, plus sudo for a real run. The cron route
refuses to run at all if `CRON_SECRET` is unset or under 16 characters, rather than accept an
unauthenticated request. A run's result is also stored at `usage:housekeeping:last`.
See [self-hosting.md](self-hosting.md#housekeeping-the-daily-cron) for running it without Vercel
Cron.

## Logging

`lib/log.ts` writes one JSON object per line in production (pretty lines in development), each
carrying the current request id when there is one. Every field whose name matches
`/token|pin|secret|authorization|cookie|password/i` is redacted (`"[redacted]"`) before a line is
written, recursively, so a PIN or token accidentally passed into a log call never reaches the
output. IP addresses are never logged in full either: `lib/auth.ts` and `lib/api-token.ts` only
ever pass a short hash (`logIpHash`, 12 hex characters) into a log line, distinct from the
audit-trail hash above. `LOG_LEVEL` (`debug`|`info`|`warn`|`error`, default `info`) and
`LOG_FORMAT` (`json`|`pretty`, default `json` in production) control verbosity and shape.

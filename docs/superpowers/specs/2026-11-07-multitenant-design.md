# Multi-tenant workspaces, GitHub sign-in, and registration: design

Date: 2026-11-07 · Status: accepted 2026-11-07 (every open question answered as recommended) · Covers roadmap phases F2–F5, plus workspace
membership and invites brought forward from F10

## Goal

Today `app.usageratio.snktibor.hu` is one person's dashboard: a PIN opens it, and there is one
shared dataset. After this work:

1. **Registration.** Anyone allowed by the instance's mode can sign in with GitHub. The first
   sign-in creates the person's own **workspace** (tenant): their own machines, groups, settings,
   tokens, history and alerts. Nothing of it is visible from any other workspace.
2. **Several logins per workspace.** A workspace has **members**, each signing in with their own
   GitHub account (the same person's second account, or a colleague). A new member joins through
   a single-use, expiring **invite link** that the owner creates.
3. **Self-hosting stays as it is.** The same codebase, self-hosted with no new configuration, is
   single-user and behaves exactly as today. No regression, and no migration a self-hoster has to
   run.

No billing, paid tiers or monetisation: the hosted instance is a free portfolio project.

## Fixed decisions (from the brief)

- `REGISTRATION=closed | invite | open`, default `closed`. `closed` is today's app: PIN, one
  tenant, the shared `USAGE_API_TOKEN`, the `usage:api-token` vault. The hosted instance stays at
  `invite` at most until F8 is done.
- GitHub OAuth with `state` + PKCE, strict callback validation, written by hand in `lib/` (no
  Auth.js or other auth package). No e-mail is sent or stored.
- Store the GitHub numeric user id and login; no e-mail; no avatar URL unless one is shown.
- Separate **user**, **identity** (provider + external id → user), **tenant**, and **membership**
  (user ↔ tenant, with a role). A user may belong to several tenants.
- Roles now: `owner` and `member`; a read-only `viewer` may come later.
- Tenant id: random, at least 128 bits, base64url; never the GitHub login or a counter. The
  display name is a separate field.
- The server alone decides the tenant: from the session for a browser (membership re-checked on
  every request), from the token's hash for a machine client. A tenant id sent by a client never
  selects data.
- Tenant data under `t:{tenantId}:usage:…`; auth, sessions, rate limits and the new user,
  identity, tenant and membership indexes are global. Every tenant key can be listed without
  SCAN.
- No route builds a key. Keys are reached only through a tenant-bound store object handed out by
  the authenticated context, and a test fails if a key literal appears outside the key module.
- Per-tenant machine tokens with a recognisable prefix (`ur_live_…`), hash-only storage,
  plaintext shown once. The shared token and the vault live on in `closed` mode only.
- Instance admin from the environment (`ADMIN_GITHUB_IDS`): sees counts and quota use, can
  disable a tenant and issue sign-up codes, never sees another tenant's data.
- Sudo (fresh re-authentication) for sensitive actions: a GitHub round trip in multi mode, the PIN
  in `closed` mode as today.
- Upstash over REST only; the demo stays on the in-memory store, read-only.
- UI text only through `messages/*.json`, in `en`, `hu` and `de`.

**One amendment**, accepted as decision 1 below: the `default` tenant keeps the existing
`usage:…` key names instead of moving to `t:default:usage:…`. That is what makes "no migration
for self-hosters" literally true, and it means the hosted instance's data never has to be copied.
Every other tenant uses `t:{tenantId}:usage:…` as decided. The rest of this document is written for the
amendment; the section [Alternative: physically moving the default tenant](#alternative-physically-moving-the-default-tenant)
describes what changes without it.

## Terms

| Term | Meaning |
|---|---|
| **closed mode** | `REGISTRATION=closed` (or unset). Today's single-user app. |
| **multi mode** | `REGISTRATION=invite` or `open`. GitHub sign-in, many tenants. |
| **tenant** / **workspace** | One isolated dataset. "Workspace" in the UI, "tenant" in code. |
| **user** | A person known to the instance, independent of how they sign in. |
| **identity** | One way to sign in that maps to a user. Now only `github:{numericId}`. |
| **membership** | A user's role (`owner` or `member`) in one tenant. |
| **active tenant** | The tenant a browser session is currently looking at. |
| **sign-up code** | An instance admin's single-use code that lets a new user create a workspace in `invite` mode. |
| **workspace invite** | An owner's single-use link that adds a member to an existing workspace. |
| **instance admin** | A GitHub account listed in `ADMIN_GITHUB_IDS`. |
| **sudo** | A short window (5 minutes) after a fresh re-authentication. |

## Assets to protect

| Asset | Why it matters |
|---|---|
| Usage data (events, history, all-time ledger, official percentages, resets) | Shows how much and when someone works, on which provider. |
| Machine and group names | Hostnames often carry a person's name ("tibor-macbook"); groups name clients or employers. |
| Alert webhook URLs | A Slack or Discord webhook URL is a bearer secret: whoever holds it can post to that channel. |
| Machine tokens | Report into, or read from, a workspace. |
| Sessions | A live session is the whole workspace for its role. |
| Workspace invites and sign-up codes | A leaked invite admits a stranger as a member. |
| GitHub id ↔ login ↔ workspace mapping | Who uses the instance at all. |
| OAuth client secret, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET` | Instance-wide secrets; env only, never in Redis or logs. |

## Threat model

Out of scope: a malicious self-hoster (they can only reach their own instance), the hosting
providers themselves (Vercel, Upstash, GitHub), and a compromised maintainer GitHub account (it is
the root of trust for the `default` tenant and for the admin list).

### Anonymous internet user

| Attack | Countermeasure |
|---|---|
| Guess or enumerate tenant ids | 128-bit random ids; no endpoint takes a tenant id that selects data; unknown and forbidden tenants answer the same way. |
| Brute-force machine tokens | 256-bit tokens; lookup is a hash-table get on `sha256(token)` (no timing signal); failed bearer checks throttled per IP (`usage:rl:unauth:*`, existing). |
| Hammer the OAuth endpoints | Per-IP limit on `/api/auth/github/start` and the callback (new `usage:rl:oauth:*`); state records expire in 10 minutes. Full abuse protection (BotID, sign-up throttling) is F6. |
| Mass sign-up | `invite` mode: no workspace without a sign-up code. `open` is not enabled before F8. |
| Read the app without signing in | Every page and API needs a session or a token; `noindex` stays. |

### Registered malicious user

| Attack | Countermeasure |
|---|---|
| IDOR: another tenant's machine, group, provider or token id in a URL | Ids are only ever looked up inside the caller's own tenant store; another tenant's id is simply not found (404). |
| Switch the session to someone else's tenant | `POST /api/session/tenant` checks the membership server-side; a non-member gets 404. |
| Forge a tenant id in a body, header or query | Never read as a selector. The one tenant id a client sends, `X-Usageratio-Tenant` (below), is only compared against the session's own active tenant and can only make a request fail. |
| Stored XSS through a workspace or machine name shown to members | React escaping only, no `dangerouslySetInnerHTML`; nonce CSP (existing); length and character validation (existing for machines/groups, new for workspace names). |
| Exhaust shared resources (Redis, functions) to hurt other tenants | Quotas and per-tenant rate limits (F6). Note: today's `usage:rl:ingest:global:*` (600/hour) becomes a cross-tenant denial of service in multi mode; F6 splits it into a per-tenant limit plus a much higher instance cap. |
| SSRF through the alert webhook | Existing allow-list (`lib/webhook.ts`: https, no private literals); DNS rebinding and egress filtering are F6. |
| Learn whether a GitHub account uses the instance | No endpoint answers that; invites never reveal the invitee's state. |

### Malicious workspace member

A member is trusted with the workspace's data: they see everything an owner sees. What they must
not do is take the workspace over, lock the owner out, or keep access after removal.

| Attack | Countermeasure |
|---|---|
| Remove the owner, invite accomplices, transfer ownership, delete the workspace | Owner-only actions, enforced in `lib/` (role check on the tenant context), covered by the role test matrix. |
| Read the alert webhook URL and post to the owner's Slack | Settings answer with a masked URL for every role (`https://hooks.slack.com/…/•••• 4f2a`); a member may replace it, not read it. The closed-mode vault reveal does not exist in multi mode. |
| Keep access after removal through a session | Membership is checked on every request: removal takes effect on the next request. |
| Keep access after removal through a token they created | Tokens record `createdBy`; removing a member offers (checked by default) to revoke every token that member created. |
| Destroy data (delete machines, groups, providers, prune) | Requires sudo, as today; goes on the tenant's audit trail (F8 extends it); accepted risk, since a member is trusted to manage machines. |

### Compromised machine token

| Attack | Countermeasure |
|---|---|
| Reach another tenant | The tenant comes from the token's own index entry; nothing in the request can change it. |
| Read data with an ingest token | Scopes (existing): `ingest` reports and reads the cycle (`GET /api/usage`), `read` only reads status, `official` is the menu bar app's. |
| Report as another machine | Machine-bound tokens (existing). |
| Go unnoticed | `lastUsedAt` per token (existing); revocation from the UI; the `ur_live_` prefix makes a leaked token greppable and lets secret scanners flag it. |

### Stolen session cookie

| Attack | Countermeasure |
|---|---|
| Steal it through script | `HttpOnly`; nonce CSP; no third-party script. |
| Steal it in transit or through a sibling host | `Secure`, `__Host-` prefix (so no `Domain`, `Path=/`), HSTS (existing). `demo.` and the landing never receive it. |
| Use it for a long time | Idle (7 days) and absolute (30 days) expiry, as today; the account page lists sessions and has "sign out everywhere". |
| Use it for the worst actions | Sudo needs a fresh GitHub round trip that returns the same GitHub id; a cookie alone does not pass it. |
| Cross-site requests riding on it | `SameSite=Lax`; every mutating route checks `Origin` (`requireSameOrigin`, existing). |

### OAuth-specific attacks

| Attack | Countermeasure |
|---|---|
| CSRF on the callback / login CSRF (victim ends up signed in to the attacker's account) | `state` is bound to the browser: `start` sets a short-lived `__Host-ur_oauth` cookie holding a random nonce, and the state record stores `sha256(nonce)`. The callback requires the cookie, the matching record, and deletes the record atomically (`GETDEL`), so a state works once, in the browser that started it, for 10 minutes. |
| Authorization code injection | PKCE S256 (`code_verifier` kept only in the server-side state record) plus the client secret; `redirect_uri` fixed. |
| Open redirect after sign-in | `returnTo` is checked against a fixed list of internal paths (the pattern of `AFTER_LOGIN` in `app/actions.ts`); anything else goes to `/`. Never an absolute URL, never `//`. |
| Redirect URI manipulation | Built from `NEXT_PUBLIC_SITE_URL` + `/api/auth/github/callback`, never from the `Host` header; multi mode refuses to start without `NEXT_PUBLIC_SITE_URL`. |
| Token leakage | GitHub's access token is used once for `GET https://api.github.com/user` and dropped: never stored, never logged. No OAuth scopes are requested. The callback answers with a 303 to a clean URL, and `Referrer-Policy: no-referrer` (existing) keeps the `code` out of any Referer. |
| Account takeover through a renamed or recycled GitHub login | Identities are keyed by the numeric GitHub id; the login is display data only. |
| Error-page reflection | The callback never echoes GitHub's `error_description`; it maps errors to fixed codes. |

### Invite link leak

| Attack | Countermeasure |
|---|---|
| A stranger uses a leaked workspace invite | Single use (`GETDEL`), 7-day expiry, revocable from the members page; optionally bound to a GitHub login (decision 5); grants `member` only, never `owner`; the new member shows up on the members page right away. |
| The invite leaks through logs or Referer | The code travels in the URL fragment (`/join#code`), which browsers never send to a server; the page posts it in a body. Only `sha256(code)` is stored. |
| A leaked sign-up code | Single use, 14-day expiry, revocable by the admin; it only creates an empty workspace. |

### Instance admin

The admin list is env-only (`ADMIN_GITHUB_IDS`, numeric ids). The admin view shows counts and quota
use, never tenant data (no machine or group names, no usage figures, no webhook URLs).

### A bug in our own code (the most likely cross-tenant leak)

- Keys only through `tenantStore(tenantId)`; `tenantStore` may only be called from the modules
  that resolve a tenant (session, token, housekeeping iterator, migration, tests), enforced by a
  test.
- `TenantId` is a branded type: a plain string from a request does not type-check where a tenant
  is expected.
- A literal-ban test (below), a key-registry completeness test, and an isolation matrix that runs
  every `app/api/**/route.ts` with two tenants.

### Deployment hygiene (to check, not code)

- Vercel Preview deployments must not carry the production Upstash credentials, or a preview build
  with a bug could write to production data. To be checked by the maintainer; this work does not
  change any Vercel setting.
- Multi-mode sign-in is not supported on preview URLs (the GitHub callback is fixed). Previews run
  closed or demo.

## Architecture

### Request → tenant context

```
browser ── cookie ──► requireTenantSession() ─┐
                                               ├─► TenantContext { tenantId, store, role, userId, via }
machine ── Bearer ──► requireTenantBearer()  ─┘                │
                                                               ▼
                                                     lib/* (takes `store`, never builds a key)
```

```ts
// lib/tenant.ts
export type TenantId = string & { readonly __tenant: unique symbol };
export const DEFAULT_TENANT = "default" as TenantId;

export interface TenantStore {
  readonly tenantId: TenantId;
  readonly keys: TenantKeys;   // from lib/redis-keys.ts tenantKeys(tenantId)
  readonly redis: Redis;       // getRedis()
}

export interface TenantContext {
  store: TenantStore;
  role: "owner" | "member";
  userId: string | null;       // null in closed mode and for tokens
  via: "pin" | "github" | "token";
  tokenId?: string;            // set for "token"
}
```

- **Closed mode.** `requireTenantSession` is today's PIN check, and yields the `default` tenant as
  `owner`. `requireTenantBearer` accepts the master token and the per-machine tokens, both for the
  `default` tenant.
- **Multi mode.** `requireTenantSession` reads the session (user + active tenant), then in one
  pipeline the membership (`HGET usage:tenant:{t}:members {u}`) and the tenant record (status).
  No membership, or a disabled tenant, fails the request. `requireTenantBearer` looks the token up
  in the global index, then reads its record in the tenant's own token hash.
- Pages (server components) get the same context through `currentTenant()`, from the request's
  cookies.
- Every `lib/` function that touches tenant data takes the `TenantStore` as its first argument
  (`loadIndexes(store)`, `storeReport(store, …)`, `runHousekeeping(store, …)`, …). The store is
  passed down, never looked up from a global.

**The stale-tab guard.** The active tenant belongs to the session, so switching it in one tab
switches every tab. A settings form still open in another tab would then save into the new
tenant. Every page renders its tenant id into the client; every mutating fetch sends it as
`X-Usageratio-Tenant`, and the server answers 409 `tenant_changed` when it differs from the
session's active tenant. It is a guard only: a missing or wrong value can make a request fail,
never choose a tenant. Closed mode skips it.

### Key layout

All key building moves into `lib/redis-keys.ts`, including the auth and rate-limit keys that are
built next to their code today (`lib/auth.ts`, `lib/api.ts`, `app/api/usage/route.ts`, …), and the
legacy shapes of `lib/migrate-legacy.ts` and the demo seed's patterns.

```ts
export const GLOBAL_KEYS = { … };              // auth, sessions, rate limits, users, tenants, indexes
export function tenantKeys(tenantId: TenantId): TenantKeys;   // the old KEYS, behind a prefix
```

`tenantKeys(DEFAULT_TENANT)` uses the prefix `usage:`, so the `default` tenant's keys are exactly
today's names. Any other tenant's prefix is `t:{tenantId}:usage:`. A tenant id is 22 base64url
characters, so it can never equal `default`.

#### Tenant keys (prefix `P` = `usage:` for `default`, `t:{tenantId}:usage:` otherwise)

Unchanged in meaning from today's layout comment; only the prefix is new.

```
P settings                         STRING  settings document (incl. the alert webhook URL)
P providers                        HASH    providerId → first-seen ms
P events:{providerId}:{groupId}    ZSET    reports (dynamic: in the registry)
P groups                           HASH    groupId → {"color", "ts"}
P machines                         HASH    providerId:machineId → {...}
P official                         HASH    official percentages
P resets                           HASH    usage resets
P history:{providerId}             ZSET    archived cycle summaries (dynamic: in the registry)
P alltime:{providerId}             HASH    all-time ledger (dynamic: in the registry)
P alert:{providerId}:{seg}:{thr}   STRING  "1" NX EX 70d alert guard (dynamic: in the registry)
P tokens                           HASH    sha256(token) → token record (now with "createdBy")
P api-token                        STRING  the vault (closed mode, default tenant only)
P api-token:audit                  LIST    the tenant's audit trail
P housekeeping:last                STRING  the tenant's last housekeeping report
P keys                             SET     NEW: registry of the tenant's dynamic keys
```

**Listing a tenant's keys without SCAN.** The fixed keys are a constant list
(`TENANT_FIXED_KEYS`). Every write that creates a dynamic key (`events:*`, `history:*`,
`alltime:*`, `alert:*`) also does `SADD P keys <name>` inside the same transaction. So the
tenant's keys are always `TENANT_FIXED_KEYS ∪ SMEMBERS(P keys)`. A name whose key has since
expired or emptied (an alert guard after 70 days, an event set that self-pruned to nothing) stays
in the registry harmlessly. Housekeeping drops only the names of alert guards whose segment started more
than a month (the longest cycle) plus their 70-day expiry ago: those are gone and can never be
written again. (Dropping "every name whose key no longer
exists" was the first idea, but it races a write that recreates the key between the check and the
removal, and a key written only once, like a cycle's history, would then fall out of the registry
for good.) The `default` tenant's registry is backfilled once by
`migrate:tenant`, which may SCAN because it is a one-off script.

A completeness test runs a full scenario (reports, archive, alerts, resets, tokens) on the memory
store for a non-default tenant, then asserts that every key under `t:{id}:` is in the fixed list or
the registry.

#### Global keys

Existing (unchanged): `usage:session:{sha256(sid:pin)}` (closed-mode sessions),
`usage:auth:ip:*`, `usage:auth:global`, `usage:auth:device:*`, `usage:rl:*`,
`usage:demo:*`.

New:

```
usage:user:{userId}                 STRING  {"v":1, "login", "createdAt", "lastLoginAt"}
                                            userId: "u_" + 22 base64url chars (128 bits)
usage:user:{userId}:identities      SET     "github:{numericId}" (for deletion, and later account linking)
usage:user:{userId}:tenants         HASH    tenantId → role   (mirror of the members hash, for the switcher)
usage:user:{userId}:sessions        ZSET    sha256(sessionId) → created ms (session list, sign out everywhere)
usage:identity:github:{numericId}   STRING  userId              (SET NX: one user per GitHub account)

usage:tenant:{tenantId}             STRING  {"v":1, "name", "createdAt", "createdBy", "status":
                                             "active" | "disabled" | "deleting", "statusAt"}
usage:tenant:{tenantId}:members     HASH    userId → {"role", "joinedAt", "invitedBy"}
usage:tenant:{tenantId}:invites     HASH    inviteId → {"hash", "createdAt", "expiresAt", "createdBy", "login"?}
usage:tenants                       ZSET    tenantId → created ms (every tenant but `default`: admin counts, housekeeping)
usage:tenants:housekept             ZSET    tenantId → last housekeeping ms (oldest first)

usage:invite:{sha256(code)}         STRING  {"tenantId", "inviteId", "login"?}  EX = expiry; GETDEL on use
usage:signup:{sha256(code)}         STRING  {"codeId"}  EX = expiry; GETDEL on use
usage:signups                       HASH    codeId → {"hash", "createdAt", "expiresAt", "createdBy", "usedBy"?}

usage:oauth:{sha256(state)}         STRING  {"nonceHash", "verifier", "purpose": "login" | "sudo" | "join" | "signup",
                                             "returnTo", "invite"?: hash, "signup"?: hash, "sid"?: hash}
                                            EX 600; GETDEL in the callback
usage:session2:{sha256(sessionId)}  STRING  {"v":2, "u": userId, "t": tenantId, "c", "s", "a": authAt ms,
                                             "ua": short browser/OS label}  EX = max lifetime
usage:tokenindex                    HASH    sha256(token) → tenantId (every tenant's machine tokens)
usage:rl:oauth:{ipHash}             STRING  rate-limit counter for start/callback
```

Multi-mode sessions get their own `session2` prefix so a closed-mode session can never be read as
one (or the other way round).

### Literal-ban test

`tests/redis-key-literals.test.ts` tokenises every `.ts`/`.tsx` file under `app/`, `lib/`,
`components/` and `scripts/` with the TypeScript scanner (already a dev dependency) and fails when
a string or template literal starts with `usage:` or `t:` outside `lib/redis-keys.ts`. Scanning
tokens, not text, keeps comments (which name keys in backticks all over the codebase) out of it. A
second assertion fails when `tenantStore(` is called outside the allowed modules, and a third when
`getRedis(` is called outside `lib/redis.ts`, `lib/tenant.ts` and the global-key modules (auth,
rate limit, users/tenants, migration).

### Housekeeping

`runHousekeeping(store, now, options)` is today's function for one tenant. The cron route
iterates: closed mode has exactly one tenant (`default`); multi mode reads `usage:tenants:housekept`
oldest first and processes tenants until a time budget (240 s of Vercel's 300 s limit) is spent,
stamping each tenant when it is done. A tenant not reached today is first in line tomorrow. One
failing tenant is logged and skipped, never aborting the run. Disabled tenants are still
housekept; `deleting` tenants have their deletion resumed instead (below).

The manual `POST /api/housekeeping` runs for the caller's own tenant only.

### Alerts and export

Both already read only through the store: the alert guards and webhook URL are tenant keys, and
`/api/export` exports the caller's tenant. The webhook URL is masked in every API answer and page
in multi mode; saving the settings form keeps the stored URL unless a new one is typed.

### Demo

The demo runs on the memory store as the `default` tenant: same keys as today, so the seed needs
no change beyond writing the registry. Multi mode is never active in the demo (`DEMO_MODE=1` forces
`closed`), and every mutating endpoint still answers `demo_read_only`.

## Session model

### Closed mode

Unchanged: `usageratio_session` and `usageratio_device` cookies, `usage:session:{sha256(sid:pin)}`,
PIN sudo, the guess budgets. Everything in `docs/security.md` stays true.

### Multi mode

| Property | Value |
|---|---|
| Cookie | `__Host-ur_session` over HTTPS (`ur_session` over plain http in local development) |
| Attributes | `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, **no `Domain`** (host-only: never sent to `demo.` or the landing; the `__Host-` prefix makes the browser enforce it) |
| Value | 256-bit random, base64url; only its sha256 is a Redis key |
| Idle expiry | `SESSION_IDLE_DAYS` (default 7), rolling, refreshed at most hourly (as today) |
| Absolute expiry | `SESSION_MAX_DAYS` (default 30) from creation |
| On sign-in | Always a new session id (no fixation); the OAuth cookie is cleared |
| Record | user, active tenant, created, last seen, last GitHub authentication (`a`, for sudo), a short browser/OS label for the session list (no IP address) |
| Per request | Session → membership + tenant status, in one pipeline; a removed member or a disabled tenant fails on the next request |
| Sign out | Deletes the session key and its entry in `usage:user:{u}:sessions` |
| Sign out everywhere | Deletes every session in `usage:user:{u}:sessions` |
| Switch tenant | `POST /api/session/tenant {tenantId}`: membership checked, then the session's `t` is rewritten; 404 for a non-member |
| No membership left | The session survives but has no active tenant: the app shows "no workspace" (create one if the mode allows, or wait for an invite) |

### Sudo

- Closed mode: the PIN, as today.
- Multi mode: `GET /api/auth/github/start?purpose=sudo&returnTo=…` runs the OAuth flow with
  `prompt=select_account`; the callback requires that the GitHub id it gets back is an identity of
  the session's own user, then sets the session's `a` to now. `hasSudo()` is true while
  `now − a < 5 minutes`. A GitHub id that belongs to someone else fails, and does not sign anyone
  in.
- Honest limit: if the browser already holds a GitHub session and the app is already authorised,
  GitHub may complete the round trip without asking for a password. Sudo in multi mode therefore
  proves "this browser holds a live GitHub session for the same account", which a stolen
  usageratio cookie alone does not.
- Needs sudo: delete the workspace, delete the account, reveal a secret (closed-mode vault), export,
  remove a member, transfer ownership, and everything that needs it today (delete machine, group,
  provider, prune, manual housekeeping, create or revoke tokens).

## GitHub sign-in

- An **OAuth App** (not a GitHub App), requesting **no scopes**: the token can read only the public
  profile, and it is thrown away after one call. The maintainer creates two apps: one for
  production (callback `https://app.usageratio.snktibor.hu/api/auth/github/callback`) and one for
  local development (`http://localhost:3000/api/auth/github/callback`).
- PKCE S256: GitHub accepts `code_challenge` for OAuth Apps (added in 2025). To be re-checked
  against GitHub's current documentation when F4 is written, together with `prompt=select_account`;
  the flow stays safe without PKCE thanks to the client secret, so it is defence in depth.
- New environment: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (secret), `ADMIN_GITHUB_IDS`
  (comma-separated numeric ids). `NEXT_PUBLIC_SITE_URL` becomes required in multi mode. Multi mode
  with any of these missing fails closed: sign-in answers `server_misconfigured`, nothing falls
  back to the PIN.

### Flow

1. `GET /api/auth/github/start?purpose=login|sudo|join|signup&returnTo=…` (a link, not a form:
   the CSP's `form-action 'self'` would block a form whose response redirects to github.com).
   Rate-limited per IP. Creates `state` (256 bits), `nonce` (256 bits), `code_verifier`; stores
   `usage:oauth:{sha256(state)}` (10 minutes); sets `__Host-ur_oauth=nonce` (10 minutes,
   `HttpOnly`, `Secure`, `SameSite=Lax`); 303 to `https://github.com/login/oauth/authorize` with
   `client_id`, the fixed `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`.
   For `join` and `signup`, the code arrives in a POST body first (from the fragment), is checked
   to exist (not consumed), and only its hash goes into the state record.
2. `GET /api/auth/github/callback?code&state`: the `__Host-ur_oauth` cookie must be present;
   `GETDEL usage:oauth:{sha256(state)}` must return a record whose `nonceHash` matches; then the
   code is exchanged (`POST https://github.com/login/oauth/access_token` with the secret, the
   verifier and the same `redirect_uri`, 5-second timeout), `GET https://api.github.com/user`
   gives `id` (number) and `login`, and the token is dropped. Any failure → 303 to the sign-in page
   with a fixed error code; nothing about GitHub's answer is echoed.
3. By purpose:
   - `login`: an existing identity → its user; otherwise a new user only if the mode allows
     (`open`), creating their workspace too.
   - `signup` (`invite` mode): `GETDEL usage:signup:{hash}` must succeed; creates the user (if new)
     and a workspace they own.
   - `join`: `GETDEL usage:invite:{hash}` must succeed (and match the bound login, if any); creates
     the user if new, adds the membership. An invited newcomer gets **no** workspace of their own:
     they can create one later if the mode allows.
   - `sudo`: see above; never creates a session.
4. A new session (except for `sudo`), the OAuth cookie cleared, and a 303 to the checked
   `returnTo`.

User creation is idempotent: `SET usage:identity:github:{id} {userId} NX` decides the race between
two parallel callbacks; the loser reads the winner's user id.

## Workspaces, members and invites

### Roles

| Action | owner | member |
|---|:-:|:-:|
| See the dashboard, history, settings, machines, tokens list | ✓ | ✓ |
| Manage machines, groups, providers, resets, official percentages | ✓ | ✓ |
| Change settings, including replacing the webhook URL | ✓ | ✓ |
| Read the webhook URL in full | – | – (masked for everyone) |
| Create and revoke machine tokens | ✓ | ✓ (decision 4) |
| Export the workspace | ✓ | – (decision 2) |
| Invite, list and revoke invites, remove members | ✓ | – |
| Transfer ownership | ✓ | – |
| Rename the workspace | ✓ | – |
| Delete the workspace | ✓ | – |
| Leave the workspace | – (transfer first) | ✓ |

A later `viewer` role only removes the "manage" and "change" rows; the role is a string in the
membership, so adding it needs no migration.

One owner per workspace. Transfer sets the target member to `owner` and the old owner to
`member` in one transaction, with sudo; only an existing member can receive it.

### Invites

- Created by the owner: `code` = 256 bits, base64url; stored as `usage:invite:{sha256(code)}`
  (EX 7 days) plus a listing entry in `usage:tenant:{t}:invites`. The plaintext link
  (`https://app…/{locale}/join#code`) is shown once.
- Optional binding to a GitHub login (typed by the owner): accepted only by an account with that
  login at the moment of acceptance.
- Accepting: `/join` reads the fragment, posts it to start the `join` flow; a signed-in user who
  is already a member just switches to the workspace; the invite is consumed by `GETDEL` in the
  callback, so it works exactly once even under a race.
- Revoking: deletes both keys. Expired listing entries are pruned by housekeeping.
- At most 10 pending invites per workspace (quota).
- The invitee may be unknown to the instance: the flow creates their user. In `invite` mode a
  workspace invite is enough to create a user; it is never enough to create a workspace.

### Sign-up codes (`invite` mode)

The instance admin creates them on the admin page: same shape as invites (256 bits, hashed,
single use, 14-day expiry, revocable, link `/signup#code`). A code creates one workspace for the
user who redeems it.

### Leaving, removal, deletion

- **A member leaves, or is removed:** both membership entries go; their sessions lose that tenant
  on the next request; their tokens are revoked if the owner chose so (removal) or kept (leaving:
  the workspace keeps the machines). Nothing else of the workspace changes. Their user record is
  untouched.
- **Workspace deletion (owner, sudo):** the tenant record is set to `deleting` first (every
  request and token for it then fails), then the fixed keys and the registry's keys are deleted in
  batches, then the tenant's entries in `usage:tokenindex`, its invites, every member's
  `usage:user:{u}:tenants` entry, the members hash, the `usage:tenants*` entries, and last the
  tenant record. Each step is idempotent, so housekeeping finishes a deletion that was interrupted.
  The `default` tenant cannot be deleted from the UI.
- **Account deletion (sudo):** blocked while the user owns a workspace that has other members
  (transfer first). Otherwise it deletes the workspaces the user solely owns, leaves every other
  workspace, deletes every session, the identities, the identity index entries and the user
  record. Invites the user created stay with their workspace.

A test covers each: afterwards, the memory store holds no key under `t:{id}:`, and no global key
or field names the deleted tenant or user.

## Instance admin

A minimal `/admin` page, visible only to `ADMIN_GITHUB_IDS`:

- Counts: users, tenants (active, disabled), sessions are not counted.
- Per tenant: id, created, status, owner's GitHub login (decision 6), member count, machine
  count, provider count, token count, last report time, registry size. No names of machines or
  groups, no usage figures, no settings.
- Disable or re-enable a tenant (data kept; its sessions see "workspace disabled", its tokens get
  403 `tenant_disabled`).
- Create, list and revoke sign-up codes.

The admin is an ordinary user otherwise, with their own workspace. Admin actions go on an
instance-level audit list (F8 shapes it; F4 writes the entries).

## Machines and tokens per tenant

- Token format: new tokens are `ur_live_` + 32 random bytes, base64url. Existing `ur_…` tokens
  keep working (the lookup is by hash; the prefix is only for people and scanners).
- `usage:tokenindex` (global) maps `sha256(token)` to the tenant; the tenant's own
  `P tokens` hash keeps the record as today, plus `createdBy` (user id, or null in closed mode).
  Revocation sets `revokedAt` in the record; housekeeping later removes both entries.
- Closed mode keeps the master `USAGE_API_TOKEN` and the vault. In multi mode both are ignored
  (a set `USAGE_API_TOKEN` logs a warning once), and `/api/api-token*` answers 404.
- The setup package in multi mode: `POST /api/setup` (not GET, since it now creates something)
  issues a machine-bound ingest token for the chosen machine and writes it into the package's
  config, with the `app.` URL from `NEXT_PUBLIC_SITE_URL`. The README warns that the ZIP now
  contains a secret. Closed mode keeps the current GET download without a token.
- The menu bar app needs no code change: it sends its URL and token, and the token decides the
  tenant. Only the token field's placeholder (`ur_…`) may be updated. To be confirmed in F5 by
  running the app against a non-default tenant.
- Token management in the UI: create, rotate (create new + revoke old in one step), revoke; every
  action on the tenant's audit trail.

## Closed mode: what stays and what goes

| | closed | multi |
|---|---|---|
| Sign-in | PIN (`DASHBOARD_PIN`) | GitHub |
| Known-device cookie and global guess budget | yes | no (GitHub does the authentication) |
| Sudo | PIN | GitHub round trip |
| Tenants | `default` only | many |
| Master `USAGE_API_TOKEN` | yes, required | ignored |
| Token vault, reveal, its audit popup | yes | no (404) |
| Per-machine tokens | yes | yes, per tenant |
| Setup package | GET, no token inside | POST, with a fresh token |
| Account, members, admin pages | no | yes |
| Data keys | `usage:…` | `usage:…` for `default`, `t:{id}:usage:…` for the rest |

A self-hoster who upgrades and changes nothing gets closed mode with the same keys, cookies and
behaviour: no migration, no new variable. The e2e suite runs closed mode unchanged; multi mode
gets its own suite with a fake GitHub (below).

## Migration: `npm run migrate:tenant`

Modelled on `migrate:legacy`: dry-run by default, `--apply` to write, idempotent, prints what it
would do or did.

1. Create the `default` tenant's record (`name: "Default"`), if missing. The `default` tenant is
   never in `usage:tenants`: it always exists, so the code adds it to every tenant list itself.
2. With `--owner-github-id=<numeric id>` (added in F4, together with users): create the user, the
   identity and the owner membership, if missing (an existing identity is reused). The login is
   filled in at that account's first sign-in.
3. Index every token in `usage:tokens` in `usage:tokenindex` (`HSETNX`, pointing at `default`).
4. Backfill `usage:keys` with a one-off SCAN of `usage:events:*`, `usage:history:*`,
   `usage:alltime:*`, `usage:alert:*`.

No data is copied, renamed or deleted, so there is no separate clean-up step. Running it is needed
only before switching an instance from closed to multi mode; a closed-mode instance never needs it
(the token index and the registry are not read in closed mode, and F3 builds both lazily from then
on anyway).

### Alternative: physically moving the default tenant

Not chosen (decision 1); kept for the record. Had `default` got the prefix `t:default:usage:` like
any other tenant, `migrate:tenant --apply` would have copied every key (fixed list + SCAN) with `DUMP`/`RESTORE`
semantics (Upstash REST: read and rewrite per type), verified counts per key, and a separate
`--delete-legacy` would have removed the old keys. Closed mode would then have needed the same migration on every
self-hosted instance, or a permanent fallback that reads the old names when the new ones are
missing; both contradict "no migration for self-hosters", which is why the amendment was
chosen.

## Moving the maintainer's machines

Today three machines report to `app.`: the Mac (menu bar app, its own `official`-scope token; its
ccusage client possibly on the shared token), a Windows machine, and a machine that reports by hand
in the `patyezs` group, the last two on the shared `USAGE_API_TOKEN`. Reports are running totals
of the cycle, so a missed report loses no usage, only resolution; still, the plan keeps every
report flowing.

1. **Now, in closed mode, no code needed.** In Settings → Tokens, create a machine-bound ingest
   token for the Windows machine, the manual machine, and the Mac's ccusage client if it uses the
   shared token. Put each into that machine's client config. The shared token stays valid, so
   nothing stops in between. Check each new token's "last used" and the dashboard after the next
   hourly report. (The Windows and manual moves to `app.` are F1 items the maintainer is doing
   anyway; this can happen in the same visit.)
2. **Deploy F3 (closed).** Upstash backup, then `migrate:tenant` dry-run, then `--apply`
   (with the maintainer's approval). Reports keep arriving: the keys did not change.
3. **Deploy F4 and F5 (still closed).** No visible change. F5 adds a log event
   `api.master_token_used` whenever the shared token authenticates.
4. **Confirm the shared token is idle:** no `api.master_token_used` in the Vercel logs for 72 hours.
5. **The maintainer creates the GitHub OAuth App** and sets `GITHUB_CLIENT_ID`,
   `GITHUB_CLIENT_SECRET` and `ADMIN_GITHUB_IDS` in Vercel (Production only). Still closed.
6. **Switch:** `REGISTRATION=invite`, redeploy. Sign in with GitHub; the account from step 2's
   `--owner-github-id` lands in the `default` workspace as owner. Check that all three machines'
   next reports arrive.
7. **Rollback** at any point: `REGISTRATION=closed` and redeploy. The PIN works again, the data is
   untouched (the keys never changed), and tenants created in the meantime simply sit unused.
   `USAGE_API_TOKEN` and `DASHBOARD_PIN` stay set until F9 for this reason.

## Quotas (defaults for F6)

For the hosted instance in multi mode; closed mode keeps today's instance-wide caps
(`MAX_MACHINES` 200, `MAX_GROUPS` 50, `MAX_PROVIDERS` 20, `MAX_TOKENS` 100).

| Quota | Default | Today's closed-mode value |
|---|---|---|
| Machines per workspace | 25 | 200 per instance |
| Providers per workspace | 20 (all supported) | 20 |
| Groups per workspace | 20 | 50 |
| Tokens per workspace | 50 | 100 |
| Members per workspace | 10 | – |
| Pending invites per workspace | 10 | – |
| Workspaces owned per user | 3 | – |
| Raw event retention | 70 days (`RETENTION_DAYS`) | same |
| Archived cycles | 24 (`HISTORY_RETENTION`) + the all-time ledger | same |
| Reports per machine per hour | 12 (clients report hourly) | 60 |
| Ingest per workspace per hour | 600 | 600 per instance |
| Ingest per instance per hour (cost cap) | 20 000 | 600 |
| Request body | as today (`MAX_BODY_BYTES`) | same |

Over a quota: a stable error code (`too_many_*`, `rate_limited`) and a translated message, never a
silent drop. The numbers live in `lib/config.ts`; F6 decides whether any becomes an env variable.

## GDPR touch points (for F7)

| Event | Deleted | Kept |
|---|---|---|
| Member leaves or is removed | Their membership (both directions); optionally the tokens they created (removal) | Their user record and other memberships; all workspace data |
| Workspace deleted | Every tenant key (fixed + registry), its token index entries, invites, memberships, tenant record | Nothing of it (backups age out per F7's retention) |
| Account deleted | Sessions, identities, user record, memberships, workspaces they solely own | Workspaces with other members (must be transferred first) |
| Inactive 12 months (F7) | As account deletion | – |

Data the instance holds about a user: GitHub numeric id and login, created and last sign-in time,
memberships, sessions (with a browser/OS label, no IP). No e-mail, no avatar, no GitHub token.

## Testing

- **Unit:** key builders (prefix rules, `default` alias, registry), OAuth state (single use,
  expiry, nonce binding, `returnTo` allow-list), PKCE, session (expiry, rolling refresh,
  membership loss, disabled tenant, `session2` vs closed sessions), invites and sign-up codes
  (expiry, single use under concurrency, login binding, revoke), role checks, deletion
  completeness.
- **Literal ban, registry completeness, `tenantStore` call sites**: as described above.
- **Isolation matrix** (`tests/isolation/*.test.ts`): a helper seeds tenants A and B on the memory
  store with distinctive markers (machine `b-secret-host`, group `b-secret-group`, webhook
  `…/b-secret`); every `app/api/**/route.ts` is discovered by glob (a route missing from the matrix
  fails the test), and every method is called with A's session, A's token of each scope, and
  without auth. Assertions: no response mentions a B marker; B's memory-store snapshot is
  byte-identical afterwards; ids of B's machines, groups and tokens in A's requests answer 404.
- **Role matrix:** every owner-only action as a member → 403 `forbidden_role`; as a non-member →
  404.
- **Closed mode:** the existing unit and e2e suites unchanged and green.
- **Multi mode e2e:** a fake GitHub OAuth server (a small local route set enabled only in test
  builds by an env variable that the production build refuses), two accounts, two workspaces, an
  invite accepted by a second account, a member removed mid-session.
- **Not verifiable locally:** the real GitHub OAuth flow in production. It is tested by hand by
  the maintainer after step 6 above, and reported as such.

## PR breakdown

| # | Branch | Content | Done when |
|---|---|---|---|
| 1 | `docs/multitenant-design` | This spec | Accepted; decisions copied into `ROADMAP.local.md` |
| 2 | `refactor/tenant-store` | `TenantId`, `tenantStore`, `tenantKeys` with the `default` alias, every `lib/` function takes the store, all key building in `lib/redis-keys.ts`, literal-ban and call-site tests, key registry writes + completeness test, memory store and demo seed tenant-aware | `npm run check` and the e2e suite green with no behaviour change; the literal-ban test passes |
| 3 | `refactor/tenant-iteration` | Tenant index, per-tenant housekeeping with a time budget, tenant token index, `migrate:tenant`, isolation-matrix harness (two tenants built directly in tests) | Isolation matrix green for every route; migration dry-run/apply/idempotency tested; production migration run with backup and approval |
| 4 | `feat/github-sign-in` | `REGISTRATION`, users/identities/tenants/memberships, OAuth flow, multi-mode sessions, sign-up codes, GitHub sudo, first-login workspace, fake-GitHub e2e harness | Two accounts in `invite` mode live fully apart (e2e); closed-mode e2e unchanged |
| 5 | `feat/account-admin` | Account page (profile, sessions, sign out everywhere, account deletion), admin page (counts, disable, sign-up codes), docs (`self-hosting.md`, `configuration.md`, `security.md`, `data-model.md`, `.env.example`) | Deletion tests prove no key is left; admin view shows no tenant data (test) |
| 6 | `feat/workspace-members` | Members list, invites (create, revoke, accept), remove, leave, transfer, tenant switcher, stale-tab guard | Two GitHub accounts in one workspace see the same data; role matrix green |
| 7 | `feat/tenant-tokens` | `ur_live_` prefix, `createdBy`, master token and vault closed-only, `api.master_token_used`, setup package with a token (POST), token rotate/revoke UI with audit, menu bar app check | No endpoint gives one tenant's token or session access to another's data (isolation matrix with tokens of every scope) |

After each phase: `/security-review`, then `/code-review high`, findings fixed and recorded in
`ROADMAP.local.md`.

## Decisions on the open questions (accepted 2026-11-07)

1. **The `default` tenant keeps today's key names** (`usage:…`); every other tenant uses
   `t:{tenantId}:usage:…`.
2. **Export is owner-only** for now.
3. **The webhook URL is masked for every role** in multi mode: it can be replaced, never read back.
4. **Members may create and revoke machine tokens**; tokens record `createdBy`, and removing a
   member offers (checked by default) to revoke the tokens they created.
5. **An invite may optionally be bound to a GitHub login.**
6. **The admin view shows each tenant owner's GitHub login.**
7. **Account deletion is blocked** while the user owns a workspace that has other members;
   ownership has to be transferred first.
8. **Expiries:** workspace invite 7 days, sign-up code 14 days.
9. **The quota table above** is F6's starting point.
10. **The multi-mode setup package embeds a fresh machine-bound token** and is downloaded with a
    POST; its README warns that it contains a secret.

# API

All source: `app/api/**/route.ts`, shared helpers in `lib/api.ts`.

- [Conventions](#conventions)
- [Error codes](#error-codes)
- [Rate limits and size caps](#rate-limits-and-size-caps)
- [`GET`/`POST /api/usage`](#getpost-apiusage) — the ingest endpoint
- [The report schema](#the-report-schema)
- [`GET /api/status`](#get-apistatus) — the macOS menu bar app's read
- [`GET /api/health`](#get-apihealth)
- [`GET`/`PUT /api/settings`](#getput-apisettings)
- [`PUT /api/official-usage`](#put-apiofficial-usage)
- [`GET /api/setup`](#get-apisetup)
- [`GET`/`PUT /api/api-token`, `POST /api/api-token/reveal`, `GET /api/api-token/audit`](#the-stored-api-token)
- [`GET`/`POST /api/tokens`, `DELETE /api/tokens/[id]`](#per-machine-tokens)
- [`GET /api/machines`, `PATCH`/`DELETE /api/machines/[provider]/[machine]`, `POST /api/machines/prune`](#machines)
- [`PATCH`/`DELETE /api/groups/[group]`](#groups)
- [`DELETE /api/providers/[provider]`](#providers)
- [`POST /api/alerts/test`](#alerts-test)
- [`GET`/`POST /api/auth/sudo`](#sudo)
- [`GET /api/cron/housekeeping`, `POST /api/housekeeping`](#housekeeping)
- [`GET /api/export`](#export)
- [`POST /api/csp-report`](#csp-report)

## Conventions

- Every response has `Cache-Control: no-store` and an `x-request-id` header.
- Errors are a JSON envelope: `{ "error": <code>, "requestId": "<id>", ...extra }`. The codes are
  stable (clients and the UI match on them); see [Error codes](#error-codes).
- A `503` (storage not configured, or unreachable) gets `Retry-After: 60`; a `429` gets
  `Retry-After: <retryAfterSeconds>`.
- A `401` for a missing/bad Bearer token gets `WWW-Authenticate: Bearer realm="usage"`.
- Five auth mechanisms appear below: **none**, **bearer** (`Authorization: Bearer <token>` — the
  shared `USAGE_API_TOKEN` or a per-machine token), **session** (the dashboard's PIN-session cookie),
  **session + sudo** (a session, plus a live 5-minute sudo grant from `POST /api/auth/sudo`), and
  **cron secret** (`Authorization: Bearer $CRON_SECRET`).
- Every mutating session-gated endpoint also checks the request's `Origin` against its own
  `Host`/`X-Forwarded-Host` (`403 forbidden_origin` otherwise) — a second line of defense alongside
  the `SameSite=Lax` session cookie.
- In demo mode (`DEMO_MODE=1`), every mutating endpoint answers `403 demo_read_only` without doing
  anything.

## Error codes

The full `ApiErrorCode` union (`lib/api.ts`):

| Code | Typical status | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | No/invalid session, or no/invalid Bearer token. |
| `forbidden_origin` | 403 | The request's `Origin` doesn't match its own host. |
| `unsupported_media_type` | 415 | Body isn't `application/json` where required. |
| `payload_too_large` | 413 | Body exceeds the endpoint's byte cap. |
| `unreadable_body` | 400 | The body stream failed while reading. |
| `invalid_json` | 400 | Body isn't valid JSON. |
| `invalid_payload` | 400 | Body is JSON but fails validation (`details` lists every problem). |
| `invalid_token` | 400 | A submitted API token fails its own format check (`PUT /api/api-token`). |
| `rate_limited` | 429 | A rate limit was hit; `retryAfterSeconds` says how long to wait. |
| `server_misconfigured` | 500 | A required secret (`USAGE_API_TOKEN`, `CRON_SECRET`, `DASHBOARD_PIN`) is missing or too short. |
| `encryption_key_missing` | 500 | `TOKEN_ENCRYPTION_KEY` is missing or malformed. |
| `storage_not_configured` | 503 | Redis env vars were never set. |
| `storage_unavailable` | 503 | Redis is unreachable or erroring. |
| `internal_error` | 500 | An unhandled exception (logged, and sent to `ERROR_WEBHOOK_URL` if set). |
| `sudo_required` | 403 | The action needs a live sudo grant. |
| `sudo_invalid` | 401 | Wrong PIN presented to `POST /api/auth/sudo` (`attemptsLeft` when known). |
| `too_many_groups` / `too_many_providers` / `too_many_machines` / `too_many_tokens` | 422 | A registry cap would be exceeded; `limit` gives the cap. |
| `machine_mismatch` | 403 | A machine-bound per-machine token reported for a different `machineId`. |
| `read_only_token` | 403 | A "read" per-machine token tried to report (`POST /api/usage`); it may only read. |
| `no_token` | 404 | Nothing stored to reveal (`POST /api/api-token/reveal`). |
| `token_unreadable` | 409 | The stored API token can't be decrypted with any known key. |
| `groups_have_reports` | 409 | A settings save tried to remove a group that still has stored reports. |
| `not_found` | 404 | No such resource (machine, token, group, provider). |
| `demo_read_only` | 403 | Demo mode refuses every write. |
| `machine_exists` / `group_exists` | 409 | Rename target already in use. |
| `merge_unsupported` | 409 | A machine merge outside snapshot token mode. |
| `group_not_found` | 404 | A machine move to a group that does not exist (yet). |
| `group_has_events` / `provider_has_events` | 409 | Delete without `?force=1` on something with stored data. |
| `webhook_failed` | 502 | The test-alert webhook call itself failed; `status`/`detail` explain. |

## Rate limits and size caps

Fixed-window counters in Redis (`lib/rate-limit.ts`), except the CSP-report endpoint, which uses a
tiny in-process counter so it still works when the store is down.

| Endpoint | Limit | Window | Keyed by |
| --- | --- | --- | --- |
| `POST /api/usage` | 60 | 1 hour | per token + `machineId` |
| `POST /api/usage` (global) | 600 | 1 hour | the whole deployment, per UTC hour bucket |
| `GET /api/usage` | 120 | 1 hour | per token |
| `GET /api/status` | 120 | 1 hour | per token |
| Any `Authorization: Bearer` on `/api/usage` or `/api/status` that fails | 60 | 1 minute | per IP (hashed) |
| `POST /api/alerts/test` | 1 | 10 seconds | global (one counter for every caller) |
| `POST /api/csp-report` | 20 | 1 minute | per IP, in-process only |
| Dashboard login / sudo PIN guesses | 5 | 15 minutes | per IP, with an escalating lockout (15 min → 30 min → … capped at 6 hours) |
| Dashboard login (global) | 30 | 1 hour | browsers with no known-device cookie only |

Body size caps: `POST /api/usage` 64 KB · `PUT /api/settings` 16 KB · `PUT /api/api-token` 2 KB ·
`PUT /api/official-usage` 1 KB · `POST /api/tokens` 1 KB · `PATCH /api/machines/[provider]/[machine]`
1 KB · `PATCH /api/groups/[group]` 1 KB · `POST /api/alerts/test` 2 KB · `POST /api/auth/sudo` 1 KB ·
`POST /api/csp-report` 8 KB.

Registry caps (`storeReport`/`parseSettingsUpdate`, refused with `422`/`400` rather than silently
truncated): 200 machines (`MAX_MACHINES`), 50 groups (`MAX_GROUPS`), 20 providers (`MAX_PROVIDERS`),
100 per-machine tokens (`MAX_TOKENS`).

## `GET`/`POST /api/usage`

The client-facing ingest endpoint. Auth: **bearer**.

**`GET /api/usage`** — the current cycle, for a client to scope its next `ccusage` run. A provider
can have its own reset, so `cycle.start`/`end`/`sinceDate` are the earliest provider cycle's (the
shared reset included), and `cycle.providers` holds each provider's own:

```json
{
  "tokenMode": "snapshot",
  "providers": ["claude", "deepseek", "openai"],
  "cycle": {
    "start": "2026-09-21T00:00:00.000Z",
    "end": "2026-09-28T00:00:00.000Z",
    "sinceDate": "2026-09-21",
    "timeZone": "Europe/Budapest",
    "providers": {
      "claude": { "start": "2026-09-17T09:00:00.000Z", "end": "2026-09-24T09:00:00.000Z" },
      "openai": { "start": "2026-09-21T00:00:00.000Z", "end": "2026-09-28T00:00:00.000Z" }
    }
  }
}
```

`200` ok · `401` bad/missing token · `429` rate limited.

**`POST /api/usage`** — see [the report schema](#the-report-schema) for the body. Response:

```json
{
  "ok": true,
  "duplicate": false,
  "groupRegistered": false,
  "providersRegistered": ["kimi"],
  "report": { "...": "the validated & normalized report, echoed back" },
  "tokenMode": "snapshot",
  "cycle": { "start": "2026-09-21T00:00:00.000Z", "end": "2026-09-28T00:00:00.000Z" }
}
```

`groupRegistered` is `true` when the `groupId` wasn't on the settings panel's list yet (it's now
auto-registered with the next free preset color). `providersRegistered` lists any provider ids seen for the first
time. There is no equivalent `machineRegistered` flag — a new machine is simply reflected the next
time `GET /api/machines` is read.

| Status | Meaning |
| --- | --- |
| `201` | Stored. |
| `200` | This exact report (same machine, tokens, and timestamp) was already stored — `"duplicate": true`; resending never double-counts. |
| `400` | Invalid JSON or field; `details` lists every problem. |
| `401` | Missing or wrong Bearer token. |
| `403` | `machine_mismatch` — a machine-bound token reported for a different `machineId`. |
| `413` | Body over 64 KB. |
| `422` | A registry cap refused the report (`too_many_groups`/`too_many_providers`/`too_many_machines`), with `limit`. |
| `429` | Rate limited, with `retryAfterSeconds`. |
| `500` | `server_misconfigured` — no (long enough) `USAGE_API_TOKEN`. |
| `503` | Redis not configured or unreachable — the client should retry next hour. |

## The report schema

```json
{
  "machineId": "mac-studio",
  "groupId": "Personal",
  "timestamp": "2026-09-21T10:00:00Z",
  "providers": { "deepseek": 15000, "claude": 22000, "openai": 9000 },
  "models": {
    "claude": { "claude-opus-4-5-20251101": 18000, "claude-haiku-4-5-20251001": 4000 },
    "deepseek": { "deepseek-chat": 15000 }
  },
  "days": {
    "2026-09-20": {
      "providers": { "claude": 12000, "openai": 9000 },
      "models": { "claude": { "claude-opus-4-5-20251101": 12000 } },
      "hours": { "claude": { "2026-09-20T08:00:00Z": 5000, "2026-09-20T09:00:00Z": 7000 } }
    },
    "2026-09-21": { "providers": { "deepseek": 15000, "claude": 10000 } }
  },
  "costs": { "claude": 12.3456 },
  "modelCosts": { "claude": { "claude-opus-4-5-20251101": 10.2, "claude-haiku-4-5-20251001": 2.15 } },
  "mode": "auto",
  "intervalMinutes": 60
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `machineId`, `groupId` | yes | 1–64 characters: letters (any script), digits, spaces, `.`, `_`, `-`. |
| `timestamp` | yes | ISO 8601 with a zone designator. Rejected if more than `MAX_CLOCK_SKEW_MINUTES` (10) in the future, or older than the retention window (`RETENTION_DAYS`, 70 days). |
| `providers` | yes | 0–20 entries (`MAX_PROVIDERS`); each value a non-negative safe-integer JSON number. Empty `{}` is a **heartbeat** — the group is registered, nothing else is written. |
| `models` | no | Per provider, up to 20 models (`MAX_MODELS_PER_PROVIDER`), 60 total (`MAX_MODELS_PER_REPORT`). Every named provider must be in `providers`; a provider's models may not sum to more than its own total (may sum to less — not every token is attributable). |
| `days` | no | Up to 32 days (`MAX_REPORT_DAYS`), keyed `"YYYY-MM-DD"` (in the cycle's time zone). Each day: `providers` (must be a subset of the top-level `providers`, summing to no more than each provider's total across all days), optional `models` (same rules as top-level), optional `hours`. |
| `days.*.hours` | no | Up to 25 entries per provider per day (`MAX_DAY_HOURS`) — the extra one covers a DST fall-back day. Keys are `"YYYY-MM-DDTHH:00:00Z"`, must fall inside that calendar day, summing to no more than the day's total for that provider. Only stored as day/hour checkpoints in `snapshot` mode. |
| `costs` | no | Opt-in (see [clients.md](clients.md#the-opt-in-cost-estimate)). Per provider, a non-negative number up to 10,000,000 (`MAX_COST_USD` — headroom, not a real budget). Every named provider must be in `providers`. |
| `modelCosts` | no | Per provider (must be in `costs`), per model, same caps as `models`; a provider's models may not sum to more than its own cost there (0.01 rounding slack, `COST_EPSILON`). |
| `mode` | no | `"auto"` (default when absent) or `"manual"` — which client wrapper sent it; drives the dashboard's machine-health indicator. |
| `intervalMinutes` | no | 5–1440. The auto client's own reporting interval, when it differs from the server's default — so a machine on a custom schedule isn't flagged "late" between reports. |

Provider ids are normalized: lower-cased, 1–64 characters of `a-z`, `0-9`, `.`, `-`, `_`; model ids
the same pattern. See [data-model.md](data-model.md) for how `snapshot`/`delta`/`counter` modes (the
`TOKEN_MODE` setting) interpret `providers`' values, and for the day/hour checkpoint mechanism.

## `GET /api/status`

The current cycle's usage per provider, in a compact, versioned shape: what the
[macOS menu bar app](../clients/macos/README.md) shows. Auth: **bearer** — the master token, a
per-machine token, or (meant for this) a [`"read"` one](#per-machine-tokens). Source:
`app/api/status/route.ts`, `lib/status.ts`. Allowed in demo mode.

Every figure is the dashboard's own: the same model, with the official reading typed on the
dashboard laid over it. Percentages are 0–100 (above 100 when over the limit), two decimals;
times are ISO 8601. `v` only changes for a breaking change — new fields are added to version 1.

```json
{
  "v": 1,
  "generatedAt": "2026-10-07T09:12:00.000Z",
  "cycle": { "period": "weekly", "start": "…", "end": "…", "timeZone": "Europe/Budapest" },
  "providers": [
    {
      "id": "claude", "label": "Claude Code",
      "cycle": { "start": "…", "end": "…" },
      "percent": 62.4, "source": "official", "estimatedPercent": 58.91, "asOf": "…",
      "tokens": 41200000, "limit": 70000000, "status": "warning",
      "pace": { "projectedPercent": 108.03, "runOutAt": "2026-10-11T15:00:00.000Z" },
      "subLimits": [{ "id": "fable", "name": "Fable", "percent": 80.1, "source": "provider", "status": "warning" }],
      "groups": [{ "id": "Personal", "percent": 41.6, "tokens": 27466667 }],
      "machines": [{ "id": "mac-studio", "groupId": "Personal", "percent": 33.3, "tokens": 22000000, "lastReportAt": "…" }],
      "lastReportAt": "2026-10-07T09:00:04.000Z"
    }
  ]
}
```

- `cycle` (top level) — the shared reset's cycle; `providers[].cycle` — that provider's own, which
  differs while it has its own reset (see [configuration.md](configuration.md#reset-and-time-zone)).
- `percent` — how much of the budget is gone; `null` with the token limits off and no official
  reading. `source` is `"official"` when a typed official reading drives it, `"estimate"` when the
  machines' measurement does, `null` with `percent`. `estimatedPercent` is the measurement against
  the token limit either way (`null` without one).
- `status` — `good` / `warning` / `critical` (lib/quota.ts); `pace` — the linear projection for the
  cycle (`projectedPercent` `null` while too early) and when the budget runs out at that pace
  (`runOutAt` `null` if it lasts); both `null` with `percent`.
- `subLimits[].source` — `official`, `provider` (a share of the provider's official figure) or
  `measured`; `percent` is of its own budget, `null` while unknown.
- `groups` / `machines` — the dashboard's breakdown, heaviest first (machines silent this cycle last,
  at 0): `percent` is each one's part of the provider's whole budget, restated by the official
  reading like the dashboard's, `null` whenever the provider's `percent` is.
- `lastReportAt` — the newest report of any machine counted for the provider this cycle.

The full example is `clients/tests/fixtures/status-v1.json`, the contract both the server's tests
(`tests/integration/status.test.ts`) and the app's own check against.

`200` ok · `401` bad token · `429 rate_limited` (with `retryAfterSeconds`) · `500` server
misconfigured · `503` Redis down.

## `GET /api/health`

Auth: **none**. No data, no configuration — only whether the process is up and the store answers.

```json
{ "ok": true, "version": "0.1.0", "commit": "a1b2c3d", "storage": "redis", "store": "ok", "latencyMs": 12, "time": "2026-09-26T10:00:00.000Z" }
```

`store`: `"ok"` · `"unavailable"` (configured but unreachable/erroring) · `"not_configured"` (no
`KV_REST_API_URL`/`KV_REST_API_TOKEN`). `storage`: `"redis"` or `"memory"` (`USAGE_STORE=memory` or
demo mode). `200` when the store answers within 2 seconds, `503` otherwise.

## `GET`/`PUT /api/settings`

Auth: **session** (GET), **session** + same-origin (PUT).

`GET` → `{ settings, timeZone, providers: [{id, label, models}], groups: [{id, color, hasReports}] }`
(`settings` matches the shape in [configuration.md](configuration.md)).

`PUT` body — the whole document; nothing is filled in with a default, so every field below is
required on every save (a document stored before some of them existed is still read leniently on
`GET`, and by every other code path — see [data-model.md](data-model.md)):

```json
{
  "period": "weekly",
  "useTokenLimits": false,
  "limits": { "claude": 500000, "deepseek": 750000, "openai": 1000000 },
  "reset": { "weekday": 1, "monthDay": 1, "hour": 0, "minute": 0, "timeZone": "Europe/Budapest" },
  "showRemaining": true,
  "hiddenProviders": ["openai"],
  "excludedProviders": { "Work": ["claude", "deepseek"] },
  "subLimits": {
    "claude": [{ "id": "fable", "name": "Fable", "models": ["fable"], "mode": "share", "sharePercent": 40, "limit": 400000 }]
  },
  "alerts": { "webhookUrl": null, "thresholds": [50, 80, 100], "perProvider": true, "format": "generic", "locale": "en" },
  "groups": [{ "id": "Work", "color": "#3987e5" }],
  "removedGroups": ["Old"]
}
```

`groups` creates or recolors — groups not listed are left untouched (so one that appeared on its own
in the meantime, from a client report, isn't wiped out by an unrelated save). `removedGroups` only
succeeds for groups with no stored reports.

| Status | Meaning |
| --- | --- |
| `200` | Saved (PUT) or read (GET). |
| `400` | Invalid JSON/field, or the save would hide every provider. |
| `401` | No valid session. |
| `403` | Foreign `Origin`. |
| `409` | `groups_have_reports` — a group in `removedGroups` still has data; **nothing was saved**. |
| `413` / `415` | Body over 16 KB, or not JSON. |
| `503` | Redis down. |

## `PUT /api/official-usage`

Auth: **session** + same-origin. One [official-percentage](configuration.md#the-official-percentage-charts-and-history)
field, written on a debounced pause after typing (or dragging the slider), not on every keystroke.

```json
{ "providerId": "claude", "subLimitId": "fable", "raw": "45.5", "cycleStartMs": 1758326400000 }
```

`subLimitId: null` targets the provider's own field; empty `raw` clears it. `cycleStartMs` is the
field's own cycle, from the dashboard it was typed on. `200 { "ok": true, "enteredAt": <ms> }` ·
`400` invalid JSON/payload · `401` no session · `403` foreign origin · `413`/`415` bad body · `503`
Redis down.

## `GET /api/setup`

Auth: **session** (redirects `303` to `/setup` without one, rather than a JSON 401 — it's meant to be
opened as a link/download). `?os=macos|linux|windows&mode=auto|manual&group=Work&machine=win-desktop&cost=1`.
Returns the Setup page's ZIP: `200 application/zip` with `Content-Disposition: attachment` · `303` no
session · `400` bad parameters · `503` Redis down. Contains no secret — see
[clients.md](clients.md#installing-from-the-setup-page).

## The stored API token

Behind the dashboard's session, like `/api/settings`. See [security.md](security.md) for the
encryption/rotation mechanics.

- **`GET /api/api-token`** → `{ "status": { "state": "no_key"|"empty"|"unreadable"|"stored", "updatedAt", "matchesServer", "keyId", "needsReseal" } }`. `200` · `401` no session · `503` Redis down.
- **`PUT /api/api-token`** (session + same-origin) `{ "token": "…" }` — 16–512 printable ASCII
  characters, no spaces. `200 { "ok": true, "action": "created"|"updated", "status": {...} }` ·
  `400` invalid token · `401` no session · `403` foreign origin · `413`/`415` bad body ·
  `500 encryption_key_missing` · `503` Redis down.
- **`POST /api/api-token/reveal`** (session **+ sudo**, same-origin) — logs a `revealed` audit entry
  *before* answering. `200 { "token": "…" }` · `401` no session · `403` foreign origin, demo mode, or
  no sudo grant · `404 no_token` · `409 token_unreadable` · `500 encryption_key_missing` · `503`
  Redis down.
- **`GET /api/api-token/audit`** (session only) → `{ "entries": [{at, action, browser, os, userAgent, ip, session}], "currentSession" }`, newest first, up to 500 entries. `401` no session · `503` Redis down.

## Per-machine tokens

Behind the session; creating and revoking also need sudo, since the plaintext is shown once and
never again. See [clients.md](clients.md#per-machine-tokens-vs-the-master-token).

- **`GET /api/tokens`** → `{ "tokens": [{id, label, machineId, scope, createdAt, lastUsedAt, revokedAt}] }`
  (never the token or its hash). `401` no session · `503` Redis down.
- **`POST /api/tokens`** (session + sudo, same-origin) `{ "label": "…", "machineId"?: "…", "scope"?:
  "ingest" | "read" }` → `201 { "id", "token" }`. `scope` defaults to `"ingest"`; a `"read"` token (the
  [menu bar app](#get-apistatus)'s) only reads `GET /api/status` and `GET /api/usage`, is refused by
  `POST /api/usage` with `403 read_only_token`, and takes no `machineId`. `400` invalid body · `401` no
  session · `403` foreign origin, demo mode, or no sudo grant · `413`/`415` bad body ·
  `422 too_many_tokens` (with `limit`, 100) · `503` Redis down.
- **`DELETE /api/tokens/[id]`** (session + sudo, same-origin) → `200 { "ok": true }`, idempotent.
  `401` no session · `403` foreign origin, demo mode, or no sudo grant · `404` no such token · `503`
  Redis down.

## Machines

- **`GET /api/machines`** (session) → `{ "machines": [{providerId, machineId, groupId, lastSeenAt, lastTokens}] }`. `401` no session · `503` Redis down.
- **`PATCH /api/machines/[provider]/[machine]`** (session, same-origin) `{ "id"?: "new-machine-id",
  "group"?: "group-id", "merge"?: true }` (at least one of `id`/`group`) renames the machine, moves it
  to another existing group, or both, with all its stored reports. Onto an id the provider already
  uses it answers `409 machine_exists`, unless `merge` is set (**needs sudo**): the two histories are
  then combined day by day, counting each day as the identity that saw more of it (snapshot mode
  only, else `409 merge_unsupported`). →
  `200 { "ok": true, "affected": {events, machines, groups} }`. `400` invalid id/body · `401` no
  session · `403` foreign origin, demo mode, or (merge) no sudo grant · `404 not_found` (no such
  machine) or `group_not_found` · `409 machine_exists` / `merge_unsupported` · `413`/`415` bad body ·
  `503` Redis down.
- **`DELETE /api/machines/[provider]/[machine]`** (session **+ sudo**, same-origin) — same response
  shape. `403` also covers "no sudo grant" · `404` no such machine.
- **`POST /api/machines/prune`** (session + sudo, same-origin) — removes every machine silent longer
  than `INACTIVE_MACHINE_DAYS`. `200 { "ok": true, "affected": {"events": 0, "machines": N, "groups": 0} }`.

## Groups

- **`PATCH /api/groups/[group]`** (session, same-origin) `{ "id": "new-name" }` renames onto a free
  id (no sudo needed) · `{ "id": "existing", "merge": true }` merges two groups' histories (**needs
  sudo**). `200 { "ok": true, "affected": {...} }` · `400` invalid id/body · `401` no session ·
  `403` foreign origin, demo mode, or (merge) no sudo · `404` no such group · `409 group_exists` ·
  `413`/`415` bad body · `503` Redis down.
- **`DELETE /api/groups/[group]`** (session + sudo, same-origin) `?force=1` required once it has
  stored reports (`409 group_has_events` otherwise). Same response shape.

## Providers

- **`DELETE /api/providers/[provider]`** (session + sudo, same-origin) — removes a provider outright:
  its events in every group, its machines, its official-usage figures, and every trace of it in the
  settings document. The panel only offers this once a provider is already hidden. `?force=1` required
  once it has stored events (`409 provider_has_events` otherwise). `200 { "ok": true, "affected": {...} }` ·
  `400` invalid provider id · `401` no session · `403` foreign origin, demo mode, or no sudo · `404`
  no such provider · `503` Redis down.

## Alerts test

- **`POST /api/alerts/test`** (session, same-origin, rate-limited to 1 call/10s globally)
  `{ "webhookUrl": "https://…", "format": "slack", "locale": "en" }` → `200 { "ok": true, "status": 200 }`.
  `400` bad JSON/payload · `401` no session · `403` foreign origin · `413`/`415` bad body · `429` rate
  limited · `502 { "error": "webhook_failed", "status", "detail" }` (the upstream status, `null` for a
  network failure, and the error message) · `503` Redis down.

## Sudo

- **`GET /api/auth/sudo`** (session) → `{ "numeric": true|false }` — whether the PIN is digits-only,
  for a numeric keypad. `401` no session.
- **`POST /api/auth/sudo`** (session, same-origin) `{ "pin": "…" }` → `204` granted (5 minutes).
  `401 { "error": "sudo_invalid", "attemptsLeft"? }` · `403` foreign origin · `413`/`415`/`400` bad
  body · `429 { "error": "rate_limited", "retryAfterSeconds" }` (shares the login IP limiter — see
  [security.md](security.md)) · `500 server_misconfigured` (no valid `DASHBOARD_PIN`) · `503` Redis
  down.

## Housekeeping

- **`GET /api/cron/housekeeping`** — auth: **cron secret**. `?dryRun=1` reports without deleting
  anything. `200 { "report": HousekeepingReport }` · `401` missing/wrong bearer ·
  `403 demo_read_only` in demo mode (checked before the secret, so a demo deployment refuses this even
  with a valid `CRON_SECRET`) · `500 server_misconfigured` (`CRON_SECRET` unset or under 16 characters
  — refuses to run rather than accept every request).
- **`POST /api/housekeeping`** — the settings panel's manual trigger. Auth: **session** for a dry run
  (`?dryRun=1`), **session + sudo** for a real run (it deletes index entries). Same response shape and
  report as the cron endpoint. See [data-model.md](data-model.md) for exactly what's pruned.

## Export

- **`GET /api/export`** — auth: **session** (a read, so it also works in demo mode).
  `?format=csv|json&cycle=current|previous&provider=<id>` (`cycle` defaults to `current`; `provider`
  defaults to every visible provider). Response: `200`, a file download
  (`Content-Disposition: attachment`).
  - CSV columns: `provider,groupId,machineId,timestamp,tokens,checkpoint,models,costUsd`.
  - JSON shape: `{ generatedAt, timeZone, cycle: {start, end}, providers: [{id, label, cycle: {start, end}, events, history}] }`
    — the top-level `cycle` is the earliest provider's, `providers[].cycle` the provider's own window
    of the requested cycle; `events` are that window's raw reports, `history` is every archived cycle for that
    provider (not filtered to the requested cycle).
  - `400` bad query · `401` no session · `404` unknown provider · `503` Redis down.

## CSP report

- **`POST /api/csp-report`** — auth: **none** (browsers send these unprompted, often with no
  `Origin`). Accepts `application/csp-report` (legacy) or `application/reports+json` (the Reporting
  API); every violation is logged as `csp.violation` and nothing else happens to it. `204` always ·
  `413` over 8 KB · `415` any other content type · `429` over 20/minute from one IP (in-process
  counter, so it keeps working even if Redis is down). See
  [security.md](security.md#content-security-policy) for the `SECURITY_CSP` rollout this feeds.

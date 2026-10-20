# Data model

The full key layout is also documented at the top of `lib/redis-keys.ts` (`KEYS`) — this page expands
on it. All data goes through Upstash's REST API (`lib/redis.ts`); `USAGE_STORE=memory` or
`DEMO_MODE=1` swap in an in-memory implementation of the same interface (`lib/redis-memory.ts`) for
local development and tests.

- [Redis keys](#redis-keys)
- [Snapshot semantics and checkpoints](#snapshot-semantics-and-checkpoints)
- [The settings document](#the-settings-document)
- [Backward compatibility](#backward-compatibility)
- [History (archived cycles)](#history-archived-cycles)
- [The legacy migration](#the-legacy-migration)

## Redis keys

| Key | Type | Shape | Retention | Written by |
| --- | --- | --- | --- | --- |
| `usage:settings` | STRING | JSON: `{v, period, useTokenLimits, limits, reset, resetOverrides, showRemaining, costEstimate, hiddenProviders, excludedProviders, subLimits, alerts, updatedAt}` — see [the settings document](#the-settings-document) | Forever (one document) | `PUT /api/settings` (`lib/usage-store.ts` `saveSettings`) |
| `usage:providers` | HASH | `providerId → firstSeenMs` | Pruned by housekeeping once dead (no events, no live machine, unreferenced by settings, older than the retention window) | First report of a new provider (`HSETNX`); `npm run seed` |
| `usage:events:{providerId}:{groupId}` | ZSET | score = report time (epoch ms); member = JSON `{"m": machineId, "t": tokens, "ts": ms, "b"?: {modelId: tokens}, "$"?: costUsd, "$b"?: {modelId: costUsd}, "c"?: 1}` — `"c":1` marks a day/hour checkpoint, not a real report | Self-pruning: every write also trims members older than `RETENTION_DAYS` (70) and re-sets the key's own TTL to `(RETENTION_DAYS + 1)` days | `POST /api/usage` (`storeReport`) |
| `usage:groups` | HASH | `groupId → JSON {"color": "#rrggbb", "ts": firstSeenMs}` (a bare number in entries older than group colors) | Pruned by housekeeping once a group has zero events across every provider and is old enough | `POST /api/usage` (auto-register, `HSETNX`), `PUT /api/settings` (create/recolor) |
| `usage:machines` | HASH | `providerId:machineId → JSON {"g": groupId, "ts": ms, "t": tokens, "md"?: "manual", "iv"?: intervalMinutes}` (`md`/`iv` omitted for the common case: mode `"auto"` with no custom interval) | Pruned by housekeeping once silent longer than `RETENTION_DAYS` (70); the settings panel's "remove silent machines" button prunes those silent longer than `INACTIVE_MACHINE_DAYS` (35) | `POST /api/usage` |
| `usage:official` | HASH | `providerId`, or `providerId:subLimitId`, → JSON `{"raw": "45.5", "enteredAt": ms, "cycleStartMs": ms}` | Pruned by housekeeping once its `cycleStartMs` is no longer the current cycle | `PUT /api/official-usage` |
| `usage:api-token` | STRING | JSON `{"v":1, "kid"?, "iv", "ct", "tag", "updatedAt"}` — AES-256-GCM, see [security.md](security.md) | Forever (one document, until overwritten) | `PUT /api/api-token` |
| `usage:api-token:audit` | LIST | Newest first, JSON per entry: `{"at","a","ua","ch","pf","s", "ip"|"iph"+"ipp"}` | Capped at 500 entries (`LTRIM` on write); older-than-`AUDIT_RETENTION_DAYS` entries pruned by housekeeping | `PUT`/`POST /api/api-token(/reveal)` |
| `usage:tokens` | HASH | `sha256(token) → JSON {"id","label","machineId","createdAt","lastUsedAt","revokedAt"}` — the field is the token's own hash, the plaintext is never stored | Up to `MAX_TOKENS` (100) live; a revoked entry is dropped entirely 90 days after `revokedAt` (housekeeping) | `POST`/`DELETE /api/tokens*` |
| `usage:housekeeping:last` | STRING | JSON `{"at": ms, "report": HousekeepingReport}` | Forever (overwritten each run) | `runHousekeeping` (non-dry-run) |
| `usage:alert:{providerId}:{cycleStartMs}:{threshold}` | STRING | `"1"`, `SET NX` | 70 days TTL | `lib/alerts.ts` `evaluateAlerts` — the guard that makes a threshold fire once per provider per cycle |
| `usage:history:{providerId}` | ZSET | score = cycle start (epoch ms); member = JSON `CycleSummary` (see [History](#history-archived-cycles)) | Newest 24 entries per provider (`HISTORY_RETENTION`), trimmed on write | The first dashboard render after a cycle ends, or the daily housekeeping run's `history` step — whichever comes first (`archiveCycle` via `archiveDueCycles`); also `npm run seed`'s pre-archived entries |
| `usage:session:{sha256(sessionId:pin)}` | STRING | JSON `{"c": createdAtMs, "s": lastSeenMs}` (a bare `"1"` for a legacy pre-rolling session) | Ends after `SESSION_IDLE_DAYS` (default 7) without use, and `SESSION_MAX_DAYS` (default 30) after creation at the latest; the key's TTL is the remaining maximum lifetime | Login (`attemptLogin`); `s` refreshed at most hourly by `isAuthenticated` |
| `usage:session:{...}:sudo` | STRING | `"1"` | 5 minutes | `POST /api/auth/sudo` |
| `usage:auth:device:{sha256(deviceId)}` | STRING | `"1"` | 365 days | A successful login |
| `usage:auth:ip:{sha256(ip)}` (+ `:strikes`) | STRING | attempt counter | 15 min window, escalating on repeat lockouts (up to 6h); strikes remembered 24h | Login/sudo attempts |
| `usage:auth:global` | STRING | attempt counter | 1 hour | Login attempts from browsers with no known-device cookie |
| `usage:rl:*` (`ingest`, `ingest:global`, `cycle`, `unauth`, `alerts-test`) | STRING | fixed-window counter (`lib/rate-limit.ts`) | matches the limit's own window | The endpoint being rate-limited |
| `usage:demo:seededAt`, `usage:demo:seeding` | STRING | timestamp / lock | `usage:demo:seeding` expires after 60s | Demo mode's self-seeding (`ensureDemoData`) |

Every hash above (`providers`, `groups`, `machines`, `official`) is a separate top-level key rather
than nested inside `usage:settings` for one reason: **atomic, lock-free registration**. Clients all
report at minute 0 of the hour; a first report from an unseen group/provider/machine has to register
it without a read-modify-write race against a concurrent report or a settings-panel save. `HSETNX`
inside the report's own transaction gives that — it registers only if absent, and never touches an
already-defined entry.

## Snapshot semantics and checkpoints

`TOKEN_MODE` (env var, initial value only — see [configuration.md](configuration.md)) decides how a
report's `providers` values are read back:

| Mode | The client sends | The dashboard computes |
| --- | --- | --- |
| `snapshot` (default) | The machine's running total for the current cycle (what `ccusage daily --since <cycleStart>` naturally gives) | The **largest** report of the cycle, per machine/provider series — a later, lower value (logs cleared on the machine) can never pull the total back down |
| `delta` | Tokens used since the previous report | The **sum** of the cycle's reports |
| `counter` | An ever-increasing odometer | The sum of the **increases** between consecutive reports; a drop is treated as a restart |

This is a read-time interpretation, not a write-time one — every mode's raw reports are stored
identically, so switching `TOKEN_MODE` re-reads existing history under the new rule with no
migration needed.

**Checkpoints**: when a report includes `days` (and, for Claude Code, `hours`), the store computes the
machine's running total at the end of every *finished* day and hour of the report's own cycle
(`lib/days.ts` `reportCheckpoints`) and writes each as an extra ZSET member, flagged `"c": 1`. This
lets the charts place tokens at the moment they were actually used — including days/hours before a
machine's first report, or days a manual machine skipped — instead of the whole gap jumping up at the
next real report. A checkpoint **is not a report**: the machine table's
report counter and the "late"/"behind" health indicator both ignore checkpoint members — and only
`snapshot` mode reads a running total from one at all (`delta`/`counter` mode would double-count it).
`ZADD NX` means every later report resending the same days is a no-op, until a day's total actually
changes. Only checkpoints falling **within the report's own cycle** are ever written.

Deduplication needs no extra key: the member is the report itself (machine, tokens, timestamp, model
split, cost, checkpoint flag), and the group is part of the key. A retried, byte-identical `POST`
therefore serializes to the exact same ZSET member, and `ZADD NX` reports it as already present.
That is how `POST /api/usage` detects `duplicate: true`: every provider's `ZADD` added nothing new.

## The settings document

`usage:settings` has gone through three shapes, and `lib/settings.ts` `parseStoredSettings` reads all
of them leniently — a missing document, or any individual field that doesn't parse, falls back to the
deploy-time default (`lib/config.ts`) rather than failing the whole read:

- **v1**: a single global `limit` (no per-provider budgets). On read, that value is projected onto
  every provider already known (nothing to seed it onto on a completely fresh install).
- **v2**: per-provider `limits` and everything else except `reset.timeZone` and `alerts`. Fields added
  to v2 over time (`useTokenLimits`, `showRemaining`, `costEstimate`, `hiddenProviders`,
  `excludedProviders`, `subLimits`) are read with their defaults when a document predates them. A v2 document has no time
  zone, so it uses the deploy-time one (`RESET_TIMEZONE` env, else UTC).
- **v3** (current, `{v: 3, ...}`): adds `reset.timeZone` (an IANA name, validated with
  `Intl.DateTimeFormat`) and `alerts`. A document without `alerts` reads as `alerts.webhookUrl: null`
  (off).

`resetOverrides` (providerId → `{ weekday, monthDay, hour, minute }`) is the provider's own reset over
the shared period and time zone; `{}` for none. A document without it reads as no overrides. An entry
may carry `source?: "report"` — set by an official report; the panel drops it when the entry is edited.

`PUT /api/settings`, in contrast to the lenient reader above, requires **every** field on every save —
nothing is defaulted on write, so a client that only wants to change one field must first `GET`, edit,
and send the whole document back.

## Backward compatibility

- **Pre-provider data**: before providers existed, keys were `usage:events:{groupId}` (no provider in
  the key) and `usage:machines` fields were bare `machineId` (no `providerId:` prefix). The current
  code **no longer reads either shape** — see [The legacy migration](#the-legacy-migration).
- **Group colors**: an `usage:groups` entry that's a bare number (rather than a JSON object) is the
  pre-color format — read as `{color: null, firstSeenAt: <that number>}`; such a group gets an
  assigned preset color the same way an uncolored new group would.
- **Machine health fields** (`mode`, `intervalMinutes`): absent in any entry written before they
  existed — read as `mode: "auto"`, `intervalMinutes: null`.
- **Legacy sessions**: a session value that's the bare string `"1"` (from before rolling sessions
  existed) is accepted as freshly created and freshly seen, then upgraded to the current
  `{c, s}` shape on its next touch — nobody is logged out by the deploy that introduced rolling
  sessions.
- **Encrypted secrets without a `kid`**: a `usage:api-token` document sealed before key-rotation
  support existed has no `kid` field; it's tried against the current key (and, if set, the previous
  one) and re-sealed with a `kid` the next time it's read. See [security.md](security.md).

## History (archived cycles)

Raw events are only kept for `RETENTION_DAYS` (70 days) — enough to cover the current and previous
cycle even for a monthly budget (up to 62 days) — so anything older is summarized into a
`CycleSummary` and kept far longer (24 cycles, `HISTORY_RETENTION`):

```json
{
  "v": 1, "start": 1758326400000, "end": 1758931200000,
  "total": 412000, "cost": 18.42, "limit": 500000, "official": 82,
  "groups": { "Work": 300000, "Personal": 112000 },
  "machines": 3,
  "models": { "claude-opus-4-5": 250000, "claude-sonnet-4-5": 162000 },
  "subLimits": { "fable": 40000 },
  "archivedAt": 1758931200000
}
```

`cost` is present only if at least one event of that cycle carried a cost estimate; `models` keeps
only the heaviest `HISTORY_TOP_MODELS` (8) models, largest first.

**Archived from two places, whichever runs first.** For every provider, if the newest archived cycle
is older than the *previous* cycle's start, and that previous cycle actually has events, the previous
cycle is summarized from data still in Redis and written with `ZADD NX`. Two callers share this
(`lib/archive.ts` `archiveDueCycles`): the first dashboard render after a cycle ends, and the daily
housekeeping run's `history` step (`GET /api/cron/housekeeping`, run before its official-usage-pruning
step so that cycle's typed-in percentage still makes it into the summary). Racing callers still write
exactly one entry — `archivedAt` is the cycle's own end time, not wall-clock time, so every caller
computes byte-identical summary JSON. Only the cycle right **before** the current one can ever be
archived this way — by the time a later cycle would need to archive an older one, that older cycle's
raw events are already gone from Redis (past `RETENTION_DAYS`). A cycle is only lost if **neither**
the dashboard is opened **nor** the daily housekeeping cron runs during the following cycle — with
the cron configured (see [getting-started.md](getting-started.md) and
[self-hosting.md](self-hosting.md)), history no longer depends on anyone opening the dashboard. The
housekeeping report lists the archived providers under `history: { archived, ids }`; a dry run
names the providers that are due and writes nothing.

## The legacy migration

For a store that predates multi-provider support (it only ever tracked DeepSeek), run this **once**
against production, **before** deploying this release, which no longer reads the old
(provider-less) key shapes:

```bash
npm run migrate:legacy               # dry run: prints the plan, writes nothing
npm run migrate:legacy -- --apply    # performs it
```

It reads `KV_REST_API_URL`/`KV_REST_API_TOKEN` (from the environment or `.env.local`) like any other
script here. What it does:

- `usage:events:{groupId}` → renamed to `usage:events:deepseek:{groupId}` (`RENAMENX`) if no
  provider-prefixed set exists yet for that group, or **merged** into it (`ZUNIONSTORE … AGGREGATE MAX`,
  so a report present in both sets is kept once) if one already does; then the legacy key is deleted.
- `usage:machines` fields with no `providerId:` prefix are moved to `deepseek:{field}`, keeping
  whichever of the two (if both exist) has the newer `ts`.

Idempotent: a second run (dry or applied) finds nothing left to do (`renamed: 0, merged: 0,
machinesMoved: 0`, everything reported as `skipped`).

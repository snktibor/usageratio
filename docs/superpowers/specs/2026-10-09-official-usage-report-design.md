# Official usage reports from the macOS app — design

Date: 2026-10-09 · Status: approved in chat, awaiting spec review

## Goal

The macOS menu bar app reads the providers' own subscription usage percentages (Claude, Codex) on
the machine it runs on and uploads them as the dashboard's official reading — automatically on its
five-minute poll, and on demand from the popover's ↻ button.

## Constraints

- **No use of a provider's credentials.** The app never reads Claude Code's OAuth token or calls an
  undocumented endpoint. It only reads what the tools hand out themselves: the `rate_limits` field
  Claude Code passes to the user's status line script (documented at
  <https://code.claude.com/docs/en/statusline>), and the `rate_limits` Codex writes into its own
  session logs.
- Consequently a reading is as fresh as the last Claude Code / Codex response; the ↻ button uploads
  the latest known snapshot, it cannot force the provider to report.
- Only the weekly window is uploaded. The 5-hour window has no counterpart on the server and is
  shown in the app only. No sub-limits: the status line gives no per-model split.

## Approach

The server decides, the app only reports facts (provider, weekly %, when the window resets, when the
snapshot was taken). Cycle matching, cycle adjustment and which cycle the reading belongs to are all
decided in one place in `lib/`, testable with Vitest, and any other client could report the same way.

## Part 1 — per-provider budget cycle (server)

- `UsageSettings` gains `resetOverrides: Record<providerId, { weekday, monthDay, hour, minute }>`.
  Period (weekly/monthly) and time zone stay shared. A provider without an entry uses the shared
  `reset`, so existing deployments behave exactly as before.
- `resetFor(config, providerId)` in `lib/settings.ts` is the single place that resolves a provider's
  reset. Every `getCycle` / `getPreviousCycle` caller (`lib/status.ts`, `lib/dashboard.ts`,
  `lib/housekeeping.ts`, `lib/alerts.ts`, `lib/ingest.ts`, `lib/manage-store.ts`,
  `lib/cycle-options.ts`, `app/api/export`, `app/api/usage`, the dashboard and settings pages)
  computes the cycle per provider instead of once for all.
- No data migration: history (`usage:history:{providerId}`) and alert guards
  (`usage:alert:{providerId}:…`) are already per provider. Changing a provider's reset mid-cycle
  behaves like changing the shared reset by hand today (old checkpoints stay; snapshot mode takes the
  largest total of the cycle).
- Settings page: each provider gets an "own reset" switch with day and time pickers. New strings in
  `messages/en.json`, `hu.json`, `de.json`.
- `GET /api/status` returns each provider's own `cycle`.

## Part 2 — report endpoint and the `official` token scope (server)

- Token scopes become `ingest | read | official`. `official` may `GET /api/status` and
  `POST /api/official-usage/report`; `POST /api/usage` refuses it with 403, like `read`. The token
  form's access select gains the option (all three locales). Storage, revocation and `lastUsedAt`
  stay as they are (`lib/tokens.ts`).
- `POST /api/official-usage/report`, Bearer token, body
  `{ "providerId": "claude", "usedPercent": 41.2, "resetsAtMs": …, "observedAtMs": … }`,
  at most 1 KB.
- Decision, in order (pure logic in `lib/`, thin route):
  1. Dashboard period is monthly → **409 `period_not_weekly`**, nothing saved.
  2. The provider's cycle end differs from `resetsAtMs` by more than 15 minutes → set
     `resetOverrides[providerId]` to the weekday/hour/minute of `resetsAtMs` in the dashboard's time
     zone; response carries `cycleChanged: true`.
  3. `observedAtMs` is before the (possibly new) current cycle's start → **409 `stale_reading`**.
  4. The stored entry for the provider is at least as recent (`enteredAt >= observedAtMs`, e.g. a
     value typed on the dashboard since) → no write, `saved: false`.
  5. Otherwise write the existing `usage:official` field: `raw` = the percentage rounded to one
     decimal, `enteredAt` = `observedAtMs` (the dashboard shows when the figure was true, not when
     it was uploaded), `cycleStartMs` = the current cycle's start. Threshold alerts run as for a
     typed value (`checkOfficialUsageAlerts`).
- Responses: 200 `{ ok, saved, cycleChanged, reset }` · 400 bad payload · 401 missing/invalid token ·
  403 wrong scope · 409 as above · 413/415/503 via `lib/api.ts` helpers · `demo_read_only` in demo
  mode. Documented in `docs/api.md`; `lib/redis-keys.ts` notes the new settings field.

## Part 3 — macOS app (sources, upload, UI)

### Claude source

The user's status line script writes a snapshot that the app reads:

```bash
# usageratio: the menu bar app reads the Claude subscription limits from here
if [ -n "$WEEK" ]; then
  mkdir -p ~/.usageratio
  echo "$input" | jq -c '{rate_limits, observed_at: now}' > ~/.usageratio/claude-limits.json.tmp \
    && mv ~/.usageratio/claude-limits.json.tmp ~/.usageratio/claude-limits.json
fi
```

It writes only when a weekly figure is present (a session without limits never overwrites it), and
atomically. The snippet goes into `clients/macos/README.md`; editing the user's own
`~/.claude/statusline.sh` is a separate step, done only with the user's approval.

### Codex source

The newest `~/.codex/sessions/**/rollout-*.jsonl`, read from the end: the last `token_count` event's
`rate_limits`. The weekly window is the one with `window_minutes ≈ 10080`; both `resets_at` and the
older `resets_in_seconds` are handled; the snapshot time is the line's `timestamp`. Reported as
provider `openai` (Codex reports under that id).

### Upload

On every five-minute poll and on ↻: read both sources; for each snapshot newer than the last one
uploaded for that provider (kept in `UserDefaults`), `POST /api/official-usage/report`; then fetch
`/api/status`, so the card's big % is the official figure with the existing "official" badge.
Parsing and the upload decision live in `UsageRatioCore`, with Swift tests.

### UI (compact card layout unchanged)

- With a local snapshot, a line under the sub-limits: `5-hour window: 23% · resets 14:30`.
- A failed upload shows its reason in a faint line: read-only token (create an *official* token),
  monthly dashboard cycle, snapshot from last week's window.
- When the server moved the cycle: a one-time note, e.g. "Claude's cycle moved to Thu 9:00".
- Under the gear, a "Sources" section: whether each file exists and how old it is; for Claude
  without a file, a "Copy status line snippet" button.
- No on/off switch: a source that exists is used. Strings in English and Hungarian (`Strings.swift`).

## Testing

- Vitest: `resetFor` and per-provider cycles (no override = today's behaviour); parsing and saving
  `resetOverrides`; every branch of the report decision (monthly, adjust within/outside the 15-minute
  tolerance, stale, older snapshot, save); the route's status codes; scopes on `/api/usage` and
  `/api/status`; message parity (`tests/messages.test.ts`).
- Swift: parsing the status line snapshot and Codex `jsonl` from fixtures (including partial and old
  formats); the "should upload" decision.
- By hand: the dashboard and the app against a local server on :3170 backed by the local Redis
  (`npm run redis:up`, `npm run dev`) — not demo mode, which refuses every write; the card rendered
  offscreen, without touching the user's menu bar or keychain.

## Delivery

- Branch `feat/official-report`, cut from `feat/menubar-scope` (PR #12) because Part 3 builds on the
  compact card; rebased onto `main` once #12 is merged.
- Two PRs: the server (Parts 1–2), useful on its own since a per-provider reset can be set by hand;
  then the macOS app (Part 3).

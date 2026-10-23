# Configuration

usageratio has two layers of configuration: the **settings panel** (stored in Redis, editable
without a redeploy) and **environment variables** (set once at deploy time, some of which only
seed the settings panel's initial values). This page covers both.

- [Settings panel](#settings-panel)
- [Environment variables](#environment-variables)

## Settings panel

Opened from the dashboard header (visible only when signed in). Saves with `PUT /api/settings`
(see [api.md](api.md)); most changes take effect immediately, with no redeploy or reinstall.

### Providers

A provider is an AI tool the machines report usage for (Claude Code, Codex/OpenAI, …); the
dashboard's picker calls them AI accounts. A toggle per detected provider controls whether it
appears on the dashboard and in that picker. At least one provider must stay visible — the last
visible one's toggle is disabled. Hiding a provider doesn't stop the server storing its reports:
re-enabling it brings its history back.

A hidden provider can also be deleted outright, together with its reports, machines and settings
(`DELETE /api/providers/[provider]`), from the **Danger zone** block at the bottom of the panel; if
it still has reports, the panel asks you to confirm a force delete and to re-enter the PIN.

### Budget and token limits

**Weekly** or **monthly** period. **Use token limits** is off by default: with it off, the
dashboard only shows measured tokens and whatever [official percentage](#reset-and-time-zone) is
typed in — no "tokens remaining" figure exists to show. With it on, each visible provider gets its
own token budget field (1 to 1,000,000,000,000 tokens), and **Show remaining tokens** additionally
controls whether the "remaining/over" figure is displayed (it doesn't affect what's measured).

**Show the cost, energy and water estimate** is off by default. Every client prices its reports at API
list prices ([the cost estimate](clients.md#the-cost-estimate)); with this on, the dashboard shows that
cost — the cost line, the groups' and machines' cost columns, an archived cycle's summary — and the
energy and water behind it. Off, the page names no cost at all. Energy and water are napkin estimates
scaled from the cost (`lib/resources.ts`): about 78 Wh per list-price dollar, after
[Simon P. Couch's coding-agent estimate](https://simonpcouch.com/blog/2026-01-20-cc-impact/) (built on
Epoch AI's GPT-4o figure, with Anthropic's price ratios between token types), and 4.2 L of water per
kWh — data-centre cooling plus electricity generation, the U.S. average in
[Li et al., "Making AI Less Thirsty"](https://arxiv.org/abs/2304.03271) (0.55 L/kWh on site +
1.17 PUE × 3.14 L/kWh off site).

### Sub-limits

A budget measured on some of a provider's models only — e.g. a separate cap for one model family
within Claude. Up to 5 per provider, each with:

| Field | Rule |
| --- | --- |
| Name | 1–40 characters |
| Models | 1–10 lower-case fragments of a model id (comma/space/semicolon separated) |
| Mode | **separate** (its own budget; its models' tokens are subtracted out of the provider's own total) or **share** (part of the provider's budget, up to a percentage of it) |
| Share % (share mode) | 1–100 |
| Limit (separate mode, with token limits on) | its own token budget |

A model belongs to the **first** sub-limit (in list order) any of whose fragments appears in its
model id — e.g. a fragment `"fable"` matches `claude-fable-5-1`. Reordering the list changes which
sub-limit a model with more than one matching fragment falls into.

### Reset and time zone

For a weekly budget, the day of the week the cycle restarts; for monthly, the day of the month
(1–31) — a value past the end of a shorter month falls back to that month's last day. Both a
weekly and a monthly choice are always kept, so switching the period back restores the previous
one. The reset time (`HH:MM`) and time zone are also set here. The time zone is a searchable field
whose suggestions come from the browser's own `Intl.supportedValuesOf("timeZone")`, the browser's
detected zone first (with a shortcut to use it); a zone the browser does not know cannot be saved.

**After a reset**: per provider, how it resets a user's usage early — *the weekly reset stays* (Claude: the
usage drops, but the cycle still ends when it would have) or *the reset becomes the new weekly reset* (Codex:
a fresh cycle starts at the reset). The defaults: `claude` and `anthropic` keep, `openai` restarts, anything
else keeps; see [Usage resets](#usage-resets). A provider's own reset moved by a recorded reset is marked
*Set by a recorded reset*, the way one the menu bar app moved is; editing it drops the mark.

**Official percentage**: a machine's own measurement doesn't always exactly match a provider's own
official usage figure, but their proportions hold. Typing (or dragging the slider to) a percentage
in the selected account's official-percentage field restates every group's and machine's share as
`(its measured tokens / all measured tokens) × official percentage`; with token limits on, the
token counts themselves are restated the same way. The value is stored server-side (not per
browser), tagged to the stretch of the cycle it was entered in — the cycle, or the part of it since its
latest [usage reset](#usage-resets) — and clears itself automatically once that ends. Sub-limits get
their own, smaller official-percentage field, always a percentage of the sub-limit's own budget.

### Groups

Create, recolor, rename, or delete groups. Each group has a hex color and a **counts toward** picker: which visible
accounts that group's usage counts against (unchecking an account excludes that group's reports
from that account's totals — the reports stay stored). A `groupId` a machine reports that isn't on
the list yet is created automatically, colored from a small set of curated, contrast-checked
presets (falling back to a random hue once those are all in use). Renaming a group onto an
existing id offers to merge the two: their reports are combined into one set, and the panel warns
when a machine reported into both. A group without reports is removed with a plain save; deleting
one with reports takes a force delete with the PIN re-entered. A machine still configured with a
deleted or renamed group id recreates that group on its next report.

### Machines management

Lists every known machine once (its group, the providers it reports for, and when it last
reported), with inline rename and delete. The index keeps one entry per provider and machine, so a
rename or delete runs on each of the machine's providers in turn: a rename onto an id that one of
them already uses is refused before anything changes, and if a request fails half way the panel
says which providers were done and which were not. A **remove inactive machines** action appears
once any machine has gone silent for more than 35 days, and clears them from the list in one
action (their stored reports are unaffected — this only removes the machine from the index; see
[data-model.md](data-model.md)).

### Alerts

An optional webhook message the first time a provider's usage in the current cycle crosses one of
up to 20 percentage thresholds (50, 80 and 100% by default). A threshold is added by typing a whole
percentage (1–100) and pressing **Add**; the list stays sorted, a repeated value is dropped, and
each one has its own remove button.
Each threshold fires at most once per provider per cycle — or per stretch of it: once a
[usage reset](#usage-resets) has been recorded, the thresholds can fire again for the usage since.
Fields:
webhook URL (must be `https`, and can't point at a private/loopback/link-local address — the same
allow-list a self-hosted deployment's own network is protected by, see
[security.md](security.md)), message format (**generic** JSON, **Slack**, or **Discord**),
whether hidden providers alert too, and the language the message text is written in (independent
of the dashboard's own display language). A **send test** button posts a sample message
immediately. With token limits on, a threshold is judged against measured tokens; with them off,
against the typed official percentage — whichever one the dashboard is actually using for that
provider.

### API token and per-machine tokens

The bottom of the panel holds a copy of `USAGE_API_TOKEN` for the Setup page's *Copy token* button
(add/replace it here; replacing requires a confirmation), and a separate list of **per-machine
tokens** that can be issued and revoked individually as an alternative to the shared master token
(see [security.md](security.md#per-machine-tokens)). A new token gets a label and either works for
any machine or is bound to one picked from the machines that have already reported. An **Audit** button shows who added, changed,
or revealed the stored master-token copy, and from where. See [security.md](security.md) for the
underlying encryption and audit mechanics.

### Language

A locale picker (English, Hungarian, German) that changes the whole dashboard's display language.
This is separate from the alerts' own message language above — changing one doesn't affect the
other.

### The official percentage, charts, and history

The main dashboard percentage, the pace estimate, and the per-group/per-machine breakdown are all
computed from whichever of "measured tokens" or "official percentage" is authoritative for the
current settings (see [Budget and token limits](#budget-and-token-limits) and
[Reset and time zone](#reset-and-time-zone) above). Two charts sample the cycle on an even grid —
hourly for a weekly cycle, every 4 hours for a monthly one, always ending at the live total: one
group-colored line per group (plus a total) for budget burn-down, and a per-model line (picked
from a dropdown) for token usage by model. Dated model builds (`claude-sonnet-4-5-20250929`) are
merged into their undated name (`claude-sonnet-4-5`) on the chart. Cycles older than what's kept
as raw events are shown from an automatically archived summary — see
[data-model.md](data-model.md#history-archived-cycles). `GET /api/export` (linked from the
dashboard) downloads the current or previous cycle's raw reports as CSV or JSON, alongside the
archived history — see [api.md](api.md) for the exact format.

### Usage resets

Some providers occasionally reset a user's usage before the cycle ends. Under the official-percentage
field, **There was a reset…** records one: when it happened (the reset time zone's wall clock, from the
cycle's start up to now), and the percentage used right before it — prefilled from the stored official
figure when that was read before the moment, left empty when unknown. What it does depends on the
provider's reset type ([Reset and time zone](#reset-and-time-zone)):

- **The weekly reset stays** (Claude's way): the reset splits the cycle into segments. The meter, the
  pace, the groups, the machines, the sub-limits and the cost estimate count the current segment only,
  and the meter's day ruler covers it. A line under the main figure lists each reset with the figure
  before it, and the cycle's total: those figures and the current one added up (an unknown one is a dash,
  left out). The usage chart still shows the whole cycle, with a marker at each reset, where every line
  starts again from 0. Under an official figure, each finished segment is scaled by its own before-figure;
  one without it is an estimate at the current rate, drawn faded.
- **The reset becomes the new weekly reset** (Codex's way): the cycle ends at the reset and a fresh one
  starts there; the provider's own reset moves to that moment. The page shows the new cycle, and the one
  cut short moves to the previous cycles.

The list under the button holds this cycle's resets, each editable and deletable. The menu bar app's
readings also record resets on their own ([`POST /api/official-usage/report`](api.md#post-apiofficial-usagereport));
such a row is marked *detected by the menu bar app*, and offers **Wrong – revert** instead of delete:
that puts the figure from before it back, and stops detection for the rest of the cycle. Only the
current cycle's resets can be recorded or changed.

Dragging or typing the official figure down never records a reset by itself. When an edit takes it below
10%, at least 5 points under where it stood, a **Was there a reset?** question appears under the field once
the new figure is saved: **Yes** records a reset now, with the earlier figure as the one before it and the
new one as the figure since; **No** leaves the edit a plain correction. It never appears on a finished
cycle's correction.

## Environment variables

Set once at deploy time. Every variable here is also listed, with a short comment, in
[`.env.example`](../.env.example).

### Required

| Variable | Meaning |
| --- | --- |
| `USAGE_API_TOKEN` | The Bearer token clients send. At least 16 characters — generate with `openssl rand -hex 32`. |
| `DASHBOARD_PIN` | The dashboard PIN or passphrase: 5–64 characters. Digits only gives a numeric keypad; on a public URL, prefer a passphrase of 12+ characters. Changing it logs every browser out. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Upstash Redis over its REST API. Injected automatically once the Upstash integration is connected on Vercel — set by hand only for self-hosting. `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are accepted as well, but `KV_REST_API_*` wins if both are set (`lib/redis.ts`). |

### Optional: the setup page's "copy the API token" button

| Variable | Default | Meaning |
| --- | --- | --- |
| `TOKEN_ENCRYPTION_KEY` | unset | AES-256-GCM key (32 bytes, 64 hex digits or base64: `openssl rand -base64 32`) for the copy of `USAGE_API_TOKEN` saved from the settings panel. Without it, the copy can't be stored. |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | unset | The old key, during rotation — see [security.md](security.md#the-token-vault-and-key-rotation). |

### Optional: login

| Variable | Default | Meaning |
| --- | --- | --- |
| `SESSION_IDLE_DAYS` | 7 | A session unused this long logs out. |
| `SESSION_MAX_DAYS` | 30 | Hard ceiling from login, regardless of activity. |
| `DASHBOARD_PIN_AUTOSUBMIT` | off | `1` submits a numeric PIN on its last digit (reveals the PIN's length to an onlooker — opt-in only). |

### Optional overrides of `lib/config.ts` (initial values only)

| Variable | Default | Meaning |
| --- | --- | --- |
| `RESET_TIMEZONE` | `UTC` | Only the *initial* value; the settings panel decides afterward. |
| `TOKEN_MODE` | `snapshot` | `snapshot` (ccusage clients) \| `delta` \| `counter` — see [data-model.md](data-model.md#snapshot-semantics-and-checkpoints). |
| `WEEKLY_LIMIT` | 500000 | Seeds only: the initial limit of every newly discovered provider. Provider-specific budgets are then edited on the dashboard. |
| `RESET_WEEKDAY` | 1 (Monday) | 0 = Sunday … 6 = Saturday. |
| `RESET_TIME` | `00:00` | `HH:MM`, 24h. |

### Security headers

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECURITY_CSP` | `enforce` | `enforce` \| `report` (log violations only) \| `off`. Development is always report-only. |
| `SECURITY_HSTS` | on | `0` turns off HSTS entirely. |
| `SECURITY_HSTS_PRELOAD` | off | `1` adds `preload` (only once the domain is submitted to the preload list). |

### Operations

| Variable | Default | Meaning |
| --- | --- | --- |
| `CRON_SECRET` | unset | Bearer token Vercel Cron uses to call `GET /api/cron/housekeeping` daily (at least 16 characters). Without it, the housekeeping endpoint refuses to run. |
| `ERROR_WEBHOOK_URL` | unset | Server errors are POSTed here as JSON (`message`, `digest`, `path`, request id). |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `LOG_FORMAT` | `json` in production | `json` \| `pretty`. |
| `TRUST_PROXY` | on | Trust `X-Forwarded-For` for rate limits (always on Vercel); set `0` on a self-hosted server not behind a proxy. |
| `COOKIE_SECURE` | auto-detected | Force the `Secure` cookie flag (auto-detected on Vercel / HTTPS). |
| `AUDIT_SALT` | derived from `TOKEN_ENCRYPTION_KEY` | Salt for the hashed IPs in the API-token audit trail. |
| `AUDIT_RAW_IP` | off | `1` keeps the full IP address in the audit trail instead of a hash + network prefix. |
| `AUDIT_RETENTION_DAYS` | 365 | Audit entries older than this are removed by housekeeping. |

### Local development without Docker

| Variable | Default | Meaning |
| --- | --- | --- |
| `USAGE_STORE` | unset | `memory` uses an in-memory Redis (`lib/redis-memory.ts`) instead of `KV_REST_API_*`; everything is lost when the server stops. |
| `DEMO_MODE` | unset | `1`: `npm run dev:demo` — the in-memory store seeded with synthetic data, no PIN, every write answers `demo_read_only`. Never set this on a real deployment. |
| `DEMO_FIXED_TIME` | unset | Freezes "now" in demo mode (screenshots, e2e), e.g. `2026-09-23T12:00:00Z`. |

See [demo-and-development.md](demo-and-development.md) for how demo mode and the seed script use
these.

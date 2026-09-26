# Technical reference

The deep-dive behind the [README](../README.md): deployment, the client protocol, every setting,
the API, the Redis data model, and security. If you just want to run usageratio, the README is
enough — come back here when you need the details.

- [What's where](#whats-where)
- [Deploying to Vercel](#deploying-to-vercel)
- [Clients](#clients)
- [Snapshots and provider detection](#snapshots-and-provider-detection)
- [Settings](#settings)
- [API](#api)
- [Redis data model](#redis-data-model)
- [Security](#security)

## What's where

| File | Role |
| --- | --- |
| `lib/config.ts` | Deployment settings (time zone, token interpretation, retention) and the budget's **initial values** |
| `lib/settings.ts` | Optional per-provider token budgets, shared reset, visible accounts, groups, colors, and which accounts a group counts toward (validation, migration) |
| `lib/providers.ts` | Normalizing provider ids and their display names |
| `app/api/settings/route.ts` | GET/PUT endpoint for the Settings panel, behind the PIN session |
| `app/api/usage/route.ts` | GET cycle metadata and POST ingest: Bearer token, validation, storage |
| `lib/usage-store.ts` | Redis data model (write, read) |
| `lib/cycle.ts` | Weekly and monthly cycle calculation with time zone and DST |
| `lib/aggregate.ts`, `lib/dashboard.ts`, `lib/quota.ts` | Aggregation by group and machine, pace estimate |
| `lib/sub-limits.ts` | Sub-limits (e.g. Claude/Fable): model → sub-limit, splitting reports, measured status |
| `lib/timeline.ts`, `lib/models.ts`, `lib/chart.ts` | The charts' time series (per group and per model), model names, axes |
| `lib/ground-truth.ts` | "Official percentage": converting the selected provider's breakdown (runs in the browser) |
| `lib/auth.ts`, `app/actions.ts` | PIN check, session, attempt limiting |
| `app/page.tsx`, `components/` | PIN screen and dashboard (Tailwind, dark theme) |
| `app/setup/page.tsx`, `components/setup-view.tsx` | The **Setup** page: system and mode, ZIP download, copyable files |
| `app/api/setup/route.ts`, `lib/setup.ts`, `lib/setup-package.ts`, `lib/zip.ts` | The setup package: file list, generated config and README, ZIP |
| `app/api/api-token/`, `lib/token-vault.ts`, `lib/secret-box.ts`, `lib/api-token.ts` | The stored API token: AES-256-GCM encryption, copying it from the Setup page, audit log |
| `clients/setup/` | The package installers: `install.sh` (macOS), `install.ps1` and `install.cmd` (Windows) |
| `clients/auto/` | Silent Bash/PowerShell reporters and the Windows Task Scheduler installer |
| `clients/manual/` | Manually-run Bash/PowerShell reporters with console feedback |
| `clients/shared/` | The core reporting logic shared by both modes, and the `ccusage-providers.cjs` parser |
| `tests/` | Unit tests for the pure logic (`npm test`) |

## Deploying to Vercel

1. **Push the code to GitHub**, then on Vercel *Add New → Project → Import* (it recognizes Next.js
   automatically). With the CLI: `vercel link`, then `vercel --prod`. A push to `main` deploys to
   production.
   (If the project was created from an empty repo, its preset stays "Other" and the build fails
   referencing the missing `public` folder — that's why `vercel.json` pins `"framework": "nextjs"`.)
2. **Connect Redis:** in the project, *Storage → Create Database → Upstash → Redis*, and attach it to
   the project for all three environments. This sets the `KV_REST_API_URL` and `KV_REST_API_TOKEN`
   variables automatically. (CLI: `vercel integration add upstash`, pick the Redis product in the
   wizard.) Choose **Frankfurt (eu-central-1)** as the region: `vercel.json` places the functions in
   the `fra1` region, keeping Redis a few milliseconds away. The free tier is plenty: an hourly report
   from 3 machines for a week is about 500 small records.
3. **Two secrets** under *Settings → Environment Variables* (Production, and Preview if needed):

   | Variable | Value |
   | --- | --- |
   | `USAGE_API_TOKEN` | the clients' Bearer token, at least 16 characters: `openssl rand -hex 32` |
   | `DASHBOARD_PIN` | exactly 5 digits |
   | `TOKEN_ENCRYPTION_KEY` | optional: for the Setup page's *Copy token* button, 32 bytes: `openssl rand -base64 32` |

4. **Domain:** *Settings → Domains → Add* → your domain (e.g. `usageratio.example.com`), then at your
   DNS provider add the record Vercel shows you:

   | Type | Name | Target | Proxy |
   | --- | --- | --- | --- |
   | `CNAME` | `usageratio` | *(the value Vercel gives you)* | **DNS only** (grey cloud, if using Cloudflare) |

   If you're on Cloudflare, leave the Cloudflare proxy off: enabled, Vercel can't issue a certificate,
   and every visitor would arrive from Cloudflare's IP address, which would make the per-IP PIN limit
   meaningless.
5. **Redeploy** (environment variables only take effect on a new deployment), then a smoke test:

   ```bash
   curl -i -X POST https://usageratio.example.com/api/usage \
     -H "Authorization: Bearer $USAGE_API_TOKEN" -H "Content-Type: application/json" \
     -d "{\"machineId\":\"probe\",\"groupId\":\"Test\",\"providers\":{\"deepseek\":1,\"claude\":2},\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
   ```

   `201` is the expected response. The test provider/group keys show up in the Upstash Data Browser:
   `usage:events:deepseek:Test` and `usage:events:claude:Test`. Their index entries live in the
   `usage:groups`, `usage:providers` and `usage:machines` hashes.

**Deployment Protection:** the default (*Standard Protection*) puts the generated addresses
(`usageratio-…-yourteam.vercel.app`) behind Vercel login: clients get `401 Protected deployment`
there. Production domains (your custom domain, and `usageratio.vercel.app`) are public, so always
point clients at one of those. Don't extend protection to the production domain — the Bearer token
and the PIN protect it instead.

## Clients

Both modes use the same collection logic under `clients/shared/`. The automatic entry points don't
write to the console during normal runs; the manual entry points print a success or error message.

### Installing from the dashboard

The header's **Setup** button leads to the `/setup` page (also behind the PIN). There you pick the
machine's system (macOS or Windows), the run mode (automatic or manual), the group (existing ones are
one click away), and, if needed, the machine's id. From there you have two routes to the same result:

- **Download as ZIP:** a ready-made package with the installer. On macOS,
  `bash ~/Downloads/usageratio-macos-auto/install.sh`; on Windows, unpack and double-click
  `install.cmd`.
- **Copy and create:** the same files as copyable blocks, with their names and final locations. It
  doesn't matter where the folder lives, as long as every file ends up in one folder. Saving from the
  clipboard: `pbpaste > filename`, or on Windows the `paste filename` command the first block on the
  page defines.

When entering the token, the **Copy token** button puts the token entered in the Settings panel on
the clipboard (see below: [API token](#api-token-for-the-setup-pages-copy-button)). The token isn't
part of the page: the button fetches it from the server on click, and that fetch is recorded in the
audit log.

The installer (`clients/setup/`):

1. figures out which mode it's installing from the adjacent `report-usage-auto.*` or
   `report-usage-manual.*` file;
2. asks for the `USAGE_API_TOKEN` with hidden input, and checks it with a `GET /api/usage` request
   (asks again on `401`; runs without asking when the `USAGERATIO_API_TOKEN` environment variable is
   set). **The package doesn't contain a token.** On reinstall, pressing Enter keeps the already saved
   token;
3. copies the files to their usual locations (`~/.usageratio/{auto,manual,shared}`, the config at
   `~/.config/usageratio/config` with mode 600; on Windows, `%USERPROFILE%\.usageratio`). The
   downloaded folder can therefore live anywhere and be deleted afterward — the macOS cron job
   couldn't even read the Downloads or Documents folder;
4. keeps the machine id already in use on the machine when the field is left blank, and on first
   install writes the computer's name, so a reinstall doesn't split the machine's history in two;
5. sends a test report, then sets up the cron job or the `sync-tokens` alias (`~/.zshrc`), or on
   Windows the scheduled task (asking once for administrator rights) or the desktop "Sync tokens"
   shortcut.

If `node` isn't in the usual place (nvm, volta), the macOS installer also writes a `PATH=` line into
the config so cron can find it too.

### Flags and exit codes

| Flag | What it's for |
| --- | --- |
| `--dry-run` / `-DryRun` | prints the JSON payload, sends nothing |
| `--providers '{"claude":22000}'` / `-Providers '{"claude":22000}'` | a manual multi-provider snapshot, for testing |
| `--tokens claude=N` / `-Tokens claude=N` | one provider's total: `{"claude":N}` |

Exit codes: `0` sent · `1` send failed · `2` bad settings · `3` data read/JSON error.

Package-free, command-line install from the repo:

- Automatic install: [`setup-auto.md`](setup-auto.md)
- Manual install: [`setup-manual.md`](setup-manual.md)

## Snapshots and provider detection

The client sums the `ccusage daily` result, filtered to the current cycle's days, per provider. This
is a running total since the start of the cycle, so by default the server runs in `snapshot` mode,
taking the latest submission of each machine/provider series. The raw events are kept, so the mode
can be switched if needed:

| `TOKEN_MODE` | The client sends this | The dashboard computes it like this |
| --- | --- | --- |
| `delta` | tokens used since the previous submission | sums the cycle's submissions |
| `snapshot` (default) | the machine/provider's running total for the current cycle | takes the latest value of the cycle, per series |
| `counter` | a continuously increasing counter ("odometer") | sums the increments between submissions; a drop is treated as a restart |

Besides the providers, the client also sends the **per-model breakdown** (`models`, see
[API](#api)): from `ccusage`'s daily `modelBreakdowns` data, up to 20 models per provider and 60 in
total, largest first. If the breakdown can't be built for some reason, the report still goes out
without it. Older clients report without a breakdown: their tokens count toward the provider total
but not toward the model chart. In snapshot mode, an updated client's first report brings the running
model totals since the start of the cycle, so the chart is complete from that point on.

The client also sends the **daily breakdown** (`days`): the same snapshot split into calendar days (in
the cycle's time zone), per model too. For every day that has already closed, the server writes a
**day-close point** — the machine's running total up to that point — to the machine's series, at local
midnight. This way, on the charts, the days before a machine's first report (for a machine installed
mid-cycle) and the days skipped in manual mode also show up on their own day, instead of jumping up at
the moment of the next report. These tokens were already counted in the aggregate, since a snapshot
counts from the start of the cycle anyway. A day-close point isn't a report: the machine table's report
counter and the "behind" indicator ignore it, and it's only read in `snapshot` mode.

The client also breaks down Claude Code usage **by hour**: before `ccusage daily`, it runs
`ccusage blocks --session-length 1`, which gives whole-hour blocks. A day's hours are only uploaded
once the day's tokens are finalized (today may get fewer, because of the hour still in progress); if
not (for example another agent also used a Claude model that day), the day goes up as a whole. In that
case the server also writes a day-close point for every closed hour, without a model breakdown (the
blocks don't have per-model numbers). On the reset day, the hours before the cycle's start are left out
of the Claude total, so the reset day's morning doesn't count toward two cycles; that day's model
breakdown shrinks proportionally. Everything else (Codex and other agents) stays daily resolution:
`blocks` only sees Claude Code, so there the recovered range grows in daily steps. Whatever is left
unreported from a cycle before the reset (in manual mode, the gap between the last run and the reset)
isn't brought back by the next cycle's reports: those only contain the new cycle's days.

The provider key is a lowercase id (`a-z`, digits, dot, hyphen, underscore). For known names, the UI
gives a nice label (`openai` → OpenAI, `deepseek` → DeepSeek); unknown ids also work. Since
`ccusage daily` breaks down by calendar day, the cycle's first day can only be filtered by day: Claude
Code's hourly breakdown above counts exactly from the moment of the reset, while for other agents the
whole reset day falls into the new cycle. For full accuracy there, keep the reset time at midnight
(the default).

## Settings

### On the dashboard: AI accounts, budget, reset, groups

The header's **Settings** button (visible only when signed in) edits the settings stored in Redis, with
no install needed, taking effect immediately:

| Setting | Values |
| --- | --- |
| AI accounts | which detected provider/account shows on the dashboard and in the **AI account** picker |
| Budget type | **Weekly** or **Monthly** cycle |
| Use token budget | off by default: the dashboard computes only from measured tokens and the entered official percentage |
| Budget amount | with token budgets on, a separate budget per detected provider/account |
| Sub-limits | separately measured budgets per account, e.g. Fable within Claude: name, models, **separate budget** or **part of the budget** (up to X%) |
| Show remaining tokens | with token budgets on: off means nowhere shows how many tokens are left, nor by how much the budget was exceeded |
| Reset | for a weekly budget, the day of the week; for monthly, the day of the month (1–31), and the time (`HH:MM`) |
| Groups | name (what the machine sends as `groupId`), color (`#rrggbb`: color picker or typed hex code), and which AI accounts it counts toward |

- **AI accounts:** a disabled account disappears from the dashboard and the picker (for example if you
  don't want to see Codex). The server keeps storing its reports, so re-enabling it brings its history
  back too. At least one account must be visible.
- **Counts toward:** per group, you can set which AI account's consumption it counts toward. For
  example, if the `Work` group only has OpenAI (Codex) enabled, `Work`'s machines and tokens won't show
  on the Claude or DeepSeek dashboard, and the official percentage is split only among the other
  groups. The reports stay stored here too. A new group and a new provider count toward everything by
  default.
- **Sub-limits:** a separately measured budget within an account, shown on the dashboard under the main
  slider with its own, smaller slider (see below). Which models belong to it is defined by a fragment of
  the model id (`fable` → `claude-fable-5-1`); a model goes into the first sub-limit whose fragment
  appears in its id. Up to 5 sub-limits per account.
  - **Separate budget:** independent of the account's budget; its models' tokens **don't** count toward
    the account's budget, so the main percentage, the groups, the machines and the "Usage over time"
    chart are meant without them (they still show up on the "Models" chart). With token budgets on, it
    has its own token budget.
  - **Part of the budget:** its models count toward the account's budget, and can use at most the given
    share of it (with token budgets on: that percentage of the account's budget becomes its own budget).
- If the month has no such day (the 31st, or the 30th in February), the reset falls on the **last day
  of the month**.
- The **AI account** picker switches the whole dashboard instantly, with no new request. The last
  selected account and the official percentage entered per provider are each kept separately in the
  browser.
- The color is a hex code, not a Tailwind class: Tailwind generates the CSS at build time, so a class
  name coming from Redis wouldn't have a style. Components apply the color as an inline style.
- **Unknown group:** if a machine sends a `groupId` that isn't on the list, the system picks it up
  automatically, with a random color (drawn from a band readable on the dark background). The color can
  be changed afterward.
- **Token budget:** off by default, because providers' token-measured budgets aren't known — only the
  percentage shown on their own display. With it off, the dashboard doesn't compute anything token-budget
  related: there's no "remaining" figure, and the budget's status, the pace, and the groups' and
  machines' share of the budget come only from the entered official percentage (see below). With it on,
  the previous behavior returns, using the entered budgets. Budgets stay stored while it's off, so
  they're there again when turned back on.
- **Remaining tokens:** the toggle only shows with token budgets on, and only affects the display. Off,
  the "Remaining" / "Over" block disappears, and once the budget runs out the text tells you when the
  next reset is, instead of the token counts. The percentage, the amount used, and the reset time are
  unaffected.
- **Delete:** only a group with no stored reports can be deleted. Otherwise its reports would disappear
  from the dashboard, and the next submission would bring the group back with a new color.

### API token for the setup page's copy button

The bottom of the Settings panel lets you enter a copy of `USAGE_API_TOKEN`. The server encrypts it
with **AES-256-GCM** (key: `TOKEN_ENCRYPTION_KEY`, a fresh IV per value, AAD bound to its purpose), and
only writes the encrypted form to Redis; the key only exists in the server's environment. The panel
never shows the token itself, only its status: whether it's stored, when it was saved, and **whether
it matches the server's `USAGE_API_TOKEN`** (if not, the installer would reject it anyway).

- **Adding** saves immediately. **Changing** it shows a confirmation dialog first, and the *Yes* button
  can only be pressed after 5 seconds.
- The **Audit** button shows, in a scrollable list, when, from which browser (browser, OS, User-Agent,
  IP address, the session's short id), the token was added, changed, or fetched. The last 500 events
  are kept. A fetch is logged before, not after, the server returns the token.
- Clients still authenticate with the `USAGE_API_TOKEN` environment variable: the stored copy only
  serves copying it, and plays no part in authentication.
- If `TOKEN_ENCRYPTION_KEY` is missing, the section says so and won't let you save. If it changes, the
  stored copy can't be decrypted anymore: enter it again.

The dashboard aggregates **only** reports received since the most recent reset. The reset needs no
scheduled job and deletes nothing: the cycle's start is simply the lower bound of the query. If you
change the reset or the budget type, existing data is shown according to the new bounds.

### "Official percentage": the selected provider's official value

A machine's own measurement doesn't always exactly match the provider's official number, but their
ratios are reliable. Based on the value typed (or set with the slider) into the selected account's
**official percentage** field at the top of the dashboard, the browser instantly recalculates:

```
a machine's share of the budget = (that machine's measured tokens / all measured tokens) × official percentage
```

Example: the machines measured 40,000 tokens in total, 10,000 of them the Mac. If the official value is
20%, the Mac used 5% of the total budget. In that case the main bar and the pace estimate are computed
from the official value, while the groups' and machines' "Of budget" column split it using the formula
above.

- **Without a token budget** (the default), the token counts stay the machines' measured values, since
  there's no budget to convert them onto. With an **empty field**, the dashboard doesn't know the
  budget's status: it only shows the measured tokens and the ratios, the main bar is empty, and there's
  no "Of budget" column either.
- **With a token budget**, the token counts also line up with the official value; the panel shows both
  the measured value and the multiplier. With an **empty field**, everything is computed from the
  machines' own measurements and the configured budget.

The value is stored on the server (Redis), in its own field per provider, so it's the same from any
browser; the dashboard's automatic refresh (every 5 minutes, and when the tab becomes visible again)
brings the latest entry into other browsers too. It clears itself automatically at the end of the
cycle. The dashboard projects the pace from the moment it was entered.

**Sub-limits:** an account's sub-limits get a smaller field and slider below the main one, along with
their status (icon, amount used, pace). The percentage is always a percentage of the **sub-limit's own
budget**, the way the provider's own display shows it. If nothing is entered:

- **part of the budget** computes from the account's official value, by the measured ratio:

  ```
  sub-limit status = (account's official % × sub-limit's measured tokens / account's measured tokens) / allowed share
  ```

  Example: Claude is at 40%, 86% of the measured tokens are Opus, and Opus can use at most 40%: it gets
  34.5% of the total budget, meaning 86% of its own budget is used.
- **separate budget** can only be estimated with token budgets on (its measured tokens against its own
  budget).
- Without a per-model breakdown (older clients), the sub-limit's measured share is unknown: only the
  entered value counts then.

### Charts

Both charts' horizontal axis is the whole cycle (aligned with the main bar), and the lines run up to
the present moment. The server samples the cycle on an even grid (hourly for a weekly cycle, every 4
hours for a monthly one, plus the current moment), and at every grid point hands over the tokens
accumulated since the start of the cycle; the last point is exactly the sum shown in the tables.

- **Usage over time** (below the big percentage): one line per group, in the group's color, plus a
  white dashed line for the total. The vertical axis is the percentage of the budget: every measured
  token is worth the same amount, `official percentage / all measured tokens` (with a token budget and
  with an empty field, `1 / budget`), so the dashed line ends at the big number, and the groups split it
  in proportion to their measured tokens. Without a token budget and an official percentage there's
  nothing to measure against: the chart's place shows a short explanation instead. An account's
  **sub-limits** (if their status is known, and machines measured tokens toward them) get a lighter-shade
  line, as a percentage of **their own budget**: same rule, the line ends at the value shown on the
  sub-limit's slider. With more than one sub-limit, each gets a shade lighter.
- **Models** (at the bottom of the page): the measured tokens of the model picked with the toggle, per
  group, in the groups' colors; no other model shows, so with two groups there are two lines. The picker
  lists the selected AI account's models, starting with the most used; dated builds
  (`claude-sonnet-4-5-20250929`) are merged into one line with the undated name.

With the mouse, or (with the chart focused) the arrow keys, you can read out every value at a given
point in time; the "As a table" dropdown gives the same thing broken down by day, as text.

### In code: `lib/config.ts`

Whatever isn't on the panel lives at the top of `lib/config.ts`; an environment variable overrides the
value there (on an invalid value the constant is kept, and a warning goes to the log).

| Constant | Env | Default | Meaning |
| --- | --- | --- | --- |
| `DEFAULT_USE_TOKEN_LIMITS` | – | `false` | the **initial value** of the "Use token budget" toggle |
| `DEFAULT_LIMIT` | `WEEKLY_LIMIT` | `500000` | the **initial value** of every new provider's token budget (only matters with token budgets on) |
| `DEFAULT_RESET.weekday` | `RESET_WEEKDAY` | `1` | the **initial value** of the reset day: 0 = Sunday … 6 = Saturday |
| `DEFAULT_RESET.hour/minute` | `RESET_TIME` | `00:00` | the **initial value** of the reset time (`HH:MM`) |
| `DEFAULT_RESET.timeZone` | `RESET_TIMEZONE` | `Europe/Budapest` | the reset is understood in this time zone, DST included |
| `TOKEN_MODE` | `TOKEN_MODE` | `snapshot` | see [Snapshots and provider detection](#snapshots-and-provider-detection) |
| `REPORT_INTERVAL_MINUTES` | – | `60` | used to compute the "Active / Behind / Inactive" indicator |
| `RETENTION_DAYS` | – | `70` | raw reports older than this are deleted (must cover two monthly cycles) |
| `INACTIVE_MACHINE_DAYS` | – | `35` | a machine silent longer than this drops off the dashboard |

The **initial value** applies until you save on the Settings panel: after that, the value stored in
Redis is what counts, not the constant or the environment variable anymore. The time zone isn't on the
panel; it always comes from here.

## API

`GET /api/usage`, with the same Bearer token, returns the server's current cycle, including
`sinceDate`, `timeZone`, and the known `providers` list. Clients pass the first two to the
`ccusage daily` command; in an empty new cycle they build a zero-valued heartbeat from the provider
list.

`POST /api/usage`, `Authorization: Bearer <USAGE_API_TOKEN>`, body:

```json
{
  "machineId": "mac-home",
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
  }
}
```

`machineId` and `groupId` are 1–64 characters: letters (accented too), digits, spaces, `.`, `_`, `-`.
`providers` has 1–20 entries; every value is a nonnegative, safe-integer JSON number. `timestamp` is
ISO 8601 with a zone marker. `models` is optional: per provider, tokens split by model (up to 20 models
per provider, 60 in total; the id format is up to the provider). Only a provider present in `providers`
can be broken down, and the models' sum can't exceed the provider's value (it can be smaller: not every
token can be attributed to a model). `days` is also optional: the same snapshot split into calendar
days (`YYYY-MM-DD` keys in the cycle's time zone, up to 32 days), each day with `providers` and optional
`models`, under the same rules. A day can only contain a provider present in `providers`, and a
provider's days together can't exceed its total value. A day's optional `hours` field gives that day's
hours per provider (key: the hour's start, in UTC, on the hour, and it must fall within the day; up to
25 hours per day). A provider's hours can't exceed its day's value. The server only stores day-close
points that fall within the report's own cycle. The response's `groupRegistered` and
`providersRegistered` fields flag new index entries.

| Code | Meaning |
| --- | --- |
| `201` | stored |
| `200` | this exact report already exists (`"duplicate": true`): resending doesn't double-count |
| `400` | invalid JSON or field (`details` lists all of them) |
| `401` | missing or wrong token |
| `413` | body larger than 64 KB |
| `500` | the server has no (long enough) `USAGE_API_TOKEN` |
| `503` | Redis isn't connected or unreachable: the client retries next hour |

### `/api/settings`: the Settings panel's endpoint

Authenticates with the dashboard's session cookie (not the Bearer token): without a valid PIN session,
both methods return `401` and touch no data.

`GET` returns the settings and the groups (`hasReports`: whether it has stored reports). `PUT` body:

```json
{
  "period": "weekly",
  "useTokenLimits": false,
  "limits": { "claude": 500000, "deepseek": 750000, "openai": 1000000 },
  "reset": { "weekday": 1, "monthDay": 1, "hour": 0, "minute": 0 },
  "showRemaining": true,
  "hiddenProviders": ["openai"],
  "excludedProviders": { "Work": ["claude", "deepseek"] },
  "subLimits": {
    "claude": [
      { "id": "fable", "name": "Fable", "models": ["fable"], "mode": "separate", "sharePercent": 50, "limit": 400000 }
    ]
  },
  "groups": [{ "id": "Work", "color": "#3987e5" }],
  "removedGroups": ["Old"]
}
```

`hiddenProviders` is the list of providers not shown on the dashboard; if every known provider is in
it, the response is `400`. `excludedProviders` lists, per group, the providers the group does **not**
count toward (a group not listed counts toward everything). `subLimits` is, per account, the list of
sub-limits: `mode` is `"separate"` (independent budget, with its own `limit`) or `"share"` (part of the
account's budget, up to `sharePercent`% of it); the unused field is stored too, so it's kept around if
the mode is switched back. `id` is unique within the account (`a-z`, `0-9`, `-`), `models` is 1–10 model
id fragments.

`limits` is a separate budget for every known provider; it's stored even with
`"useTokenLimits": false`, it just doesn't matter then. `groups` creates or recolors — **groups not
listed are left untouched** (so a group that appeared on its own in the meantime isn't wiped out by a
save). `weekday` and `monthDay` are always stored, so the previous choice is kept when the budget type
is switched back. All budget fields are required, as are `useTokenLimits`, `showRemaining`,
`hiddenProviders`, `excludedProviders`, and `subLimits` (the last three can be empty): `PUT` overwrites
the whole settings document, filling nothing in with a default. (A document stored in Redis before
these toggles existed still reads fine, though: there, a missing `showRemaining` means on, a missing
`useTokenLimits` means off, and missing account lists mean every provider is visible and counts toward
everything.)

| Code | Meaning |
| --- | --- |
| `200` | saved |
| `400` | invalid JSON or field (`details` lists all of them), or every provider would end up hidden |
| `401` | no valid session |
| `403` | foreign `Origin` (a second line of defense alongside `SameSite=Lax`) |
| `409` | a group to be deleted (`groups`) has stored reports; **nothing was saved** |
| `413` / `415` | body larger than 16 KB, or not JSON |
| `503` | Redis isn't connected or unreachable |

### `/api/api-token`: the stored token and the audit log

Authenticates with the session cookie, same as `/api/settings`; without a session, `401`, and it
touches nothing. Writes are only accepted from the same origin (`Origin`).

| Endpoint | What it does |
| --- | --- |
| `GET /api/api-token` | status: `{"status":{"state":"no_key"\|"empty"\|"unreadable"\|"stored","updatedAt","matchesServer"}}`, without the token |
| `PUT /api/api-token` | `{"token":"…"}` (16–512 ASCII characters, no spaces): saves it encrypted, logs `created`/`updated` |
| `POST /api/api-token/reveal` | `{"token":"…"}`: logs a `revealed` entry first, only then returns the token. `404` if none, `409` if it can't be decrypted |
| `GET /api/api-token/audit` | `{"entries":[{"at","action","browser","os","userAgent","ip","session"}],"currentSession"}`, most recent first |

With a missing or invalid `TOKEN_ENCRYPTION_KEY`, `PUT` and `reveal` return `500`
(`encryption_key_missing`), and `GET` returns `"state":"no_key"`.

### `/api/setup`: downloading the setup package

`GET /api/setup?os=macos|windows&mode=auto|manual&group=Work&machine=win-desktop` is the Setup page's
ZIP. Authenticates with the session cookie, like the page; without a session, `303` to the `/setup` PIN
screen. `machine` can be empty. The config inside the package points at the server's own address; in
production, always the production domain (`VERCEL_PROJECT_PRODUCTION_URL`), because clients would get
`401 Protected deployment` on the generated `*.vercel.app` addresses.

| Code | Meaning |
| --- | --- |
| `200` | `application/zip`, `Content-Disposition: attachment` |
| `303` | no valid session |
| `400` | invalid system, mode, group, or machine id |
| `503` | Redis isn't connected or unreachable |

## Redis data model

```
usage:settings                    STRING {"v":2,"period","useTokenLimits","limits":{…},"reset":{…},
                                         "hiddenProviders":[…],"excludedProviders":{groupId:[…]},
                                         "subLimits":{providerId:[{"id","name","models","mode",…}]},…}
usage:providers                   HASH providerId → first seen (ms)
usage:events:{provider}:{group}   ZSET score = report time; member = {"m","t","ts","b"}
                                  ("b": per-model breakdown, only if the client sent one)
usage:groups                      HASH groupId → {"color":"#rrggbb","ts": first seen}
usage:machines                    HASH providerId:machineId → {"g","ts","t"}
usage:api-token                   STRING {"v":1,"iv","ct","tag","updatedAt"}: AES-256-GCM, the token never in the clear
usage:api-token:audit             LIST most recent first, up to 500: {"at","a","ua","ch","pf","ip","s"}
usage:session:{hash}     STRING, 30-day expiry
usage:auth:*             attempt counters with expiry
```

There's a separate time-ordered set per provider/group pair. The account and the group are in the key,
the period in the score range (`ZRANGE … BYSCORE cycleStart +inf`). A single dashboard load builds and
serializes every provider's models, so the picker switches instantly on the client side.

The group list is deliberately a **separate hash**, not part of the `usage:settings` JSON. Machines all
report at minute 0 of the hour, so registering an unknown group has to be atomic: `HSETNX` inside the
report's transaction gives that, and doesn't touch an already-defined group. With a single JSON
document's read-modify-write cycle, reports arriving at the same time (or a save on the panel) would
overwrite each other.

**Backward compatible:** on load, a v1 `usage:settings.limit` value is projected onto the known
providers. The old `usage:events:{groupId}` keys and machine entries without a provider are read as
DeepSeek data. The earlier group-color format is also still understood; no manual migration needed.

## Security

- **No PIN, no data.** The page renders server side: without a session, the Redis query doesn't even
  run, and the response only contains the PIN form. The PIN only exists on the server
  (`DASHBOARD_PIN`), compared in constant time.
- **Session:** a random id in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie, stored in Redis (30
  days). *Log out* invalidates it immediately; changing `DASHBOARD_PIN` signs every browser out.
- **Rate limiting:** 5 attempts per IP / 15 minutes, and 30 failed attempts total / hour, so it can't be
  brute-forced from many IPs either. A 5-digit PIN only has 100,000 possibilities — this limit is what
  makes it usable — in exchange, a persistent attacker can temporarily lock you out too.
- **Ingest:** a long random Bearer token, compared in constant time. Clients never pass the token as a
  command-line argument, so it doesn't show up in the process list either.
- **Settings:** `/api/settings` checks the same session as the page; without a session it allows neither
  reading nor writing. Writes are only accepted from the same origin (`Origin`) with a JSON body.
- **Setup:** the `/setup` page and the `/api/setup` download are also behind the PIN session. The
  package contains no secret: the installer asks for the token with hidden input, checks it on the
  server, and only writes it into the machine's own config (mode 600 on macOS, under the user profile on
  Windows).
- **Stored token:** the copy entered on the Settings panel is stored in Redis encrypted with
  AES-256-GCM; the key (`TOKEN_ENCRYPTION_KEY`) only exists on the server. The token never reaches the
  HTML: the *Copy token* button fetches it with `POST` (`Cache-Control: no-store`), and every fetch and
  save is logged to the audit log, with the browser's data, before the server responds. Changing it
  requires confirmation, with a 5-second wait.
- Search engines are blocked (`robots.txt`, `X-Robots-Tag`), and the page can't be embedded
  (`X-Frame-Options`).

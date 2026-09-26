# Clients

How the reporting clients work, the three ways to install one, and how to update, uninstall, and
troubleshoot them.

- [How a client works](#how-a-client-works)
- [Installing from the Setup page](#installing-from-the-setup-page)
- [OS matrix](#os-matrix)
- [The opt-in cost estimate](#the-opt-in-cost-estimate)
- [Per-machine tokens vs. the master token](#per-machine-tokens-vs-the-master-token)
- [Command-line install](#command-line-install)
- [Flags and exit codes](#flags-and-exit-codes)
- [Config and log files](#config-and-log-files)
- [Updating](#updating)
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)

## How a client works

Every client — automatic or manual, macOS/Linux or Windows — runs the same core logic
(`clients/shared/report-usage-core.sh` / `.ps1`, invoked through `clients/auto/report-usage.*` or
`clients/manual/report-usage.*`):

1. **Cycle lookup:** `GET /api/usage` with the configured Bearer token returns the server's current
   cycle (`sinceDate`, `timeZone`) and its known provider list. See [api.md](api.md) for the exact
   response shape.
2. **Reading usage:** it runs `ccusage daily --json --by-agent --breakdown --since <sinceDate>
   --timezone <tz>` (plus `--no-cost`, or `--offline` when the cost estimate is on — see below),
   filtered to the days since the cycle started, and for Claude Code specifically also `ccusage blocks
   --json --offline --session-length 1 --since <sinceDate> --timezone <tz>` to get whole-hour blocks.
   `ccusage` itself runs from a globally installed copy if present, otherwise via `npx --yes
   ccusage@<version>` — the version is pinned (`20.0.24` at the time of writing) in
   `clients/shared/report-usage-core.sh`, `report-usage-core.ps1`, and `lib/setup.ts` together (a test
   checks the three stay in sync); `USAGERATIO_CCUSAGE_VERSION` overrides it (`latest` is an explicit
   opt-in), and `USAGERATIO_CCUSAGE=global|npx` forces one path over the other.
3. **Building the payload:** the parser (`clients/shared/ccusage-providers.cjs`) turns `ccusage`'s
   output into `providers` (running total per provider for the cycle, in `snapshot` mode — the
   server's default, see [data-model.md](data-model.md)), a per-model breakdown (`models`), a
   per-day breakdown (`days`, with an hourly breakdown for Claude Code where available), and, if the
   cost estimate is on, `costs`/`modelCosts`. The full field-by-field schema and its limits are in
   [api.md](api.md).
4. **Sending it:** `POST /api/usage` with the same Bearer token. `201` means it was stored; `200` with
   `"duplicate": true` means the exact same report already existed (harmless, no double-counting); a
   non-2xx response is logged and the client exits non-zero (see [Exit codes](#flags-and-exit-codes)).

The provider id comes from matching `ccusage`'s model/vendor text against the `PROVIDERS` list in
`clients/shared/ccusage-providers.cjs` (`claude`, `deepseek`, `gemini`, `kimi`, `meta`, `mistral`,
`openai`, `qwen`, `xai`, and more as `ccusage` adds them) — order matters, the first pattern that
matches wins. [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-provider) explains how to add a new one.

## Installing from the Setup page

Sign in, open **Setup**. Pick the machine's OS, a run mode, an existing or new group, and (optionally)
a machine id, then pick one of three routes to get the files onto the machine
(`components/setup/{zip-route,manual-route,one-shot-route}.tsx`, `lib/setup.ts`):

| Route | What it is | Contains the real token? |
| --- | --- | --- |
| **Download as ZIP** | A ready-made package; run its installer (`install.sh` on macOS/Linux, `install.cmd`/`install.ps1` on Windows) | No — the installer prompts for it |
| **Copy and create** | The same files as copyable code blocks, with the names and locations to save them under | No — same prompt |
| **One-shot command** | A single paste-and-run command (the reporter core and parser embedded, gzip+base64) that sends one report immediately, with nothing installed | **Yes** — the token is embedded inline in the command |

Because the one-shot command (and a "copy the token" affordance next to the ZIP/manual steps) needs the
real `USAGE_API_TOKEN` value, fetching it requires **sudo**: a short-lived (5 minute) re-confirmation of
the dashboard PIN on top of an already-live session (see [security.md](security.md)). If a copy attempt
comes back `sudo_required`, the page shows an inline unlock prompt — re-enter the PIN, then click copy
again (it does not retry automatically).

The installer, wherever it runs (`clients/setup/install.sh` / `install.ps1` / `install.cmd`):

1. figures out which mode it's installing (auto or manual) from the adjacent `report-usage-auto.*` or
   `report-usage-manual.*` file in the package;
2. asks for `USAGE_API_TOKEN` with hidden input and checks it with a `GET /api/usage` request (asks
   again on `401`; skips the prompt if the `USAGERATIO_API_TOKEN` environment variable is already set).
   The package itself never contains the token;
3. copies the files to their standard locations (see [Config and log files](#config-and-log-files)) —
   the downloaded folder can live anywhere and be deleted afterward;
4. keeps the machine id already configured on a reinstall when the field is left blank, so history
   isn't split across two ids;
5. sends one test report, then installs the schedule: a cron entry (macOS/Linux), a Scheduled Task
   (Windows automatic), the `sync-tokens` alias (macOS/Linux manual), or a desktop shortcut (Windows
   manual).

## OS matrix

| | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Automatic scheduling | `cron`, hourly, with jitter | `cron`, hourly, with jitter | Scheduled Task, daily trigger + hourly repetition, with a random delay on the day's first run |
| Manual invocation | `sync-tokens` shell alias (appended to `~/.zshrc`/`~/.bashrc`/`~/.bash_profile`) | same alias mechanism | `Sync tokens.lnk` desktop shortcut |
| Config file | `~/.config/usageratio/config` (mode 600) | same path | `%USERPROFILE%\.usageratio\config.json` |
| Script location | `~/.usageratio/{auto,manual,shared}` | same | `%USERPROFILE%\.usageratio\{auto,manual,shared}` |
| Log file | `~/Library/Logs/usageratio.log` (falls back to `~/.usageratio.log` if that directory doesn't exist) | `~/.usageratio.log` | `%USERPROFILE%\.usageratio\usageratio.log` |

macOS and Linux share the same installer, scripts, and file layout (`clients/setup/install.sh`
branches on `uname -s` only for a handful of strings), but two things genuinely differ: the log
location above, and the installer's cron guidance — on Linux it checks whether `cron`/`crond` is
available at all and suggests `apt install cron` / `dnf install cronie` when it isn't, and it doesn't
look for `/opt/homebrew/bin` when locating Node.

**Jitter (macOS/Linux):** the automatic reporter sleeps a random `0`–`JITTER_MAX` seconds before
running (`JITTER_MAX` defaults to 300, i.e. up to 5 minutes; override with `USAGERATIO_JITTER_MAX`), so
machines installed at the same time don't all report in the same second. The installer's own first test
report sets `USAGERATIO_JITTER_MAX=0` to skip the wait. **Random delay (Windows):** the Scheduled Task
is created with `-RandomDelay (New-TimeSpan -Minutes 5)` on its daily trigger, then repeats hourly for
the rest of the day with no further per-run delay.

## The opt-in cost estimate

Off by default (a subscription plan isn't billed per token). Turning it on — the **cost_opt_in**
checkbox on the Setup page's package settings, which sets `cost: true` in the generated config
(`COST=1` in the macOS/Linux config file, `"cost": true` in `config.json` on Windows, or a
`USAGERATIO_COST=1` line in the one-shot command) — makes the client run `ccusage` with `--offline`
(its own cached list-price data, no network call) instead of `--no-cost`, and adds `costs` (USD, per
provider) and `modelCosts` (USD, per model) to the report. These are **estimates from list prices**, not
your actual bill. See [api.md](api.md) for the field shapes.

## Per-machine tokens vs. the master token

Every install route above uses the one shared `USAGE_API_TOKEN` — the Setup page has no notion of
issuing a separate token per machine. Per-machine tokens are a **separate mechanism**, managed from the
dashboard's settings panel (**Settings → Tokens**, `POST /api/tokens`; see
[configuration.md](configuration.md)): create one there (with an optional label and an optional bound
machine id), then paste it into a client's config file (`API_TOKEN=`/`apiToken`) in place of the master
token. `POST /api/usage` accepts either — the master token is checked first (constant-time comparison),
then per-machine tokens by a hash lookup. A token bound to a specific machine id rejects reports from any
other id (`403 machine_mismatch`). Revoking a per-machine token from the settings panel makes that
client's next report fail with a generic `401` — nothing on the client side distinguishes "revoked" from
"wrong token," so check the settings panel's token list if a machine suddenly stops reporting.

## Command-line install

Skipping the Setup page's ZIP/copy flow and installing straight from a clone of the repository:

**macOS/Linux, automatic (cron):**

```bash
mkdir -p "$HOME/.usageratio/auto" "$HOME/.usageratio/shared" "$HOME/.config/usageratio"
cp clients/auto/report-usage.sh "$HOME/.usageratio/auto/"
cp clients/shared/report-usage-core.sh clients/shared/ccusage-providers.cjs "$HOME/.usageratio/shared/"
chmod 700 "$HOME/.usageratio/auto/report-usage.sh" "$HOME/.usageratio/shared/report-usage-core.sh" "$HOME/.usageratio/shared/ccusage-providers.cjs"

cat > "$HOME/.config/usageratio/config" <<'EOF'
API_URL="https://usageratio.example.com/api/usage"
API_TOKEN="<USAGE_API_TOKEN>"
MACHINE_ID="mac-studio"
GROUP_ID="Personal"
EOF
chmod 600 "$HOME/.config/usageratio/config"

/bin/bash "$HOME/.usageratio/auto/report-usage.sh"   # a test run
(crontab -l 2>/dev/null | grep -v '/\.usageratio/auto/report-usage\.sh'; \
 printf '0 * * * * /bin/bash "%s/.usageratio/auto/report-usage.sh" >/dev/null 2>&1\n' "$HOME") | crontab -
```

**macOS/Linux, manual (shell alias):** the same file layout under `manual/` instead of `auto/`, then:

```bash
printf '\nalias sync-tokens='\''/bin/bash "$HOME/.usageratio/manual/report-usage.sh"'\''\n' >> "$HOME/.zshrc"
source "$HOME/.zshrc" && sync-tokens
```

**Windows, automatic (Task Scheduler)**, PowerShell as Administrator:

```powershell
$root = Join-Path $env:USERPROFILE '.usageratio'
New-Item -ItemType Directory -Force -Path "$root\auto", "$root\shared" | Out-Null
Copy-Item '.\clients\auto\report-usage.ps1', '.\clients\auto\install-task.ps1' -Destination "$root\auto" -Force
Copy-Item '.\clients\shared\report-usage-core.ps1', '.\clients\shared\ccusage-providers.cjs' -Destination "$root\shared" -Force
Get-ChildItem "$root\auto", "$root\shared" -Filter '*.ps1' | Unblock-File

@"
{ "apiUrl": "https://usageratio.example.com/api/usage", "apiToken": "<USAGE_API_TOKEN>",
  "machineId": "win-desktop", "groupId": "Work" }
"@ | Set-Content "$root\config.json" -Encoding UTF8

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root\auto\report-usage.ps1"   # a test run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$root\auto\install-task.ps1"
```

**Windows, manual (desktop shortcut):** the same layout under `manual\`, a `sync-tokens.cmd` wrapper, and
a `Sync tokens.lnk` shortcut on the desktop pointing at it — see `docs/self-hosting.md`'s and the
Setup page's generated README for the exact `New-Object -ComObject WScript.Shell` snippet, since it's
easiest copied verbatim from there.

Every config value can be overridden per-run with an environment variable prefixed
`USAGERATIO_` (`USAGERATIO_API_URL`, `USAGERATIO_API_TOKEN`, `USAGERATIO_MACHINE_ID`,
`USAGERATIO_GROUP_ID`, `USAGERATIO_COST`, …) — handy for testing without touching the config file:

```bash
USAGERATIO_API_URL=http://localhost:3000/api/usage USAGERATIO_API_TOKEN=test \
  clients/manual/report-usage.sh --providers '{"claude":22000,"deepseek":15000}' --dry-run
```

## Flags and exit codes

| Flag (bash) | Flag (PowerShell) | Effect |
| --- | --- | --- |
| `--providers '{"claude":22000,...}'` | `-Providers '{"claude":22000,...}'` | send this exact multi-provider snapshot instead of reading `ccusage` |
| `--tokens claude=1234` | `-Tokens claude=1234` | send one provider's total: `{"claude":1234}` |
| `--dry-run` | `-DryRun` | print the JSON payload, send nothing |
| `-h` / `--help` | — | usage text |
| — | `-ConfigPath <path>` | use a config file other than the default location |
| — | `-OutputMode Silent\|Manual` | force silent (automatic-style) or console output |

`install-task.ps1` additionally takes `-ScriptPath`, `-TaskName`, `-IntervalMinutes` (5–1440),
`-Interactive`, and `-Uninstall`.

Exit codes, the reporter core (both shells):

| Code | Meaning |
| --- | --- |
| `0` | sent (including a `200 duplicate` response) |
| `1` | sending failed — network error, or the server answered a non-2xx status |
| `2` | bad configuration — `MACHINE_ID`/`GROUP_ID`/`API_TOKEN` missing, or a required tool (`curl`, `node`, the parser file) missing |
| `3` | reading usage failed — a malformed `--providers`/`--tokens` value, or `ccusage`/the parser itself failed |

`install.sh` / `install.ps1`: `0` installed, `1` installation failed, `2` an incomplete package (a
required file is missing, or `config.json` doesn't parse).

## Config and log files

See the [OS matrix](#os-matrix) table above for the paths. The config file's keys are always
`API_URL`, `API_TOKEN`, `MACHINE_ID`, `GROUP_ID`, and optionally `COST` (shell) / `cost` (Windows
`config.json`); the macOS/Linux installer also adds a `PATH=` line when Node isn't found in one of the
usual locations (nvm, Volta, Homebrew), so the cron job can find it too. `USAGERATIO_LOG_FILE`
overrides the log path on any OS. Logs self-trim to the last 500 lines once they pass 1000, so they
don't grow unbounded on a machine that's never rebooted.

## Updating

Re-run the installer (or re-download the ZIP, or re-run the one-shot command). Files are replaced
atomically, so a cron run in progress during an update always reads a whole file, never a half-written
one. Leaving the machine-id field blank on a reinstall keeps the existing id (so history isn't split);
leaving the token prompt blank keeps the already-saved token.

## Uninstalling

| | macOS/Linux, automatic | macOS/Linux, manual | Windows, automatic | Windows, manual |
| --- | --- | --- | --- | --- |
| Stop the schedule | `crontab -l \| grep -v '.../report-usage.sh' \| crontab -` | remove the `sync-tokens` alias line from `~/.zshrc`/`~/.bashrc` by hand | `Unregister-ScheduledTask -TaskName 'usageratio-report' -Confirm:$false` | delete the `Sync tokens.lnk` desktop shortcut |
| Remove files | `rm -rf ~/.usageratio ~/.config/usageratio` | same | `Remove-Item -Recurse -Force "$env:USERPROFILE\.usageratio"` | same |

The Setup page's generated README includes these commands pre-filled for the machine's OS and mode.
None of them revoke anything server-side — if the machine used a per-machine token, revoke it from the
settings panel too, once you no longer need it.

## Troubleshooting

Check the log file first (see [Config and log files](#config-and-log-files)); manual mode also prints
to the console. Common lines and what they mean:

| Message (paraphrased) | Cause |
| --- | --- |
| `ccusage was not found in PATH` / `Neither ccusage nor npx was found in PATH` | install Node/npm, or check the `PATH=` line in the config |
| `Node.js was not found` | same |
| `curl was not found` | install `curl` (macOS/Linux only — required by the installer and the reporter) |
| `<parser file> is missing; install it next to <script>` | an incomplete package — reinstall from a fresh Setup-page download |
| `MACHINE_ID and GROUP_ID must be set` / `API_TOKEN is not set` | fix the config file (exit code 2) |
| `The server rejected USAGERATIO_API_TOKEN (HTTP 401)` | wrong token, at install time |
| `Cycle endpoint answered HTTP …` | `GET /api/usage` failed at runtime — usually a wrong/revoked token, or the server is down |
| `server answered HTTP …` | `POST /api/usage` failed at runtime (exit code 1) — check the token and the group/provider caps in [api.md](api.md) |
| `could not reach <URL> (curl exit …)` | network/DNS failure reaching the server |

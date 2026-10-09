# macOS app reports the machine's own usage — short plan

**Goal:** the menu bar app can take over the hourly cron reporter on a Mac: it runs the same
reporter core (`clients/shared/report-usage-core.sh` + `ccusage-providers.cjs`) hourly and on ↻,
with the one token it already holds. The scripts stay as they are and keep working.

**Approved design (chat, 2026-10-09):** one token for everything — the unreleased `official` scope
also reports tokens (POST /api/usage), and may be bound to a machine like an ingest token. Data sent
by the script is untouched: the server keeps the largest snapshot per machine/provider/cycle, so the
app continuing under the same machine name (prefilled from `~/.config/usageratio/config`) neither
double-counts nor resets anything.

## Global constraints

- Existing `ingest` / `read` tokens behave exactly as before; a `read` token still may not report
  (`403 read_only_token`) nor be bound to a machine.
- One reporter implementation: the app bundles and runs the shared bash core; no Swift re-implementation
  of ccusage parsing. The core keeps reading `~/.config/usageratio/config` when present (PATH, COST),
  with the app's values winning through the `USAGERATIO_*` environment variables.
- The token never touches disk from the app: it goes to the core through the environment.
- UI text in en/hu/de (messages/*.json, Strings.swift). No AI attribution in commits.

## Tasks

1. **Server — official tokens report too.** `lib/tokens.ts` (official keeps its `machineId`),
   `app/api/tokens/route.ts` (only `read` refuses a machine), `app/api/usage/route.ts` (only `read`
   is `read_only_token`), tokens settings section (machine picker for official too; label
   "Menu bar app (read, report, official %)"), messages, docs/api.md + docs/clients.md; unit and
   integration tests.
2. **Reporter core — report mode override.** `USAGERATIO_REPORT_MODE` (auto|manual) wins over the
   output mode's default, so the app can print readable results (manual output) while reporting as a
   scheduled ("auto", 60 min) machine. Vitest coverage in the existing core tests.
3. **App core — pure parts (UsageRatioCore, Swift Testing).** `ReporterConfigFile.parse` (MACHINE_ID /
   GROUP_ID from the script's config, quotes handled, token ignored); `MachineReportOutcome.parse(exitCode:,
   output:)` mapping the core's exit codes and "❌ Sync failed: …" line to problems (node missing,
   ccusage failed, unauthorized, machine mismatch, read-only token, rate limited, server HTTP n,
   network, other); `MachineReportPolicy.isDue(lastReport:, now:)` (hourly); strings en/hu/de.
4. **App — run it.** `MachineReporter` (Process: `/bin/bash <bundle>/Contents/Resources/reporter/report-usage-core.sh`,
   env API URL/token/machine/group, `USAGERATIO_OUTPUT_MODE=manual`, `USAGERATIO_REPORT_MODE=auto`,
   `USAGERATIO_INTERVAL_MINUTES=60`, PATH extended with nvm/volta node dirs; 5-minute timeout);
   `StatusStore` runs it when due and on ↻ without delaying the status lookup, refetches after a send;
   settings section "This Mac's usage" (toggle, machine, group, prefill, node found or not); popover
   footer line (reported N min ago / reporting… / failed: reason); `build-app.sh` bundles the two
   shared files; README.
5. **Verify:** `npm run check`, `scripts/test.sh`, build + install the app, dry run against the local
   core with `--dry-run` equivalents; final review.

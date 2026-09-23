#!/bin/bash
#
# Shared usageratio reporter core for macOS / Linux.
# Use ../auto/report-usage.sh or ../manual/report-usage.sh instead of calling this file directly.
#
#   report-usage.sh                  read every provider snapshot and send it
#   report-usage.sh --providers '{"claude":22000,"deepseek":15000}'
#   report-usage.sh --tokens 1234    compatibility shortcut: {"deepseek":1234}
#   report-usage.sh --dry-run        print the JSON payload, send nothing
#
# Settings live outside the script, so it can be replaced without losing them:
#
#   ~/.config/usageratio/config      (chmod 600 — it holds the API token)
#
#     API_URL="https://usageratio.snktibor.hu/api/usage"
#     API_TOKEN="<the server's USAGE_API_TOKEN>"
#     MACHINE_ID="mac-studio"
#     GROUP_ID="Personal"
#
#   The file is plain shell, read after PATH is set up below: the setup package's
#   install.sh writes it and adds a PATH line when node lives elsewhere (nvm, volta).
#
# Exit codes: 0 sent · 1 sending failed · 2 bad usage/config · 3 token reader failed

set -u
set -o pipefail
umask 077

# cron starts jobs with a bare PATH; make common Homebrew/npm locations visible.
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export PATH

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CCUSAGE_PARSER="$SCRIPT_DIR/ccusage-providers.cjs"
OUTPUT_MODE="${USAGERATIO_OUTPUT_MODE:-silent}"
# Which ccusage runs: "global" only the installed command, "npx" only the current
# package through npx, anything else the installed one with npx as its fallback.
CCUSAGE_RUNNER="${USAGERATIO_CCUSAGE:-auto}"

case "$OUTPUT_MODE" in
  silent | manual) ;;
  *) OUTPUT_MODE="silent" ;;
esac

# Runs ccusage with the given arguments into the file $1: the global ccusage
# first, and when that fails (an older version may not know unified reports
# yet), the current package through npx. USAGERATIO_CCUSAGE picks just one.
run_ccusage() {
  local output="$1"
  shift
  case "$CCUSAGE_RUNNER" in
    global)
      ccusage "$@" >"$output"
      return
      ;;
    npx)
      npx --yes ccusage@latest "$@" >"$output"
      return
      ;;
  esac
  if command -v ccusage >/dev/null 2>&1 && ccusage "$@" >"$output"; then
    return 0
  fi
  command -v npx >/dev/null 2>&1 || return 1
  npx --yes ccusage@latest "$@" >"$output"
}

# Runs ccusage's unified daily report and converts every model/source to a
# provider snapshot, plus each provider's split by model in $WORK_DIR/models.json
# and the snapshot's split by day (Claude Code's also by hour, from ccusage's
# one-hour blocks) in $WORK_DIR/days.json.
# No jq is needed; the shared parser uses Node.js.
read_provider_tokens() {
  local output_file="$WORK_DIR/ccusage.json"
  local blocks_file="$WORK_DIR/blocks.json"
  local error_file="$WORK_DIR/ccusage-error"
  local cycle_file="$WORK_DIR/cycle.json"
  local cycle_code
  local cycle_start
  local cycle_since
  local cycle_timezone
  local cycle_providers
  local -a ccusage_args
  local -a blocks_args
  local -a hourly_args

  cycle_code="$(curl --silent --show-error \
    --config "$WORK_DIR/curl.conf" \
    --request GET \
    --connect-timeout 10 --max-time 30 \
    --retry 3 --retry-delay 5 --retry-connrefused \
    --output "$cycle_file" \
    --write-out '%{http_code}' \
    "$API_URL" 2>"$error_file")" || return 1
  if [ "$cycle_code" != "200" ]; then
    printf 'Cycle endpoint answered HTTP %s: ' "$cycle_code" >>"$error_file"
    head -c 300 "$cycle_file" >>"$error_file" 2>/dev/null
    return 1
  fi
  cycle_since="$(node "$CCUSAGE_PARSER" cycle-since <"$cycle_file" 2>>"$error_file")" || return 1
  cycle_timezone="$(node "$CCUSAGE_PARSER" cycle-timezone <"$cycle_file" 2>>"$error_file")" || return 1
  cycle_providers="$(node "$CCUSAGE_PARSER" cycle-providers <"$cycle_file" 2>>"$error_file")" || return 1
  # Only the hours need the exact start: without it the days are sent whole.
  cycle_start="$(node "$CCUSAGE_PARSER" cycle-start <"$cycle_file" 2>/dev/null)" || cycle_start=""
  ccusage_args=(daily --json --by-agent --breakdown --no-cost --since "$cycle_since" --timezone "$cycle_timezone")
  blocks_args=(blocks --json --offline --session-length 1 --since "${cycle_since//-/}" --timezone "$cycle_timezone")

  case "$CCUSAGE_RUNNER" in
    global)
      if ! command -v ccusage >/dev/null 2>&1; then
        printf '%s\n' "ccusage was not found in PATH." >"$error_file"
        return 1
      fi
      ;;
    npx)
      if ! command -v npx >/dev/null 2>&1; then
        printf '%s\n' "npx was not found in PATH." >"$error_file"
        return 1
      fi
      ;;
    *)
      if ! command -v ccusage >/dev/null 2>&1 && ! command -v npx >/dev/null 2>&1; then
        printf '%s\n' "Neither ccusage nor npx was found in PATH." >"$error_file"
        return 1
      fi
      ;;
  esac
  # Read before the daily report, so the hours never run ahead of the days.
  # Optional: a failed read only means the days are sent without hours.
  run_ccusage "$blocks_file" "${blocks_args[@]}" 2>/dev/null || rm -f "$blocks_file"
  run_ccusage "$output_file" "${ccusage_args[@]}" 2>>"$error_file" || return 1

  hourly_args=("$blocks_file" "$cycle_start" "$cycle_timezone")
  PROVIDERS_JSON="$(node "$CCUSAGE_PARSER" parse "$cycle_providers" "${hourly_args[@]}" <"$output_file" 2>>"$error_file")" || return 1
  # The splits by model and by day are optional: without them the report still goes out.
  node "$CCUSAGE_PARSER" parse-models "$cycle_providers" "${hourly_args[@]}" <"$output_file" >"$WORK_DIR/models.json" 2>/dev/null ||
    rm -f "$WORK_DIR/models.json"
  node "$CCUSAGE_PARSER" parse-days "$cycle_providers" "${hourly_args[@]}" <"$output_file" >"$WORK_DIR/days.json" 2>/dev/null ||
    rm -f "$WORK_DIR/days.json"
  [ -n "$PROVIDERS_JSON" ]
}

# ─── Settings ─────────────────────────────────────────────────────────────────

CONFIG_FILE="${USAGERATIO_CONFIG:-$HOME/.config/usageratio/config}"

API_URL="https://usageratio.snktibor.hu/api/usage"
API_TOKEN=""
MACHINE_ID=""
GROUP_ID=""
if [ -d "$HOME/Library/Logs" ]; then
  LOG_FILE="$HOME/Library/Logs/usageratio.log"
else
  LOG_FILE="$HOME/.usageratio.log"
fi

if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
fi

# Environment variables win over the config file (handy for one-off tests).
API_URL="${USAGERATIO_API_URL:-$API_URL}"
API_TOKEN="${USAGERATIO_API_TOKEN:-$API_TOKEN}"
MACHINE_ID="${USAGERATIO_MACHINE_ID:-$MACHINE_ID}"
GROUP_ID="${USAGERATIO_GROUP_ID:-$GROUP_ID}"
LOG_FILE="${USAGERATIO_LOG_FILE:-$LOG_FILE}"

if [ -z "$MACHINE_ID" ]; then
  MACHINE_ID="$(scutil --get LocalHostName 2>/dev/null || hostname -s 2>/dev/null || hostname)"
fi

# ─── Helpers ──────────────────────────────────────────────────────────────────

log() {
  local line
  line="$(date '+%Y-%m-%d %H:%M:%S') $*"
  mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null
  printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null
  case "$*" in
    ERROR:*)
      if [ "$OUTPUT_MODE" = "manual" ]; then
        printf '❌ Sync failed: %s\n' "${*#ERROR: }" >&2
      fi
      ;;
  esac
}

trim_log() {
  [ -f "$LOG_FILE" ] || return 0
  local lines
  lines="$(wc -l <"$LOG_FILE" | tr -d ' ')"
  if [ "${lines:-0}" -gt 1000 ]; then
    tail -n 500 "$LOG_FILE" >"$LOG_FILE.tmp" 2>/dev/null && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
}

# Escapes a value for use inside a double-quoted JSON (or curl config) string.
escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

usage() {
  sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
}

# ─── Arguments ────────────────────────────────────────────────────────────────

TOKENS_OVERRIDE=""
PROVIDERS_OVERRIDE=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    --providers)
      PROVIDERS_OVERRIDE="${2:-}"
      shift 2 || { echo "--providers needs a JSON object" >&2; exit 2; }
      ;;
    --providers=*)
      PROVIDERS_OVERRIDE="${1#--providers=}"
      shift
      ;;
    --tokens)
      TOKENS_OVERRIDE="${2:-}"
      shift 2 || { echo "--tokens needs a number" >&2; exit 2; }
      ;;
    --tokens=*)
      TOKENS_OVERRIDE="${1#--tokens=}"
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# ─── Checks ───────────────────────────────────────────────────────────────────

if [ -z "$GROUP_ID" ] || [ -z "$MACHINE_ID" ]; then
  log "ERROR: MACHINE_ID and GROUP_ID must be set in $CONFIG_FILE"
  exit 2
fi
if [ "$DRY_RUN" -eq 0 ] && [ -z "$API_TOKEN" ]; then
  log "ERROR: API_TOKEN is not set in $CONFIG_FILE"
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  log "ERROR: curl was not found"
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  log "ERROR: Node.js was not found (it is required by ccusage and the JSON parser)"
  exit 2
fi
if [ ! -f "$CCUSAGE_PARSER" ]; then
  log "ERROR: $CCUSAGE_PARSER is missing; install it next to $0"
  exit 2
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/usageratio.XXXXXX")" || {
  log "ERROR: could not create a temporary directory"
  exit 1
}
trap 'rm -rf "$WORK_DIR"' EXIT

# curl reads this private file both for the cycle lookup and for the report.
if [ -n "$API_TOKEN" ]; then
  printf 'header = "Authorization: Bearer %s"\n' "$(escape "$API_TOKEN")" >"$WORK_DIR/curl.conf"
fi

# ─── Provider snapshots ───────────────────────────────────────────────────────

PROVIDERS_JSON=""
if [ -n "$PROVIDERS_OVERRIDE" ]; then
  PROVIDERS_JSON="$(printf '%s' "$PROVIDERS_OVERRIDE" | node "$CCUSAGE_PARSER" validate 2>"$WORK_DIR/ccusage-error")" || {
    log "ERROR: invalid --providers value: $(tr '\n' ' ' <"$WORK_DIR/ccusage-error")"
    exit 3
  }
elif [ -n "$TOKENS_OVERRIDE" ]; then
  case "$TOKENS_OVERRIDE" in
    "" | *[!0-9]*)
      log "ERROR: --tokens must be a non-negative whole number, got: '$TOKENS_OVERRIDE'"
      exit 3
      ;;
  esac
  TOKENS_OVERRIDE="$(printf '%s' "$TOKENS_OVERRIDE" | sed -e 's/^0*//')"
  TOKENS_OVERRIDE="${TOKENS_OVERRIDE:-0}"
  PROVIDERS_JSON="$(printf '{"deepseek":%s}' "$TOKENS_OVERRIDE" | node "$CCUSAGE_PARSER" validate)" || exit 3
elif [ -z "$API_TOKEN" ]; then
  log "ERROR: API_TOKEN is required to read the current cycle before running ccusage"
  exit 2
elif ! read_provider_tokens; then
  log "ERROR: ccusage could not be read: $(tr '\n' ' ' <"$WORK_DIR/ccusage-error" 2>/dev/null)"
  exit 3
fi

# ─── Payload ──────────────────────────────────────────────────────────────────

TIMESTAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
PAYLOAD="$(printf '%s' "$PROVIDERS_JSON" | node "$CCUSAGE_PARSER" payload "$MACHINE_ID" "$GROUP_ID" "$TIMESTAMP" "$WORK_DIR/models.json" "$WORK_DIR/days.json" 2>"$WORK_DIR/payload-error")" || {
  log "ERROR: could not create the JSON payload"
  exit 3
}

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' "$PAYLOAD"
  exit 0
fi

# ─── Send ─────────────────────────────────────────────────────────────────────

HTTP_CODE="$(curl --silent --show-error \
  --config "$WORK_DIR/curl.conf" \
  --request POST \
  --header 'Content-Type: application/json' \
  --data "$PAYLOAD" \
  --connect-timeout 10 --max-time 30 \
  --retry 3 --retry-delay 5 --retry-connrefused \
  --output "$WORK_DIR/response" \
  --write-out '%{http_code}' \
  "$API_URL" 2>"$WORK_DIR/error")"
CURL_EXIT=$?

trim_log

if [ "$CURL_EXIT" -ne 0 ]; then
  log "ERROR: could not reach $API_URL (curl exit $CURL_EXIT): $(tr '\n' ' ' <"$WORK_DIR/error")"
  exit 1
fi

case "$HTTP_CODE" in
  200 | 201)
    if [ "$HTTP_CODE" = "200" ]; then NOTE=" (already stored)"; else NOTE=""; fi
    log "OK: $PROVIDERS_JSON as $MACHINE_ID/$GROUP_ID$NOTE"
    if [ "$OUTPUT_MODE" = "manual" ]; then
      PROVIDER_COUNT="$(printf '%s' "$PROVIDERS_JSON" | node "$CCUSAGE_PARSER" count 2>/dev/null)"
      printf '✅ Sync successful: %s providers sent.%s\n' "${PROVIDER_COUNT:-0}" "$NOTE"
    fi
    exit 0
    ;;
  *)
    log "ERROR: server answered HTTP $HTTP_CODE: $(head -c 300 "$WORK_DIR/response" 2>/dev/null | tr '\n' ' ')"
    exit 1
    ;;
esac

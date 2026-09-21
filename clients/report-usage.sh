#!/bin/bash
#
# usageratio — reports this machine's Codex token usage to the dashboard.
# macOS / Linux. Needs only bash (3.2+) and curl. Run hourly by cron; it never
# opens a window and prints nothing unless started from a terminal.
#
#   report-usage.sh                  read the token count and send it
#   report-usage.sh --tokens 1234    send this number instead (tests the pipeline)
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
# Exit codes: 0 sent · 1 sending failed · 2 bad usage/config · 3 token reader failed

set -u
set -o pipefail
umask 077

# cron starts jobs with a bare PATH; make Homebrew and /usr/local tools
# (jq, node, …) visible to the token reader below.
PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export PATH

# ══════════════════════════════════════════════════════════════════════════════
#  [TODO: INSERT CODEX TOKEN READ LOGIC HERE]
# ══════════════════════════════════════════════════════════════════════════════
#  Replace the body of read_codex_tokens. It must put a non-negative whole
#  number into TOKENS and return 0. On failure return non-zero: nothing is sent.
#
#  What the number means is set on the server (TOKEN_MODE in lib/config.ts):
#    delta     (default) tokens used since the previous SUCCESSFUL report
#    snapshot  this machine's running total for the current weekly cycle
#    counter   an ever-growing total; the server works out the increase
#
#  A delta reader has to remember what it already reported. Do that in
#  commit_reader_state: it runs only after the server has stored the report,
#  so a failed upload is simply included in the next hour's number.
# ──────────────────────────────────────────────────────────────────────────────
read_codex_tokens() {
  TOKENS=""
  return 1
}

commit_reader_state() {
  # $1 = the token count the server just accepted
  :
}
# ═══════════════════════════ END OF TOKEN READ LOGIC ══════════════════════════

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
  # Echo only when a person is watching; cron gets silence (and sends no mail).
  if [ -t 1 ]; then printf '%s\n' "$line"; fi
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
  sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
}

# ─── Arguments ────────────────────────────────────────────────────────────────

TOKENS_OVERRIDE=""
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
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

# ─── Token count ──────────────────────────────────────────────────────────────

TOKENS=""
if [ -n "$TOKENS_OVERRIDE" ]; then
  TOKENS="$TOKENS_OVERRIDE"
elif ! read_codex_tokens; then
  log "ERROR: the Codex token reader failed or is not implemented yet (see the TODO at the top of $0)"
  exit 3
fi

case "$TOKENS" in
  "" | *[!0-9]*)
    log "ERROR: the token count must be a non-negative whole number, got: '$TOKENS'"
    exit 3
    ;;
esac
# Drop leading zeros: "0042" is not a valid JSON number.
TOKENS="$(printf '%s' "$TOKENS" | sed -e 's/^0*//')"
TOKENS="${TOKENS:-0}"

# ─── Payload ──────────────────────────────────────────────────────────────────

TIMESTAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
PAYLOAD="$(printf '{"machineId":"%s","groupId":"%s","tokens":%s,"timestamp":"%s"}' \
  "$(escape "$MACHINE_ID")" "$(escape "$GROUP_ID")" "$TOKENS" "$TIMESTAMP")"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' "$PAYLOAD"
  exit 0
fi

# ─── Send ─────────────────────────────────────────────────────────────────────

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/usageratio.XXXXXX")" || {
  log "ERROR: could not create a temporary directory"
  exit 1
}
trap 'rm -rf "$WORK_DIR"' EXIT

# The token goes through a private config file, not the command line,
# so it never shows up in the process list.
printf 'header = "Authorization: Bearer %s"\n' "$(escape "$API_TOKEN")" >"$WORK_DIR/curl.conf"

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
    commit_reader_state "$TOKENS"
    if [ "$HTTP_CODE" = "200" ]; then NOTE=" (already stored)"; else NOTE=""; fi
    log "OK: $TOKENS tokens as $MACHINE_ID/$GROUP_ID$NOTE"
    exit 0
    ;;
  *)
    log "ERROR: server answered HTTP $HTTP_CODE: $(head -c 300 "$WORK_DIR/response" 2>/dev/null | tr '\n' ' ')"
    exit 1
    ;;
esac

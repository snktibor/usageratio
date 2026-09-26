#!/bin/bash
#
# usageratio client installer for macOS and Linux.
#
#   bash install.sh
#
# Run it from the folder of the setup package, wherever that folder is. Next to
# it: config, report-usage-core.sh, ccusage-providers.cjs and exactly one of
# report-usage-auto.sh / report-usage-manual.sh, which decides the mode:
#
#   auto    an hourly cron job reports silently
#   manual  the `sync-tokens` shell command reports on demand and prints the result
#
# The reporter is copied to ~/.usageratio (cron may not read ~/Downloads,
# ~/Documents or ~/Desktop), the settings go to ~/.config/usageratio/config
# (chmod 600) with the API token asked for here, and a first report is sent.
# Running it again updates the scripts and keeps the machine id already in use.
#
# The token prompt is skipped when USAGERATIO_API_TOKEN is set.
# Exit codes: 0 installed · 1 installation failed · 2 incomplete package

# Started with sh or zsh: continue in bash, which the rest is written for.
if [ -z "${BASH_VERSION:-}" ]; then
  exec /bin/bash "$0" "$@"
fi

set -euo pipefail
umask 077

case "${1:-}" in
  "") ;;
  -h | --help)
    sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    printf 'Unknown option: %s (try --help)\n' "$1" >&2
    exit 2
    ;;
esac

# Everything below reads the same on both OSes; only a handful of spots (the log
# location, the machine id fallback, the extra PATH candidates, cron's
# availability and a couple of strings naming the terminal app) differ.
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then
  TERMINAL_NAME="Terminal"
  TERMINAL_WINDOW="Terminal window"
else
  TERMINAL_NAME="a terminal"
  TERMINAL_WINDOW="terminal window"
fi

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
INSTALL_DIR="$HOME/.usageratio"
CONFIG_FILE="$HOME/.config/usageratio/config"
if [ "$OS" = "Darwin" ] && [ -d "$HOME/Library/Logs" ]; then
  LOG_FILE="$HOME/Library/Logs/usageratio.log"
else
  LOG_FILE="$HOME/.usageratio.log"
fi

say() { printf '%s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
fail() {
  printf '❌ %s\n' "$1" >&2
  exit "${2:-1}"
}

# Single-quotes a value for the sourced config file; safe for any character.
quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# Escapes a value for a double-quoted curl config string.
curl_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# ─── Package ──────────────────────────────────────────────────────────────────

for file in config report-usage-core.sh ccusage-providers.cjs; do
  [ -f "$SOURCE_DIR/$file" ] ||
    fail "$file is missing from $SOURCE_DIR. Every package file belongs in one folder, next to install.sh." 2
done

MODE=""
if [ -f "$SOURCE_DIR/report-usage-auto.sh" ]; then
  MODE="auto"
fi
if [ -f "$SOURCE_DIR/report-usage-manual.sh" ]; then
  [ -z "$MODE" ] ||
    fail "Both report-usage-auto.sh and report-usage-manual.sh are in $SOURCE_DIR; keep the one you want." 2
  MODE="manual"
fi
[ -n "$MODE" ] || fail "report-usage-auto.sh or report-usage-manual.sh is missing from $SOURCE_DIR." 2

API_URL=""
MACHINE_ID=""
GROUP_ID=""
# shellcheck disable=SC1091
. "$SOURCE_DIR/config" || fail "$SOURCE_DIR/config could not be read." 2

[ -n "$GROUP_ID" ] || fail "GROUP_ID is empty in $SOURCE_DIR/config." 2
case "$API_URL" in
  https://* | http://*) ;;
  *) fail "API_URL in $SOURCE_DIR/config must be the server's /api/usage address." 2 ;;
esac

# Reads one value of the installed config without letting it touch this shell.
installed_setting() {
  [ -f "$CONFIG_FILE" ] || return 0
  (
    set +eu
    API_TOKEN=""
    MACHINE_ID=""
    # shellcheck disable=SC1090
    . "$CONFIG_FILE" >/dev/null 2>&1
    printf '%s' "${!1:-}"
  )
}

EXISTING_TOKEN="$(installed_setting API_TOKEN)"
EXISTING_MACHINE_ID="$(installed_setting MACHINE_ID)"

# An empty MACHINE_ID keeps the id this machine already reports under, so a
# reinstall never splits its history; a first install takes the computer's name.
if [ -z "$MACHINE_ID" ]; then
  MACHINE_ID="$EXISTING_MACHINE_ID"
fi
if [ -z "$MACHINE_ID" ]; then
  if [ "$OS" = "Darwin" ]; then
    MACHINE_ID="$(scutil --get LocalHostName 2>/dev/null || hostname -s 2>/dev/null || hostname)"
  else
    MACHINE_ID="$(hostname -s 2>/dev/null || hostname)"
  fi
fi

# ─── Requirements ─────────────────────────────────────────────────────────────

command -v curl >/dev/null 2>&1 || fail "curl was not found."
NODE_BIN="$(command -v node 2>/dev/null || true)"
[ -n "$NODE_BIN" ] ||
  fail "Node.js was not found. Install it (https://nodejs.org), then run install.sh again: ccusage and the reporter both need it."

# cron starts jobs with a bare PATH. The reporter adds the usual Homebrew (macOS)
# or system (Linux) and npm locations itself; a node from anywhere else (nvm,
# volta) gets a PATH line in the config.
if [ "$OS" = "Darwin" ]; then
  KNOWN_PATH=":/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin:"
else
  KNOWN_PATH=":/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin:"
fi
EXTRA_PATH=""
NODE_DIR="$(dirname "$NODE_BIN")"
case "$KNOWN_PATH" in
  *":$NODE_DIR:"*) ;;
  *) EXTRA_PATH="$NODE_DIR" ;;
esac

# ─── API token ────────────────────────────────────────────────────────────────

VERIFY_DETAIL=""

# 0: the server accepted the token · 1: it rejected it · 2: no verdict (VERIFY_DETAIL says why).
# The token travels in curl's config on stdin, never on the command line.
verify_token() {
  local code
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$(curl_escape "$1")" |
    curl --silent --config - --request GET \
      --connect-timeout 10 --max-time 30 \
      --output /dev/null --write-out '%{http_code}' \
      "$API_URL" 2>/dev/null)" || code="000"
  case "$code" in
    200) return 0 ;;
    401) return 1 ;;
    000) VERIFY_DETAIL="$API_URL did not answer" ;;
    *) VERIFY_DETAIL="HTTP $code from $API_URL" ;;
  esac
  return 2
}

TOKEN="$(printf '%s' "${USAGERATIO_API_TOKEN:-}" | tr -d '[:space:]')"
if [ -n "$TOKEN" ]; then
  status=0
  verify_token "$TOKEN" || status=$?
  [ "$status" -ne 1 ] || fail "The server rejected USAGERATIO_API_TOKEN (HTTP 401)."
  [ "$status" -eq 0 ] || warn "The token could not be checked ($VERIFY_DETAIL); the first report will tell."
else
  [ -t 0 ] || fail "There is no terminal to ask for the API token: run install.sh in $TERMINAL_NAME, or set USAGERATIO_API_TOKEN."
  say "The API token is the server's USAGE_API_TOKEN, the same on every machine. Typing is hidden."
  attempt=0
  while :; do
    attempt=$((attempt + 1))
    if [ -n "$EXISTING_TOKEN" ]; then
      printf 'USAGE_API_TOKEN (Enter keeps the saved one): ' >&2
    else
      printf 'USAGE_API_TOKEN: ' >&2
    fi
    typed=""
    IFS= read -r -s typed || true
    printf '\n' >&2
    TOKEN="$(printf '%s' "$typed" | tr -d '[:space:]')"
    TOKEN="${TOKEN:-$EXISTING_TOKEN}"

    status=0
    if [ -z "$TOKEN" ]; then
      status=1
      warn "The token cannot be empty."
    else
      verify_token "$TOKEN" || status=$?
    fi
    if [ "$status" -eq 0 ]; then
      say "✅ The server accepted the token."
      break
    elif [ "$status" -eq 2 ]; then
      warn "The token could not be checked ($VERIFY_DETAIL). It is saved anyway; the first report will tell."
      break
    fi
    [ "$attempt" -lt 3 ] || fail "No valid token after three tries; nothing was installed."
    [ -z "$TOKEN" ] || warn "The server rejected this token (HTTP 401). Try again."
  done
fi

# ─── Install ──────────────────────────────────────────────────────────────────

trap 'rm -f "$INSTALL_DIR/$MODE"/*.tmp.$$ "$INSTALL_DIR/shared"/*.tmp.$$ "$CONFIG_FILE.tmp.$$" 2>/dev/null' EXIT

# Replaces the target in one rename, so a cron run starting meanwhile reads a whole file.
install_file() {
  if [ "$1" -ef "$2" ]; then
    chmod 700 "$2"
    return 0
  fi
  cat "$1" >"$2.tmp.$$"
  chmod 700 "$2.tmp.$$"
  mv -f "$2.tmp.$$" "$2"
}

mkdir -p "$INSTALL_DIR/$MODE" "$INSTALL_DIR/shared" "$(dirname "$CONFIG_FILE")"
install_file "$SOURCE_DIR/report-usage-$MODE.sh" "$INSTALL_DIR/$MODE/report-usage.sh"
install_file "$SOURCE_DIR/report-usage-core.sh" "$INSTALL_DIR/shared/report-usage-core.sh"
install_file "$SOURCE_DIR/ccusage-providers.cjs" "$INSTALL_DIR/shared/ccusage-providers.cjs"

{
  printf '# usageratio client settings, written by install.sh. Private (chmod 600): it holds the API token.\n'
  printf 'API_URL=%s\n' "$(quote "$API_URL")"
  printf 'API_TOKEN=%s\n' "$(quote "$TOKEN")"
  printf 'MACHINE_ID=%s\n' "$(quote "$MACHINE_ID")"
  printf 'GROUP_ID=%s\n' "$(quote "$GROUP_ID")"
  if [ -n "$EXTRA_PATH" ]; then
    printf '# cron starts with a bare PATH; node was found here at install time.\n'
    printf 'PATH=%s:"$PATH"\n' "$(quote "$EXTRA_PATH")"
  fi
} >"$CONFIG_FILE.tmp.$$"
chmod 600 "$CONFIG_FILE.tmp.$$"
mv -f "$CONFIG_FILE.tmp.$$" "$CONFIG_FILE"

# ─── First report ─────────────────────────────────────────────────────────────

say "Sending a first report as $MACHINE_ID in group $GROUP_ID (the first run may download ccusage)…"
REPORT_STATUS=0
/bin/bash "$INSTALL_DIR/$MODE/report-usage.sh" || REPORT_STATUS=$?
if [ "$REPORT_STATUS" -eq 0 ]; then
  if [ "$MODE" = "auto" ]; then
    say "✅ First report sent."
  fi
elif [ "$MODE" = "auto" ]; then
  warn "The first report failed (exit $REPORT_STATUS): $(tail -n 1 "$LOG_FILE" 2>/dev/null || true)"
  warn "The hourly job is set up anyway and tries again every hour."
fi

# ─── Schedule or shortcut ─────────────────────────────────────────────────────

if [ "$MODE" = "auto" ]; then
  if [ "$OS" != "Darwin" ]; then
    command -v crontab >/dev/null 2>&1 ||
      fail "crontab was not found. Install a cron package first (e.g. 'sudo apt install cron' or 'sudo dnf install cronie', then 'sudo systemctl enable --now cron' / 'crond'), then run install.sh again."
  fi
  CRON_LINE="0 * * * * /bin/bash \"$INSTALL_DIR/auto/report-usage.sh\" >/dev/null 2>&1"
  if ! {
    { crontab -l 2>/dev/null || true; } | grep -v '/\.usageratio/auto/report-usage\.sh' || true
    printf '%s\n' "$CRON_LINE"
  } | crontab -; then
    if [ "$OS" = "Darwin" ]; then
      fail "The cron job could not be saved. If macOS asks whether Terminal may administer the computer, allow it, then run install.sh again."
    else
      fail "The cron job could not be saved. Make sure the cron service is running (e.g. 'sudo systemctl status cron'), then run install.sh again."
    fi
  fi
else
  ALIAS_LINE="alias sync-tokens='/bin/bash \"\$HOME/.usageratio/manual/report-usage.sh\"'"
  case "$(basename "${SHELL:-}")" in
    zsh) RC_FILE="$HOME/.zshrc" ;;
    bash)
      if [ "$OS" = "Darwin" ]; then RC_FILE="$HOME/.bash_profile"; else RC_FILE="$HOME/.bashrc"; fi
      ;;
    *) RC_FILE="" ;;
  esac
  if [ -z "$RC_FILE" ]; then
    warn "Add this line to your shell's startup file: $ALIAS_LINE"
  elif grep -qxF "$ALIAS_LINE" "$RC_FILE" 2>/dev/null; then
    : # already there
  elif grep -q '^alias sync-tokens=' "$RC_FILE" 2>/dev/null; then
    # Replace an older definition; writing through the file keeps a symlinked rc file intact.
    rc_rest="$(grep -v '^alias sync-tokens=' "$RC_FILE" || true)"
    printf '%s\n%s\n' "$rc_rest" "$ALIAS_LINE" >"$RC_FILE"
  else
    printf '\n%s\n' "$ALIAS_LINE" >>"$RC_FILE"
  fi
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

say ""
say "✅ usageratio is installed ($MODE) as $MACHINE_ID in group $GROUP_ID."
say "   Scripts:  $INSTALL_DIR/$MODE, $INSTALL_DIR/shared"
say "   Settings: $CONFIG_FILE"
say "   Log:      $LOG_FILE"
if [ "$MODE" = "auto" ]; then
  say "   It reports every hour, on the hour (cron)."
elif [ -n "$RC_FILE" ]; then
  say "   Open a new Terminal window, then report with: sync-tokens"
fi
say "   $SOURCE_DIR is no longer needed; you can delete it."

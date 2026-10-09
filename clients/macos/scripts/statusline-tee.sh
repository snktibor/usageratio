#!/usr/bin/env bash
# usageratio: a pass-through for Claude Code's status line. Runs your own status
# line command unchanged, with the same input, and passes its output and exit code
# through byte for byte. On the way it saves the subscription limits Claude Code
# hands every status line (rate_limits: https://code.claude.com/docs/en/statusline)
# to ~/.usageratio/claude-limits.json, where the menu bar app reads them. Nothing
# here talks to the network or reads any credential.
#
#   ~/.claude/settings.json:
#     "statusLine": { "type": "command", "command": "~/.usageratio/statusline-tee.sh ~/.claude/statusline.sh" }
#
# Any failure while saving (no jq, a folder that cannot be written) is swallowed:
# the status line itself never depends on it.

input="$(cat)"

{
  dir="${USAGERATIO_DIR:-$HOME/.usageratio}"
  if command -v jq >/dev/null &&
    printf '%s' "$input" | jq -e '.rate_limits.seven_day.used_percentage != null' >/dev/null; then
    mkdir -p "$dir" &&
      printf '%s' "$input" | jq -c '{rate_limits, observed_at: now}' >"$dir/claude-limits.json.tmp" &&
      mv -f "$dir/claude-limits.json.tmp" "$dir/claude-limits.json"
  fi
} >/dev/null 2>&1 || true

[ "$#" -eq 0 ] && exit 0
printf '%s' "$input" | "$@"

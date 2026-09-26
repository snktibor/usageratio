#!/bin/bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CORE_SCRIPT="$SCRIPT_DIR/../shared/report-usage-core.sh"

[ -f "$CORE_SCRIPT" ] || exit 2

USAGERATIO_OUTPUT_MODE="silent"
export USAGERATIO_OUTPUT_MODE

# Spreads the hourly cron runs over a window so every machine does not hit the
# server in the same second: sleeps a random number of seconds below
# USAGERATIO_JITTER_MAX (default 300, i.e. up to 5 minutes) before reporting.
# The installer's first report sets USAGERATIO_JITTER_MAX=0 to skip the wait.
JITTER_MAX="${USAGERATIO_JITTER_MAX:-300}"
if [ "$JITTER_MAX" != "0" ]; then
  sleep "$((RANDOM % JITTER_MAX))"
fi

# This wrapper's own schedule (the crontab entry install.sh registers is hourly);
# the core script reports it so the dashboard's machine health can use it instead
# of the server's default interval. USAGERATIO_INTERVAL_MINUTES already set (by
# whoever runs this) wins.
USAGERATIO_INTERVAL_MINUTES="${USAGERATIO_INTERVAL_MINUTES:-60}"
export USAGERATIO_INTERVAL_MINUTES

exec /bin/bash "$CORE_SCRIPT" "$@"

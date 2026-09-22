#!/bin/bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CORE_SCRIPT="$SCRIPT_DIR/../shared/report-usage-core.sh"

if [ ! -f "$CORE_SCRIPT" ]; then
  printf '❌ Sync failed: %s is missing.\n' "$CORE_SCRIPT" >&2
  exit 2
fi

USAGERATIO_OUTPUT_MODE="manual"
export USAGERATIO_OUTPUT_MODE

exec /bin/bash "$CORE_SCRIPT" "$@"

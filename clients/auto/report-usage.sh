#!/bin/bash

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CORE_SCRIPT="$SCRIPT_DIR/../shared/report-usage-core.sh"

[ -f "$CORE_SCRIPT" ] || exit 2

USAGERATIO_OUTPUT_MODE="silent"
export USAGERATIO_OUTPUT_MODE

exec /bin/bash "$CORE_SCRIPT" "$@"

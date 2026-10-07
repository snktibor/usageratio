#!/usr/bin/env bash
# Runs the Swift tests. With only the Command Line Tools installed (no Xcode),
# SwiftPM does not find the Swift Testing framework by itself: point it there.
set -euo pipefail
cd "$(dirname "$0")/.."

developer="$(xcode-select -p)"
if [[ "$developer" == *CommandLineTools* ]]; then
  lib="$developer/Library/Developer"
  exec swift test \
    -Xswiftc -F"$lib/Frameworks" \
    -Xlinker -F"$lib/Frameworks" \
    -Xlinker -rpath -Xlinker "$lib/Frameworks" \
    -Xlinker -rpath -Xlinker "$lib/usr/lib" \
    "$@"
fi
exec swift test "$@"

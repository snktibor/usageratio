#!/usr/bin/env bash
# Builds dist/UsageRatio.app: a release build of this package, wrapped in an
# app bundle and signed ad hoc (no Apple Developer account needed). Built on
# this Mac, it is never quarantined, so Gatekeeper lets it open as is.
#
#   scripts/build-app.sh            build dist/UsageRatio.app
#   scripts/build-app.sh --install  …and copy it to ~/Applications, then open it
set -euo pipefail
cd "$(dirname "$0")/.."

install=false
[[ "${1:-}" == "--install" ]] && install=true

# The dashboard's own version (package.json at the repo root), so the two read the same.
version="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' ../../package.json)"
version="${version:-0.0.0}"

swift build -c release
binary="$(swift build -c release --show-bin-path)/UsageRatioBar"

app="dist/UsageRatio.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/UsageRatioBar"
sed "s/__VERSION__/$version/g" Resources/Info.plist > "$app/Contents/Info.plist"
# The shared reporter the scripts use: the app runs it to report this Mac's usage.
mkdir -p "$app/Contents/Resources/reporter"
install -m 0755 ../shared/report-usage-core.sh "$app/Contents/Resources/reporter/report-usage-core.sh"
install -m 0644 ../shared/ccusage-providers.cjs "$app/Contents/Resources/reporter/ccusage-providers.cjs"
codesign --force --sign - --timestamp=none "$app"
echo "Built $app ($version)"

if $install; then
  mkdir -p "$HOME/Applications"
  # A running copy holds the old binary: quit it first.
  pkill -x UsageRatioBar 2>/dev/null || true
  rm -rf "$HOME/Applications/UsageRatio.app"
  cp -R "$app" "$HOME/Applications/"
  # The pass-through for Claude Code's status line (README: "Claude's own usage").
  mkdir -p "$HOME/.usageratio"
  install -m 0755 scripts/statusline-tee.sh "$HOME/.usageratio/statusline-tee.sh"
  open "$HOME/Applications/UsageRatio.app"
  echo "Installed to ~/Applications/UsageRatio.app"
fi

# UsageRatio menu bar app

A small native macOS app: the usage percentage of one provider in the menu bar, and every
provider's figures in a popover. It reads the dashboard's [`GET /api/status`](../../docs/api.md#get-apistatus)
with a read-only token, and shows exactly what the dashboard does.

- **Menu bar:** a gauge and the chosen provider's percentage. Plain (adapting to light and dark)
  while all is well, orange past the warning level, red when critical, dimmed when the figure is
  more than two hours old (the server was unreachable, or no machine has reported).
- **Popover:** a card for the chosen provider that answers three questions in order. *How am I
  doing:* the percentage used (official or estimate), a status badge, what is left, and the tokens
  against the limit. *How long until the reset:* a bar with a marker where the cycle stands — a fill
  past the marker is ahead of the even pace — when it runs out, and when it resets. *Who took it:*
  the sub-limits, then every group with its machines under it (the machines alone while there is
  one group), their bars scaled to the heaviest group; the one the menu bar shows carries a menu
  bar icon, and a machine whose newest report is older than two hours a clock. Refresh, the
  dashboard and the gear sit at the bottom.
- **Settings (the gear):** which provider the menu bar shows, and whether its whole figure or one
  group's or machine's part of it (its share of the provider's budget, as on the dashboard); the
  server and token; open at login; quit.
- **Polling:** every 5 minutes, again 10 seconds after the Mac wakes, and when the popover opens
  on a figure older than a minute. On errors it backs off (1, 2, 4 … up to 30 minutes) and honours
  the server's `Retry-After`.
- **Footprint:** one process, no dependencies, an app under 1 MB. The token is kept in the login
  keychain; the server URL and the chosen provider in UserDefaults.
- English, Hungarian and German, after the system's language order.

## Requirements

- macOS 14 (Sonoma) or later.
- The Command Line Tools (`xcode-select --install`). Xcode is not needed, and neither is an Apple
  Developer account.

## Build and install

```bash
cd clients/macos
scripts/build-app.sh --install   # builds dist/UsageRatio.app, copies it to ~/Applications, opens it
```

Without `--install` it only builds `dist/UsageRatio.app`. The app is signed ad hoc. Built on the
Mac that runs it, it is never quarantined, so Gatekeeper opens it without a warning. A copy
downloaded from elsewhere would be blocked as from an "unidentified developer". Clear that with
`xattr -dr com.apple.quarantine UsageRatio.app` — or just build it yourself.

## First run

1. On the dashboard: **Settings → Tokens**, create a token with access **Read only (menu bar app)**,
   and copy it (it is shown once).
2. Click the gauge in the menu bar. The settings screen opens: enter the dashboard's address (e.g.
   `https://usage.example.com`) and paste the token, then **Save**.
3. Optionally switch on **Open at login**.

A read token can look the figures up and nothing else: a report sent with it is refused
(`403 read_only_token`), so one that leaks from this Mac cannot write fake usage. Revoke it on the
same dashboard page.

After a rebuild the keychain sees a different app (an ad-hoc signature changes with every build):
macOS asks once whether UsageRatio may read its token. Choose **Always Allow**.

## Claude's own usage

Besides the dashboard's figures the app can send the weekly usage your subscriptions report
themselves, so the dashboard shows the official percentage instead of an estimate. For this the token
must be an **official** one (one that may report), not the read-only token.

- **Codex** needs nothing: the app reads the limits Codex writes into its own session logs
  (`~/.codex/sessions`).
- **Claude Code** hands its limits to every status line. `scripts/statusline-tee.sh` (installed to
  `~/.usageratio/statusline-tee.sh` by `build-app.sh --install`) runs your own status line command
  unchanged, with the same input, passes its output and exit code through byte for byte, and saves
  the limits to `~/.usageratio/claude-limits.json`, where the app reads them. It does not touch the
  network or any credential, and a failure while saving never affects the status line.

Wrap your status line command in `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "~/.usageratio/statusline-tee.sh ~/.claude/statusline.sh" }
```

Your own script is not changed and the status line looks the same. To undo, put the old command
back. Settings → Sources shows whether each source has been seen.

## Develop

```bash
swift build && .build/debug/UsageRatioBar   # run without bundling (no Info.plist: the code hides the Dock icon itself)
scripts/test.sh                             # the tests (Swift Testing)
```

`scripts/test.sh` is `swift test` plus the framework paths the Command Line Tools need for Swift
Testing; with Xcode installed it is plain `swift test`.

- `Sources/UsageRatioCore` — everything testable without AppKit: the payload (`StatusPayload`), the
  request (`StatusClient`), the wording (`Strings`) and the formatting (`Display`).
- `Sources/UsageRatioBar` — the app: `StatusStore` (polling, back-off, settings), the menu bar
  label, the popover, the settings screen, the keychain.
- The API contract is `../tests/fixtures/status-v1.json`: the server's tests check its answer has
  that shape, and `Tests/` that the app decodes it. Change both sides together.

## Uninstall

Quit it from the popover (⏻), delete `~/Applications/UsageRatio.app`, then remove the token:

```bash
security delete-generic-password -s UsageRatioBar
defaults delete io.github.usageratio.bar
```

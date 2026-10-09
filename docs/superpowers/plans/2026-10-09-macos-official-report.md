# macOS app: read and upload the providers' own usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The menu bar app reads Claude's and Codex's own subscription usage on this Mac and uploads the weekly figure to `POST /api/official-usage/report` on every five-minute poll and on ↻, and shows the 5-hour window, any refusal, and when the server moved a provider's cycle.

**Architecture:** Parsing and decisions live in `UsageRatioCore` (testable without AppKit): a Claude snapshot parser (the JSON a status-line pass-through writes), a Codex session-log parser, the report request/answer, and the upload policy. The app target only finds the files, calls the core, and draws. Claude's figures come from a pass-through command (`clients/macos/scripts/statusline-tee.sh`) that saves what Claude Code hands its status line and then runs the user's own status line script unchanged, byte for byte — the user's `~/.claude/statusline.sh` is never edited.

**Tech Stack:** Swift 6 / SwiftUI (`MenuBarExtra`), SwiftPM, Swift Testing (`clients/macos/scripts/test.sh`), bash + jq, Vitest for the shell script.

**Spec:** `docs/superpowers/specs/2026-10-09-official-usage-report-design.md` (Part 3). Builds on plans 1–4: `GET /api/status` gives each provider its own `cycle`; `POST /api/official-usage/report` exists; tokens have an `official` scope.

## Global Constraints

- **Never edit `~/.claude/statusline.sh`.** The status line must look exactly as it does now. The only change outside the repo is one line in `~/.claude/settings.json` (`statusLine.command`), made by the controller at the very end, after the user has seen the exact diff and approved it.
- No provider credentials: never read Claude Code's keychain item, never call an Anthropic or OpenAI endpoint. Inputs are only `~/.usageratio/claude-limits.json` and `~/.codex/sessions/**/rollout-*.jsonl`.
- Claude snapshot file (written by the pass-through): `{"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600},"seven_day":{"used_percentage":41.2,"resets_at":1738857600}},"observed_at":1738400000.123}` — `resets_at` epoch seconds, `observed_at` epoch seconds (jq's `now`, fractional); each window may be absent.
- Codex: each `rollout-*.jsonl` line is a JSON object with an ISO `timestamp`; `token_count` events carry `rate_limits` (under `payload`, or at the top level in older builds) with `primary` / `secondary` windows of `{ used_percent, window_minutes, resets_at (epoch s) | resets_in_seconds }`. The weekly window has `window_minutes` 10000–10200 (10080), the 5-hour one 280–320 (300). The format is not verified on this Mac: parse tolerantly, never crash, treat anything unreadable as "no snapshot". Codex reports to the server as provider `openai` (the clients' parser maps `codex` there).
- Upload only the weekly window; a snapshot is uploaded once (the newest `observedAt` uploaded per provider is remembered in `UserDefaults`); the 5-hour window is shown, never uploaded.
- The compact card's layout stays; additions are single caption lines. Wording in English, Hungarian and German (`Strings.swift`, the app's three languages).
- The token the app uses must be an `official` one; a `read` token keeps working for the status but the upload says why it was refused.
- `clients/macos/scripts/test.sh` and `npm run check` pass at the end of every task. Never any AI attribution in commit messages.

---

### Task 1: snapshot parsers (core)

**Files:**
- Create: `clients/macos/Sources/UsageRatioCore/ProviderLimits.swift`
- Test: `clients/macos/Tests/UsageRatioCoreTests/ProviderLimitsTests.swift`

**Interfaces:**
- Produces:

```swift
public struct LimitWindow: Equatable, Sendable { public let usedPercent: Double; public let resetsAt: Date }
public struct LimitsSnapshot: Equatable, Sendable {
    /// The dashboard's provider id: "claude", or "openai" for Codex.
    public let providerId: String
    public let weekly: LimitWindow?
    public let fiveHour: LimitWindow?
    public let observedAt: Date
}
public enum ClaudeLimits { public static func parse(_ data: Data) -> LimitsSnapshot? }
public enum CodexLimits { public static func latest(inLog text: String) -> LimitsSnapshot? }
```

- [ ] **Step 1: Write the failing tests** — `ProviderLimitsTests.swift`:

```swift
import Foundation
import Testing
@testable import UsageRatioCore

@Test func readsTheClaudeSnapshot() throws {
    let json = """
    {"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600},
     "seven_day":{"used_percentage":41.2,"resets_at":1738857600}},"observed_at":1738400000.5}
    """
    let snapshot = try #require(ClaudeLimits.parse(Data(json.utf8)))
    #expect(snapshot.providerId == "claude")
    #expect(snapshot.weekly == LimitWindow(usedPercent: 41.2, resetsAt: Date(timeIntervalSince1970: 1_738_857_600)))
    #expect(snapshot.fiveHour?.usedPercent == 23.5)
    #expect(snapshot.observedAt == Date(timeIntervalSince1970: 1_738_400_000.5))
}

@Test func readsAClaudeSnapshotWithoutTheFiveHourWindow() throws {
    let json = #"{"rate_limits":{"seven_day":{"used_percentage":10,"resets_at":1738857600}},"observed_at":1738400000}"#
    let snapshot = try #require(ClaudeLimits.parse(Data(json.utf8)))
    #expect(snapshot.fiveHour == nil)
    #expect(snapshot.weekly?.usedPercent == 10)
}

@Test func refusesAnUnreadableClaudeSnapshot() {
    #expect(ClaudeLimits.parse(Data("not json".utf8)) == nil)
    #expect(ClaudeLimits.parse(Data(#"{"rate_limits":{}}"#.utf8)) == nil)
}

private let codexLog = """
{"timestamp":"2026-10-09T08:00:00.000Z","type":"session_meta","payload":{"id":"x"}}
{"timestamp":"2026-10-09T08:05:00.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{"primary":{"used_percent":12.0,"window_minutes":300,"resets_at":1791540000},"secondary":{"used_percent":33.5,"window_minutes":10080,"resets_at":1791900000}}}}
{"timestamp":"2026-10-09T08:06:00.000Z","type":"event_msg","payload":{"type":"agent_message","message":"hi"}}
not json at all
"""

@Test func readsTheNewestCodexRateLimits() throws {
    let snapshot = try #require(CodexLimits.latest(inLog: codexLog))
    #expect(snapshot.providerId == "openai")
    #expect(snapshot.weekly == LimitWindow(usedPercent: 33.5, resetsAt: Date(timeIntervalSince1970: 1_791_900_000)))
    #expect(snapshot.fiveHour?.usedPercent == 12.0)
    #expect(snapshot.observedAt == Date(timeIntervalSince1970: 1_791_533_100))
}

@Test func readsAnOlderCodexLineWithRelativeResetsAtTheTopLevel() throws {
    let log = #"{"timestamp":"2026-10-09T08:05:00Z","type":"token_count","rate_limits":{"primary":{"used_percent":5,"window_minutes":10080,"resets_in_seconds":3600}}}"#
    let snapshot = try #require(CodexLimits.latest(inLog: log))
    #expect(snapshot.weekly == LimitWindow(usedPercent: 5, resetsAt: Date(timeIntervalSince1970: 1_791_533_100 + 3600)))
    #expect(snapshot.fiveHour == nil)
}

@Test func findsNoCodexSnapshotInALogWithoutRateLimits() {
    #expect(CodexLimits.latest(inLog: "{\"timestamp\":\"2026-10-09T08:00:00Z\"}\n") == nil)
    #expect(CodexLimits.latest(inLog: "") == nil)
}
```

(`2026-10-09T08:05:00Z` is `1_791_533_100`.)

- [ ] **Step 2: Run** `clients/macos/scripts/test.sh` — FAIL (types missing).

- [ ] **Step 3: Implement** `ProviderLimits.swift` with `JSONSerialization` (tolerant of any shape):

```swift
import Foundation

/// One window of a provider's own subscription limit, as the provider's tool reported it.
public struct LimitWindow: Equatable, Sendable {
    public let usedPercent: Double
    public let resetsAt: Date

    public init(usedPercent: Double, resetsAt: Date) {
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
    }
}

/// What a provider's own tool last said about its limits on this Mac. Only the
/// weekly window is uploaded (POST /api/official-usage/report); the 5-hour one is shown.
public struct LimitsSnapshot: Equatable, Sendable {
    /// The dashboard's provider id: "claude", or "openai" for Codex.
    public let providerId: String
    public let weekly: LimitWindow?
    public let fiveHour: LimitWindow?
    public let observedAt: Date
}

private func number(_ value: Any?) -> Double? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
    let double = value.doubleValue
    return double.isFinite ? double : nil
}

/// The file Claude Code's status line pass-through writes (clients/macos/scripts/statusline-tee.sh):
/// Claude Code's own `rate_limits` (https://code.claude.com/docs/en/statusline) and when they were seen.
public enum ClaudeLimits {
    public static func parse(_ data: Data) -> LimitsSnapshot? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let limits = object["rate_limits"] as? [String: Any],
              let observed = number(object["observed_at"])
        else { return nil }
        func window(_ key: String) -> LimitWindow? {
            guard let entry = limits[key] as? [String: Any],
                  let percent = number(entry["used_percentage"]), let resetsAt = number(entry["resets_at"])
            else { return nil }
            return LimitWindow(usedPercent: percent, resetsAt: Date(timeIntervalSince1970: resetsAt))
        }
        let weekly = window("seven_day")
        let fiveHour = window("five_hour")
        guard weekly != nil || fiveHour != nil else { return nil }
        return LimitsSnapshot(
            providerId: "claude", weekly: weekly, fiveHour: fiveHour,
            observedAt: Date(timeIntervalSince1970: observed)
        )
    }
}

/// Codex's own session log (~/.codex/sessions/…/rollout-*.jsonl): its `token_count`
/// events carry the account's `rate_limits`. Read from the end: the newest one wins.
public enum CodexLimits {
    private static let weeklyMinutes = 10_000...10_200
    private static let fiveHourMinutes = 280...320

    public static func latest(inLog text: String) -> LimitsSnapshot? {
        for line in text.split(separator: "\n", omittingEmptySubsequences: true).reversed() {
            guard line.contains("rate_limits"), let snapshot = parse(line: line) else { continue }
            return snapshot
        }
        return nil
    }

    private static func parse(line: Substring) -> LimitsSnapshot? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let stamp = object["timestamp"] as? String,
              let observedAt = parseDate(stamp)
        else { return nil }
        let payload = object["payload"] as? [String: Any]
        guard let limits = (payload?["rate_limits"] ?? object["rate_limits"]) as? [String: Any] else { return nil }

        var weekly: LimitWindow?
        var fiveHour: LimitWindow?
        for key in ["primary", "secondary"] {
            guard let entry = limits[key] as? [String: Any],
                  let percent = number(entry["used_percent"]),
                  let minutes = number(entry["window_minutes"]).map({ Int($0) })
            else { continue }
            let resetsAt: Date
            if let absolute = number(entry["resets_at"]) {
                resetsAt = Date(timeIntervalSince1970: absolute)
            } else if let relative = number(entry["resets_in_seconds"]) {
                resetsAt = observedAt.addingTimeInterval(relative)
            } else {
                continue
            }
            let window = LimitWindow(usedPercent: percent, resetsAt: resetsAt)
            if weeklyMinutes.contains(minutes) { weekly = window }
            if fiveHourMinutes.contains(minutes) { fiveHour = window }
        }
        guard weekly != nil || fiveHour != nil else { return nil }
        return LimitsSnapshot(providerId: "openai", weekly: weekly, fiveHour: fiveHour, observedAt: observedAt)
    }

    private static func parseDate(_ text: String) -> Date? {
        (try? Date(text, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
            ?? (try? Date(text, strategy: .iso8601))
    }
}
```

`LimitsSnapshot` needs a public memberwise `init` for the app and tests (add it like `LimitWindow`'s).

- [ ] **Step 4: Run** `clients/macos/scripts/test.sh` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(macos): read Claude's and Codex's own usage limits"`

---

### Task 2: the report call and the upload policy (core)

**Files:**
- Create: `clients/macos/Sources/UsageRatioCore/OfficialReportClient.swift`
- Test: `clients/macos/Tests/UsageRatioCoreTests/OfficialReportTests.swift`

**Interfaces:**
- Consumes: `LimitsSnapshot` (Task 1), `StatusError` (existing).
- Produces:

```swift
public struct ResetMoment: Equatable, Sendable, Codable { public let weekday: Int; public let hour: Int; public let minute: Int }
public enum OfficialReportRefusal: String, Equatable, Sendable, Codable { case notOfficialToken, periodNotWeekly, staleReading }
public enum OfficialReportOutcome: Equatable, Sendable {
    case accepted(saved: Bool, movedTo: ResetMoment?)
    case refused(OfficialReportRefusal)
}
public struct OfficialReportClient: Sendable {
    public init(session: URLSession = URLSession(configuration: .ephemeral))
    public static func reportURL(base: URL) -> URL            // base/api/official-usage/report
    public static func body(for snapshot: LimitsSnapshot) -> Data?   // nil without a weekly window
    public static func outcome(status: Int, data: Data) throws(StatusError) -> OfficialReportOutcome
    public func send(_ snapshot: LimitsSnapshot, base: URL, token: String) async throws(StatusError) -> OfficialReportOutcome
}
public enum UploadPolicy {
    /// A weekly figure newer than the last one uploaded for that provider.
    public static func shouldUpload(_ snapshot: LimitsSnapshot, lastUploaded: Date?) -> Bool
}
```

- [ ] **Step 1: Write the failing tests** — `OfficialReportTests.swift`:

```swift
import Foundation
import Testing
@testable import UsageRatioCore

private let snapshot = LimitsSnapshot(
    providerId: "claude",
    weekly: LimitWindow(usedPercent: 41.2, resetsAt: Date(timeIntervalSince1970: 1_791_900_000)),
    fiveHour: nil,
    observedAt: Date(timeIntervalSince1970: 1_791_533_100.5)
)

@Test func buildsTheReportBody() throws {
    let body = try #require(OfficialReportClient.body(for: snapshot))
    let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
    #expect(json["providerId"] as? String == "claude")
    #expect(json["usedPercent"] as? Double == 41.2)
    #expect(json["resetsAtMs"] as? Int == 1_791_900_000_000)
    #expect(json["observedAtMs"] as? Int == 1_791_533_100_500)
    #expect(OfficialReportClient.reportURL(base: URL(string: "https://u.example.com")!).absoluteString
        == "https://u.example.com/api/official-usage/report")
}

@Test func sendsNothingWithoutAWeeklyWindow() {
    let fiveHourOnly = LimitsSnapshot(providerId: "claude", weekly: nil,
        fiveHour: snapshot.weekly, observedAt: snapshot.observedAt)
    #expect(OfficialReportClient.body(for: fiveHourOnly) == nil)
}

@Test func readsTheServersAnswer() throws {
    let moved = #"{"ok":true,"saved":true,"cycleChanged":true,"reset":{"weekday":4,"hour":9,"minute":0}}"#
    #expect(try OfficialReportClient.outcome(status: 200, data: Data(moved.utf8))
        == .accepted(saved: true, movedTo: ResetMoment(weekday: 4, hour: 9, minute: 0)))
    let same = #"{"ok":true,"saved":false,"cycleChanged":false,"reset":null}"#
    #expect(try OfficialReportClient.outcome(status: 200, data: Data(same.utf8)) == .accepted(saved: false, movedTo: nil))
    #expect(try OfficialReportClient.outcome(status: 403, data: Data(#"{"error":"official_scope_required"}"#.utf8))
        == .refused(.notOfficialToken))
    #expect(try OfficialReportClient.outcome(status: 409, data: Data(#"{"error":"period_not_weekly"}"#.utf8))
        == .refused(.periodNotWeekly))
    #expect(try OfficialReportClient.outcome(status: 409, data: Data(#"{"error":"stale_reading"}"#.utf8))
        == .refused(.staleReading))
    #expect(throws: StatusError.unauthorized) { try OfficialReportClient.outcome(status: 401, data: Data()) }
    #expect(throws: StatusError.server(status: 503)) { try OfficialReportClient.outcome(status: 503, data: Data()) }
}

@Test func uploadsOnlyANewerWeeklyFigure() {
    #expect(UploadPolicy.shouldUpload(snapshot, lastUploaded: nil))
    #expect(!UploadPolicy.shouldUpload(snapshot, lastUploaded: snapshot.observedAt))
    #expect(UploadPolicy.shouldUpload(snapshot, lastUploaded: snapshot.observedAt.addingTimeInterval(-1)))
    let noWeekly = LimitsSnapshot(providerId: "claude", weekly: nil, fiveHour: nil, observedAt: .now)
    #expect(!UploadPolicy.shouldUpload(noWeekly, lastUploaded: nil))
}
```

- [ ] **Step 2: Run** `clients/macos/scripts/test.sh` — FAIL.

- [ ] **Step 3: Implement** `OfficialReportClient.swift`, mirroring `StatusClient`'s style (ephemeral session, 20 s timeout, `Authorization: Bearer`, `Content-Type: application/json`):
  - `body(for:)`: `nil` without `weekly`; else `JSONSerialization` of `providerId`, `usedPercent`, `resetsAtMs` = `Int((weekly.resetsAt.timeIntervalSince1970 * 1000).rounded())`, `observedAtMs` likewise.
  - `outcome(status:data:)`: 200 → decode `saved` (Bool) and `reset` (`ResetMoment?`, null when absent) into `.accepted`; 403 with `error == "official_scope_required"` or `"read_only_token"` → `.refused(.notOfficialToken)`; 409 → `.refused(.periodNotWeekly)` / `.refused(.staleReading)` by `error`; 401 → throw `.unauthorized`; 429 → throw `.rateLimited(retryAfter: nil)`; any other status, or a 200/403/409 body it cannot read → throw `.server(status:)` / `.invalidResponse`.
  - `send`: build the request, map transport errors to `.network`, return `outcome(status:data:)`.
  - `UploadPolicy.shouldUpload`: `snapshot.weekly != nil && (lastUploaded == nil || snapshot.observedAt > lastUploaded!)`.

- [ ] **Step 4: Run** `clients/macos/scripts/test.sh` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(macos): send a provider's own weekly figure to the server"`

---

### Task 3: each provider's own cycle, and the new wording (core)

**Files:**
- Modify: `clients/macos/Sources/UsageRatioCore/StatusPayload.swift` (`Provider.cycle`, optional)
- Modify: `clients/macos/Sources/UsageRatioCore/Display.swift` (`cycle(of:in:)`, `fiveHourText`, `momentText`, `uploadNoteText`)
- Modify: `clients/macos/Sources/UsageRatioCore/Strings.swift` (new fields in `en`, `hu`, `de`; token wording)
- Test: `StatusPayloadTests.swift`, `DisplayTests.swift`

**Interfaces:**
- Consumes: `LimitWindow`, `ResetMoment`, `OfficialReportRefusal` (Tasks 1–2).
- Produces:
  - `StatusPayload.Provider.cycle: StatusPayload.ProviderCycle?` with `ProviderCycle { start: Date; end: Date }` (absent from a server before plan 1).
  - `Display.cycle(of provider: StatusPayload.Provider, in payload: StatusPayload) -> StatusPayload.Cycle` — the provider's own start/end with the payload's `period` and `timeZone`, else `payload.cycle`.
  - `Display.fiveHourText(_ window: LimitWindow, strings: Strings) -> String` — e.g. en "5-hour window: 23% · resets 14:30".
  - `Display.momentText(_ moment: ResetMoment, strings: Strings) -> String` — weekday name and HH:MM, e.g. en "Thursday 09:00".
  - `Display.uploadNoteText(_ refusal: OfficialReportRefusal, strings: Strings) -> String`.
  - New `Strings` fields: `fiveHourWindow: (String, String) -> String` (percent, time), `uploadNotOfficialToken`, `uploadMonthly`, `uploadStale`, `cycleMoved: (String, String) -> String` (provider label, moment), `sourcesSection`, `sourceClaude`, `sourceCodex`, `sourceMissing`, `sourceSeen: (String) -> String` (relative time), `statusLineHint`, `copyStatusLineCommand`, `copied`. `tokenLabel` becomes the generic "Token" / "Token" / "Token"; `tokenHint` names the **official** access ("Read and upload official usage (menu bar app)" — the dashboard's `tokens_scope_official` wording in each language).

| field | en | hu | de |
|---|---|---|---|
| fiveHourWindow | `5-hour window: \($0) · resets \($1)` | `5 órás ablak: \($0) · nullázódik \($1)` | `5-Stunden-Fenster: \($0) · zurückgesetzt \($1)` |
| uploadNotOfficialToken | `Not uploaded: the token is not an official one (Settings → Tokens on the dashboard).` | `Nem töltöttem fel: a token nem „official” jogú (dashboard → Beállítások → Tokenek).` | `Nicht hochgeladen: kein Token mit „Offiziell“-Zugriff (Dashboard → Einstellungen → Tokens).` |
| uploadMonthly | `Not uploaded: the dashboard's cycle is monthly.` | `Nem töltöttem fel: a dashboard ciklusa havi.` | `Nicht hochgeladen: der Zyklus des Dashboards ist monatlich.` |
| uploadStale | `Not uploaded: the reading is from a window that is over.` | `Nem töltöttem fel: a mérés egy már lezárt ablakból való.` | `Nicht hochgeladen: der Wert stammt aus einem abgelaufenen Fenster.` |
| cycleMoved | `\($0)'s cycle now resets \($1)` | `\($0) ciklusa mostantól: \($1)` | `Zyklus von \($0) jetzt: \($1)` |
| sourcesSection | `Sources` | `Források` | `Quellen` |
| sourceClaude | `Claude (status line)` | `Claude (status line)` | `Claude (Statuszeile)` |
| sourceCodex | `Codex (session log)` | `Codex (munkamenet-napló)` | `Codex (Sitzungsprotokoll)` |
| sourceMissing | `not found` | `nincs meg` | `nicht gefunden` |
| sourceSeen | `seen \($0)` | `utoljára: \($0)` | `zuletzt \($0)` |
| statusLineHint | `Point Claude Code's status line at the pass-through; your own script runs unchanged.` | `Állítsd a Claude Code status line-ját az átvezető szkriptre; a saját szkripted változatlanul fut.` | `Leite die Statuszeile von Claude Code über das Durchreich-Skript; dein eigenes Skript läuft unverändert.` |
| copyStatusLineCommand | `Copy the settings line` | `Beállítás-sor másolása` | `Einstellungszeile kopieren` |
| copied | `Copied` | `Kimásolva` | `Kopiert` |

- [ ] **Step 1: Write the failing tests**
  - `StatusPayloadTests.swift`: the contract fixture (`clients/tests/fixtures/status-v1.json`, which plan 1 gave a per-provider `cycle`) decodes `claude.cycle?.start` to that fixture's value; a provider JSON without `cycle` decodes with `cycle == nil`.
  - `DisplayTests.swift`: `Display.cycle(of:in:)` returns the provider's own start/end when present and `payload.cycle` otherwise; `Display.fiveHourText(LimitWindow(usedPercent: 23.4, resetsAt: <a date at 14:30 in the test's time zone>), strings: .en)` == `"5-hour window: 23% · resets 14:30"` (use the same formatting helpers and time-zone handling the existing `DisplayTests` use for times); `Display.momentText(ResetMoment(weekday: 4, hour: 9, minute: 0), strings: .en) == "Thursday 09:00"` and `.hu` gives `"csütörtök 09:00"`; `Display.uploadNoteText(.periodNotWeekly, strings: .hu) == Strings.hu.uploadMonthly`.

- [ ] **Step 2: Run** `clients/macos/scripts/test.sh` — FAIL.
- [ ] **Step 3: Implement** — `ProviderCycle` decoded with `decodeIfPresent` in `Provider.init(from:)` (add `cycle` to `CodingKeys`); `Display` helpers (weekday name from `Calendar(identifier: .gregorian)` with `strings.locale`'s `standaloneWeekdaySymbols`, index = `weekday` (0 = Sunday), lower-cased for `hu`, as the dashboard writes it; time `String(format: "%02d:%02d", hour, minute)`); the five-hour time via the existing short-time formatting (`DateFormatter` with `strings.locale`, template `"jmm"`); the new `Strings` fields in all three languages.
- [ ] **Step 4: Run** `clients/macos/scripts/test.sh` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(macos): use each provider's own cycle, and word the uploads"`

---

### Task 4: the pass-through for Claude Code's status line

**Files:**
- Create: `clients/macos/scripts/statusline-tee.sh` (mode 0755)
- Modify: `clients/macos/scripts/build-app.sh` (`--install` also installs the script to `~/.usageratio/statusline-tee.sh`)
- Modify: `clients/macos/README.md` (a "Claude's own usage" section)
- Test: `tests/statusline-tee.test.ts`

**Interfaces:**
- Produces: `statusline-tee.sh <the user's status line command…>` — reads stdin, saves `{rate_limits, observed_at}` to `${USAGERATIO_DIR:-$HOME/.usageratio}/claude-limits.json` when a weekly figure is present, then runs the given command with the same stdin and passes its stdout, stderr and exit code through untouched.

- [ ] **Step 1: Write the failing test** — `tests/statusline-tee.test.ts`:

```ts
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEE = path.resolve("clients/macos/scripts/statusline-tee.sh");
const INPUT = JSON.stringify({
  model: { display_name: "Opus" },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
});

describe.skipIf(process.platform === "win32")("statusline-tee.sh", () => {
  let dir: string;
  let script: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "usageratio-tee-"));
    script = path.join(dir, "statusline.sh");
    // Stands in for the user's own status line: colours, no trailing newline, a non-zero exit.
    writeFileSync(script, '#!/bin/bash\ninput=$(cat)\nprintf "\\033[32m%s\\033[0m" "$(echo "$input" | jq -r .model.display_name)"\nexit 3\n', {
      mode: 0o755,
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (input: string, extraEnv: Record<string, string> = {}) =>
    spawnSync("bash", [TEE, script], { input, env: { ...process.env, USAGERATIO_DIR: dir, ...extraEnv } });

  it("prints exactly what the user's script prints, and keeps its exit code", () => {
    const direct = spawnSync(script, [], { input: INPUT });
    const through = run(INPUT);
    expect(through.stdout.equals(direct.stdout)).toBe(true);
    expect(through.stderr.toString()).toBe(direct.stderr.toString());
    expect(through.status).toBe(3);
  });

  it("saves the limits Claude Code handed over", () => {
    run(INPUT);
    const saved = JSON.parse(readFileSync(path.join(dir, "claude-limits.json"), "utf8"));
    expect(saved.rate_limits.seven_day.used_percentage).toBe(41.2);
    expect(typeof saved.observed_at).toBe("number");
  });

  it("keeps the last snapshot when a session has no weekly figure", () => {
    run(INPUT);
    const before = readFileSync(path.join(dir, "claude-limits.json"), "utf8");
    run(JSON.stringify({ model: { display_name: "Opus" } }));
    expect(readFileSync(path.join(dir, "claude-limits.json"), "utf8")).toBe(before);
  });

  it("still prints the status line when the snapshot cannot be written", () => {
    const blocked = path.join(dir, "blocked");
    writeFileSync(blocked, "a file, not a folder");
    const through = spawnSync("bash", [TEE, script], { input: INPUT, env: { ...process.env, USAGERATIO_DIR: blocked } });
    expect(through.stdout.toString()).toContain("Opus");
    expect(through.status).toBe(3);
    expect(existsSync(path.join(blocked, "claude-limits.json"))).toBe(false);
  });

  it("passes the bytes through even without a weekly figure", () => {
    const plain = JSON.stringify({ model: { display_name: "Sonnet" } });
    expect(run(plain).stdout.equals(spawnSync(script, [], { input: plain }).stdout)).toBe(true);
  });
});
```

(`execFileSync` may end up unused: drop it if Biome complains.)

- [ ] **Step 2: Run** `npx vitest run tests/statusline-tee.test.ts` — FAIL (script missing).

- [ ] **Step 3: Implement** `clients/macos/scripts/statusline-tee.sh`:

```bash
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
```

(`$(cat)` drops trailing newlines of the input: the input is JSON, so nothing is lost for the user's script, which reads it the same way.)

`build-app.sh`, inside `if $install; then`, before `open`:

```bash
  # The pass-through for Claude Code's status line (README: "Claude's own usage").
  mkdir -p "$HOME/.usageratio"
  install -m 0755 scripts/statusline-tee.sh "$HOME/.usageratio/statusline-tee.sh"
```

`README.md`: a section "Claude's own usage" — what the pass-through does, the one `settings.json` line, that the user's own script is not changed and the status line looks the same, how to undo (put the old command back), and that Codex needs nothing (its own session logs are read). Also that the app needs an **official** token.

- [ ] **Step 4: Run** `npx vitest run tests/statusline-tee.test.ts`, `shellcheck clients/macos/scripts/statusline-tee.sh` (if installed), `npm run check` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(macos): pass Claude Code's status line through and keep its limits"`

---

### Task 5: the app reads, uploads and shows

**Files:**
- Create: `clients/macos/Sources/UsageRatioBar/LimitSources.swift`
- Modify: `clients/macos/Sources/UsageRatioBar/StatusStore.swift`, `PopoverView.swift`, `SettingsView.swift`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (app-internal): `LimitSources.claude() -> SourceReading`, `LimitSources.codex() -> SourceReading` with `struct SourceReading { let snapshot: LimitsSnapshot?; let fileDate: Date? }` (`fileDate` nil: no file); `StatusStore.limits: [String: LimitsSnapshot]` (by provider id), `StatusStore.uploadNotes: [String: OfficialReportRefusal]`, `StatusStore.movedNotes: [String: ResetMoment]`, `StatusStore.sources: (claude: SourceReading, codex: SourceReading)`.

- [ ] **Step 1: `LimitSources.swift`**
  - Claude: `~/.usageratio/claude-limits.json` → `ClaudeLimits.parse`, `fileDate` from the file's modification date.
  - Codex: the newest `rollout-*.jsonl` under `~/.codex/sessions/` (respect `CODEX_HOME` if set in the app's environment): list the newest year/month/day folders first (at most the 3 newest day folders), pick the file with the newest modification date; read at most its last 512 KB (`FileHandle`, seek to `max(0, size − 512 KB)`), decode as UTF-8 (lossy), drop the first partial line when it started mid-file, `CodexLimits.latest(inLog:)`.
  - Everything off the main actor (`Task.detached`) and failure-tolerant: any error is "no snapshot".

- [ ] **Step 2: `StatusStore`** — in `refresh()`, after the server URL and token are known and before `client.fetch`:

```swift
let readings = await LimitSources.readAll()          // (claude, codex)
sources = readings
limits = Dictionary(uniqueKeysWithValues: [readings.claude.snapshot, readings.codex.snapshot].compactMap { $0 }.map { ($0.providerId, $0) })
for snapshot in limits.values where UploadPolicy.shouldUpload(snapshot, lastUploaded: lastUploaded(snapshot.providerId)) {
    do {
        switch try await reporter.send(snapshot, base: serverURL, token: token) {
        case .accepted(_, let movedTo):
            setLastUploaded(snapshot.providerId, snapshot.observedAt)
            uploadNotes[snapshot.providerId] = nil
            if let movedTo { movedNotes[snapshot.providerId] = movedTo }
        case .refused(let refusal):
            uploadNotes[snapshot.providerId] = refusal
            // A stale reading will never be accepted: do not retry it every five minutes.
            if refusal == .staleReading { setLastUploaded(snapshot.providerId, snapshot.observedAt) }
        }
    } catch {
        // Network or server trouble: the status lookup below reports it; the next poll retries the upload.
    }
}
```

  `lastUploaded`/`setLastUploaded` keep a `[String: Double]` (epoch seconds) in `UserDefaults` under a new key `lastUploadedLimits`. `reporter` is an `OfficialReportClient()` next to `client`. `movedNotes` live for the app's session only (shown once until the popover is closed: clear a provider's entry when the popover disappears — `PopoverView.onDisappear { store.dismissMovedNotes() }`). The preview initializer leaves all of this empty.

- [ ] **Step 3: `PopoverView`**
  - Use `Display.cycle(of: provider, in: payload)` everywhere the card used `payload.cycle` (header period text, pace bar's elapsed, the reset fact).
  - Under the facts (inside `facts`), for the selected provider:
    - `if let window = store.limits[provider.id]?.fiveHour, window.resetsAt > store.now` → a `Label(Display.fiveHourText(window, strings: strings), systemImage: "hourglass")`, secondary colour.
    - `if let refusal = store.uploadNotes[provider.id]` → `Label(Display.uploadNoteText(refusal, strings: strings), systemImage: "icloud.slash")`, secondary colour, wrapping.
    - `if let moved = store.movedNotes[provider.id]` → `Label(strings.cycleMoved(provider.label, Display.momentText(moved, strings: strings)), systemImage: "calendar.badge.clock")`, secondary colour.
  - The ↻ button keeps calling `store.restart()`, which now reads, uploads and fetches.
- [ ] **Step 4: `SettingsView`** — a "Sources" section between Connection and General: one row each for Claude and Codex, `Text(source name)` and on the right `sourceSeen(relative)` from the snapshot's `observedAt` (or the file date), or `sourceMissing`. Under the Claude row, when it is missing: `strings.statusLineHint` and a small button `copyStatusLineCommand` that puts `"command": "~/.usageratio/statusline-tee.sh ~/.claude/statusline.sh"` on the pasteboard (`NSPasteboard.general`), showing `copied` for two seconds.
- [ ] **Step 5: Build and look**
  - `clients/macos/scripts/test.sh` — PASS; `swift build -c release` in `clients/macos` — no warnings from the new code.
  - Render the popover offscreen, as before for this app: in a scratch copy of `clients/macos` (under `/private/tmp/claude-501/-Users-snktibor-Documents-Projects-usageratio/7c55f64d-b744-4206-86e3-c205ccd3b675/scratchpad/`), a tiny executable that builds a `StatusStore(preview:…)` with a payload from `clients/tests/fixtures/status-v1.json`, sets a Claude snapshot with a 5-hour window, an upload refusal and a moved note (add `#if DEBUG` setters to the preview initializer if needed), hosts `PopoverView` and `SettingsView` in `NSHostingView`, and writes PNGs via `cacheDisplay(in:to:)` — for `en` and `hu`. Look at each PNG: the card's layout unchanged except the new caption lines; nothing truncated in Hungarian. Never touch the user's running menu bar app or keychain.
- [ ] **Step 6: Commit** — `git commit -m "feat(macos): upload the providers' own weekly usage and show the 5-hour window"`

---

### Task 6: hand-over (controller, with the user)

- [ ] **Step 1:** Show the user the exact `~/.claude/settings.json` change (read the file; only the `statusLine.command` value changes, from `~/.claude/statusline.sh` to `~/.usageratio/statusline-tee.sh ~/.claude/statusline.sh`) and wait for an explicit yes. On yes: back the file up to `~/.claude/settings.json.bak-usageratio`, make the one-line edit, and validate it parses as JSON.
- [ ] **Step 2:** `clients/macos/scripts/build-app.sh --install` (installs the app and the pass-through). Only after the user agrees, since it restarts their menu bar app.
- [ ] **Step 3:** Ask the user to create an **official** token on the dashboard and paste it into the app's settings, then to send one Claude Code message (so the status line writes the snapshot) and press ↻. Check together: `~/.usageratio/claude-limits.json` exists; the dashboard shows Claude's official percentage; Settings shows Claude's own reset with "Set by the menu bar app".

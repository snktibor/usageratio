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

@Test func neverTrapsOnOddNumbersInTheClaudeFile() throws {
    let huge = #"{"rate_limits":{"seven_day":{"used_percentage":10,"resets_at":1e300}},"observed_at":1738400000}"#
    #expect(ClaudeLimits.parse(Data(huge.utf8)) == nil)
    let observed = #"{"rate_limits":{"seven_day":{"used_percentage":10,"resets_at":1738857600}},"observed_at":1e300}"#
    #expect(ClaudeLimits.parse(Data(observed.utf8)) == nil)
}

@Test func neverTrapsOnOddNumbersInTheCodexLog() {
    func line(_ entry: String) -> String {
        #"{"timestamp":"2026-10-09T08:05:00Z","payload":{"rate_limits":{"primary":"# + entry + "}}}"
    }
    #expect(CodexLimits.latest(inLog: line(#"{"used_percent":5,"window_minutes":1e300,"resets_at":1791900000}"#)) == nil)
    #expect(CodexLimits.latest(inLog: line(#"{"used_percent":5,"window_minutes":10080,"resets_at":1e300}"#)) == nil)
    #expect(CodexLimits.latest(inLog: line(#"{"used_percent":5,"window_minutes":10080,"resets_in_seconds":1e300}"#)) == nil)
}

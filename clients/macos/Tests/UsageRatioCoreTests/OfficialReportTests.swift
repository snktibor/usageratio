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

@Test func buildsNoBodyForNumbersTheServerWouldRefuseOrThatTrap() {
    func body(percent: Double = 41.2, resets: Double = 1_791_900_000, observed: Double = 1_791_533_100) -> Data? {
        OfficialReportClient.body(for: LimitsSnapshot(
            providerId: "claude",
            weekly: LimitWindow(usedPercent: percent, resetsAt: Date(timeIntervalSince1970: resets)),
            fiveHour: nil, observedAt: Date(timeIntervalSince1970: observed)))
    }
    #expect(body() != nil)
    #expect(body(percent: 1001) == nil)
    #expect(body(percent: -1) == nil)
    #expect(body(resets: 1e300) == nil)
    #expect(body(observed: 1e300) == nil)
}

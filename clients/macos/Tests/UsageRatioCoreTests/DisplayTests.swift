import Foundation
import Testing
@testable import UsageRatioCore

private let now = Date(timeIntervalSince1970: 1_791_364_320)

private func provider(
    id: String = "claude",
    percent: Double? = 50,
    pace: StatusPayload.Pace? = nil,
    lastReportAt: Date? = now
) -> StatusPayload.Provider {
    let pace = pace.map { "{\"projectedPercent\": \($0.projectedPercent.map { "\($0)" } ?? "null"), \"runOutAt\": \($0.runOutAt == nil ? "null" : "\"2026-10-11T15:00:00Z\"")}" } ?? "null"
    let json = """
    {"v":1,"generatedAt":"2026-10-07T09:12:00Z",
     "cycle":{"period":"weekly","start":"2026-10-05T07:00:00Z","end":"2026-10-12T07:00:00Z","timeZone":"UTC"},
     "providers":[{"id":"\(id)","label":"X","percent":\(percent.map { "\($0)" } ?? "null"),"source":null,
       "estimatedPercent":null,"asOf":"2026-10-07T09:12:00Z","tokens":1,"limit":null,"status":null,
       "pace":\(percent == nil ? "null" : pace),"subLimits":[],
       "lastReportAt":\(lastReportAt == nil ? "null" : "\"\(lastReportAt!.ISO8601Format())\"")}]}
    """
    return try! StatusPayload.decode(Data(json.utf8)).providers[0]
}

@Test func formatsThePercentage() {
    #expect(Display.percentText(62.4) == "62%")
    #expect(Display.percentText(112.6) == "113%")
    #expect(Display.percentText(nil) == "–")
}

@Test func movesTheGaugeNeedle() {
    #expect(Display.gaugeSymbol(nil) == "gauge.with.dots.needle.0percent")
    #expect(Display.gaugeSymbol(10) == "gauge.with.dots.needle.0percent")
    #expect(Display.gaugeSymbol(62) == "gauge.with.dots.needle.67percent")
    #expect(Display.gaugeSymbol(140) == "gauge.with.dots.needle.100percent")
}

@Test func fallsBackToTheFirstProvider() throws {
    let payload = try StatusPayload.decode(Data(contentsOf: URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "tests/fixtures/status-v1.json")))
    #expect(Display.selectedProvider(in: payload, id: "codex")?.id == "codex")
    #expect(Display.selectedProvider(in: payload, id: "gone")?.id == "claude")
    #expect(Display.selectedProvider(in: payload, id: nil)?.id == "claude")
    #expect(Display.selectedProvider(in: nil, id: "claude") == nil)
}

@Test func dimsAStaleFigure() {
    let fresh = provider(lastReportAt: now.addingTimeInterval(-3600))
    #expect(!Display.isStale(fresh, lastSuccess: now, now: now))
    #expect(Display.isStale(fresh, lastSuccess: now.addingTimeInterval(-3 * 3600), now: now))
    #expect(Display.isStale(provider(lastReportAt: now.addingTimeInterval(-3 * 3600)), lastSuccess: now, now: now))
    #expect(!Display.isStale(provider(lastReportAt: nil), lastSuccess: now, now: now))
    #expect(!Display.isStale(fresh, lastSuccess: nil, now: now))
}

@Test func describesThePace() {
    let strings = Strings.en
    #expect(Display.paceLine(provider(percent: nil), strings: strings) == nil)
    #expect(Display.paceLine(provider(pace: .init(projectedPercent: nil, runOutAt: nil)), strings: strings)
        == strings.paceTooEarly)
    #expect(Display.paceLine(provider(pace: .init(projectedPercent: 80, runOutAt: nil)), strings: strings)
        == "At this pace ~80% by the reset")
    let runsOut = Display.paceLine(provider(pace: .init(projectedPercent: 130, runOutAt: now)), strings: strings)
    #expect(runsOut?.hasPrefix("At this pace ~130% by the reset; runs out ") == true)
}

@Test func countsDownToTheReset() {
    let text = Display.countdown(from: now, to: now.addingTimeInterval(3 * 86_400 + 4 * 3600 + 120), strings: .en)
    #expect(text == "3d 4h")
}

@Test func picksTheFirstSpokenLanguage() {
    #expect(Strings.forPreferredLanguages(["hu-HU", "en-US"]).languageCode == "hu")
    #expect(Strings.forPreferredLanguages(["fr-FR", "de-AT"]).languageCode == "de")
    #expect(Strings.forPreferredLanguages(["ja-JP"]).languageCode == "en")
}

@Test func namesEveryError() {
    let strings = Strings.hu
    #expect(strings.message(for: .server(status: 503)) == strings.errorStorage)
    #expect(strings.message(for: .server(status: 500)) == "A szerver hibával válaszolt (500).")
    #expect(strings.message(for: .rateLimited(retryAfter: 60)) == strings.errorRateLimited)
}

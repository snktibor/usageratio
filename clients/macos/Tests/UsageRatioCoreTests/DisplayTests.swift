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
    let fresh = now.addingTimeInterval(-3600)
    #expect(!Display.isStale(lastReportAt: fresh, lastSuccess: now, now: now))
    #expect(Display.isStale(lastReportAt: fresh, lastSuccess: now.addingTimeInterval(-3 * 3600), now: now))
    #expect(Display.isStale(lastReportAt: now.addingTimeInterval(-3 * 3600), lastSuccess: now, now: now))
    #expect(!Display.isStale(lastReportAt: nil, lastSuccess: now, now: now))
    #expect(!Display.isStale(lastReportAt: fresh, lastSuccess: nil, now: now))
}

private func fixturePayload() throws -> StatusPayload {
    try StatusPayload.decode(Data(contentsOf: URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "tests/fixtures/status-v1.json")))
}

@Test func showsAGroupsOrAMachinesPart() throws {
    let claude = try fixturePayload().providers[0]

    let total = Display.figure(of: claude, scope: .total)
    #expect(total == MenuBarFigure(name: nil, percent: 62.4, status: .warning, lastReportAt: claude.lastReportAt))

    let machine = Display.figure(of: claude, scope: .machine("macbook"))
    #expect(machine.name == "macbook")
    #expect(machine.percent == 8.3)
    #expect(machine.status == .good)
    #expect(machine.lastReportAt == claude.machines[1].lastReportAt)

    // A group is as fresh as its newest machine.
    let group = Display.figure(of: claude, scope: .group("Personal"))
    #expect(group.percent == 41.6)
    #expect(group.lastReportAt == claude.machines[0].lastReportAt)

    // Gone from the list: the provider's own figure.
    #expect(Display.figure(of: claude, scope: .machine("sold-laptop")) == total)
}

@Test func warnsForAPartAtTheDashboardsLevels() {
    #expect(Display.shareStatus(nil) == nil)
    #expect(Display.shareStatus(79.9) == .good)
    #expect(Display.shareStatus(80) == .warning)
    #expect(Display.shareStatus(100) == .critical)
}

@Test func storesTheScope() {
    for scope in [MenuBarScope.total, .group("Personal"), .machine("mac:studio")] {
        #expect(MenuBarScope(storage: scope.storage) == scope)
    }
    #expect(MenuBarScope(storage: "group:") == .total)
    #expect(MenuBarScope(storage: "rubbish") == .total)
    #expect(MenuBarScope(storage: nil) == .total)
}

@Test func namesAPartInThePicker() {
    #expect(Display.shareText(name: "mac", percent: 23.46, tokens: 1, strings: .hu) == "mac · 23,5%")
    #expect(Display.shareText(name: "mac", percent: nil, tokens: 30_000, strings: .en) == "mac · 30K tokens")
}

@Test func describesWhenItRunsOut() {
    let strings = Strings.en
    #expect(Display.runOutText(provider(percent: nil), strings: strings) == nil)
    #expect(Display.runOutText(provider(pace: .init(projectedPercent: nil, runOutAt: nil)), strings: strings)
        == strings.tooEarly)
    #expect(Display.runOutText(provider(pace: .init(projectedPercent: 80, runOutAt: nil)), strings: strings)
        == strings.lastsUntilReset)
    let runsOut = Display.runOutText(provider(pace: .init(projectedPercent: 130, runOutAt: now)), strings: strings)
    // The helper's runOutAt, in this Mac's time zone.
    let runOutAt = try! Date("2026-10-11T15:00:00Z", strategy: .iso8601)
    #expect(runsOut == "Runs out \(Display.shortDate(runOutAt, strings: strings))")
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

@Test func saysNowForUnderAMinute() {
    #expect(Display.relative(now.addingTimeInterval(2), now: now, strings: .en) == "now")
    #expect(Display.relative(now.addingTimeInterval(-30), now: now, strings: .hu) == "most")
    #expect(Display.relative(now.addingTimeInterval(-300), now: now, strings: .en) == "5 min. ago")
}

@Test func measuresTheCycle() throws {
    let cycle = try fixturePayload().cycle
    // A week from Monday 07:00: two and a half days later is about 36%.
    #expect(abs(Display.elapsedPercent(cycle, now: cycle.start.addingTimeInterval(2.5 * 86_400)) - 35.714) < 0.01)
    #expect(Display.elapsedPercent(cycle, now: cycle.start.addingTimeInterval(-60)) == 0)
    #expect(Display.elapsedPercent(cycle, now: cycle.end.addingTimeInterval(3600)) == 100)
}

@Test func statesWhatIsLeft() {
    #expect(Display.remainingText(62.4, strings: .hu) == "37,6% maradt")
    #expect(Display.remainingText(112.5, strings: .en) == "Over by 12.5%")
    #expect(Display.remainingText(nil, strings: .en) == nil)
}

@Test func scalesTheRowsToTheHeaviest() {
    #expect(Display.barFractions([22.3, 11.15, 0]) == [1, 0.5, 0])
    #expect(Display.barFractions([0, 0]) == [0, 0])
    #expect(Display.barFractions([]) == [])
}


@Test func nestsTheMachinesUnderTheirGroups() throws {
    let claude = try fixturePayload().providers[0]
    let (rows, hidden) = Display.breakdown(claude, limit: 8)
    #expect(hidden == 0)
    #expect(rows.map(\.id) == ["Personal", "mac-studio", "macbook", "Work", "work-pc"])
    #expect(rows.map(\.kind) == [.group, .machine, .machine, .group, .machine])
    // Every bar against the heaviest group, so a machine's bar is a part of its group's.
    #expect(rows[0].fraction == 1)
    #expect(abs(rows[1].fraction - 33.3 / 41.6) < 0.001)
    #expect(rows[2].lastReportAt == claude.machines[1].lastReportAt)
    #expect(rows[0].lastReportAt == nil)
    #expect(rows[3].scope == .group("Work"))
    #expect(rows[4].scope == .machine("work-pc"))

    // The cap counts machines, not groups: the groups still all appear.
    let (capped, left) = Display.breakdown(claude, limit: 2)
    #expect(capped.map(\.id) == ["Personal", "mac-studio", "macbook", "Work"])
    #expect(left == 1)
}

@Test func listsTheMachinesAloneUnderOneGroup() throws {
    let json = """
    {"v":1,"generatedAt":"2026-10-07T09:12:00Z",
     "cycle":{"period":"weekly","start":"2026-10-05T07:00:00Z","end":"2026-10-12T07:00:00Z","timeZone":"UTC"},
     "providers":[{"id":"claude","label":"X","percent":null,"source":null,"estimatedPercent":null,
       "asOf":"2026-10-07T09:12:00Z","tokens":30,"limit":null,"status":null,"pace":null,"subLimits":[],
       "groups":[{"id":"Solo","percent":null,"tokens":30}],
       "machines":[{"id":"a","groupId":"Solo","percent":null,"tokens":20,"lastReportAt":"2026-10-07T09:00:00Z"},
                   {"id":"b","groupId":"Solo","percent":null,"tokens":10,"lastReportAt":"2026-10-07T09:00:00Z"}],
       "lastReportAt":"2026-10-07T09:00:00Z"}]}
    """
    let solo = try StatusPayload.decode(Data(json.utf8)).providers[0]
    let (rows, hidden) = Display.breakdown(solo, limit: 8)
    #expect(rows.map(\.id) == ["a", "b"])
    #expect(rows.allSatisfy { $0.kind == .machine })
    // No percentage: the bars follow the tokens, against the heaviest machine.
    #expect(rows.map(\.fraction) == [1, 0.5])
    #expect(hidden == 0)
    #expect(Display.breakdown(provider(percent: 50), limit: 8).rows.isEmpty)
}

@Test func statesTheTokensAgainstTheLimit() {
    #expect(Display.tokensOfLimitText(41_200_000, limit: 70_000_000, strings: .en) == "41M / 70M tokens")
    #expect(Display.tokensOfLimitText(1_500_000, limit: nil, strings: .en) == "1.5M tokens")
    #expect(Display.tokensOfLimitText(1_500_000, limit: 0, strings: .en) == "1.5M tokens")
}

@Test func namesTheStatus() {
    #expect(Display.statusText(.good, strings: .hu) == "Rendben")
    #expect(Display.statusText(.warning, strings: .en) == "Warning")
    #expect(Display.statusText(.critical, strings: .de) == "Kritisch")
}

@Test func usesTheProvidersOwnCycle() throws {
    let json = """
    {"v":1,"generatedAt":"2026-10-07T09:12:00Z",
     "cycle":{"period":"weekly","start":"2026-10-05T07:00:00Z","end":"2026-10-12T07:00:00Z","timeZone":"UTC"},
     "providers":[{"id":"claude","label":"X","cycle":{"start":"2026-10-08T07:00:00Z","end":"2026-10-15T07:00:00Z"},
       "percent":null,"source":null,"estimatedPercent":null,"asOf":"2026-10-07T09:12:00Z","tokens":1,"limit":null,
       "status":null,"pace":null,"subLimits":[],"lastReportAt":null}]}
    """
    let payload = try StatusPayload.decode(Data(json.utf8))
    let cycle = Display.cycle(of: payload.providers[0], in: payload)
    #expect(cycle.start == Date(timeIntervalSince1970: 1_791_442_800))
    #expect(cycle.end == Date(timeIntervalSince1970: 1_792_047_600))
    #expect(cycle.period == "weekly" && cycle.timeZone == "UTC")
    // No cycle of its own (a server before it): the payload's.
    #expect(Display.cycle(of: provider(), in: payload) == payload.cycle)
}

@Test func wordsTheFiveHourWindow() {
    // 14:30 in this Mac's time zone, whatever it is.
    let resetsAt = Calendar.current.date(from: DateComponents(year: 2026, month: 10, day: 9, hour: 14, minute: 30))!
    let time = { (strings: Strings) in
        let formatter = DateFormatter()
        formatter.locale = strings.locale
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        return formatter.string(from: resetsAt)
    }
    let window = LimitWindow(usedPercent: 23.4, resetsAt: resetsAt)
    #expect(Display.fiveHourText(window, strings: .en) == "5-hour window: 23% · resets \(time(.en))")
    #expect(Display.fiveHourText(window, strings: .hu) == "5 órás ablak: 23% · nullázódik \(time(.hu))")
    #expect(time(.hu).contains("14:30"))
}

@Test func wordsTheResetMoment() {
    let thursday = ResetMoment(weekday: 4, hour: 9, minute: 0)
    #expect(Display.momentText(thursday, strings: .en) == "Thursday 09:00")
    #expect(Display.momentText(thursday, strings: .hu) == "csütörtök 09:00")
    #expect(Display.momentText(ResetMoment(weekday: 0, hour: 23, minute: 5), strings: .de) == "Sonntag 23:05")
}

@Test func wordsWhyAnUploadWasRefused() {
    #expect(Display.uploadNoteText(.periodNotWeekly, strings: .hu) == Strings.hu.uploadMonthly)
    #expect(Display.uploadNoteText(.notOfficialToken, strings: .en) == Strings.en.uploadNotOfficialToken)
    #expect(Display.uploadNoteText(.staleReading, strings: .de) == Strings.de.uploadStale)
}

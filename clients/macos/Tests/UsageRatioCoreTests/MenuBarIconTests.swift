import Foundation
import Testing
@testable import UsageRatioCore

private let now = Date(timeIntervalSince1970: 1_791_364_320)
private let hour: TimeInterval = 3600

private func window(used: Double, resetsIn: TimeInterval) -> LimitWindow {
    LimitWindow(usedPercent: used, resetsAt: now.addingTimeInterval(resetsIn))
}

private func fixturePayload() throws -> StatusPayload {
    try StatusPayload.decode(Data(contentsOf: URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "tests/fixtures/status-v1.json")))
}

private func provider(machines: Int) throws -> StatusPayload.Provider {
    let rows = (0..<machines).map {
        "{\"id\":\"m\($0)\",\"groupId\":\"g\",\"percent\":1,\"tokens\":1,\"lastReportAt\":\"2026-10-07T09:00:00Z\"}"
    }
    let json = """
    {"v":1,"generatedAt":"2026-10-07T09:12:00Z",
     "cycle":{"period":"weekly","start":"2026-10-05T07:00:00Z","end":"2026-10-12T07:00:00Z","timeZone":"UTC"},
     "providers":[{"id":"claude","label":"Claude","percent":10,"source":null,"estimatedPercent":null,
       "asOf":"2026-10-07T09:12:00Z","tokens":1,"limit":null,"status":null,"pace":null,"subLimits":[],
       "groups":[{"id":"g","percent":10,"tokens":1}],"machines":[\(rows.joined(separator: ","))],"lastReportAt":null}]}
    """
    return try StatusPayload.decode(Data(json.utf8)).providers[0]
}

@Test func projectsTheFiveHourWindowInAStraightLine() throws {
    // Two of the five hours gone, half of it used: at that pace it is gone two hours from now.
    let running = try #require(Display.fiveHour(window(used: 50, resetsIn: 3 * hour), now: now))
    #expect(running.percent == 50)
    #expect(abs(running.elapsed - 40) < 0.001)
    #expect(running.outlook == .runsOut(now.addingTimeInterval(2 * hour)))
    #expect(abs(try #require(running.runOutPercent) - 80) < 0.001)

    // A third of it in two hours lasts the five.
    let lasting = try #require(Display.fiveHour(window(used: 30, resetsIn: 3 * hour), now: now))
    #expect(lasting.outlook == .lasts)
    #expect(lasting.runOutPercent == nil)
    #expect(Display.fiveHour(window(used: 0, resetsIn: 3 * hour), now: now)?.outlook == .lasts)
}

@Test func tellsWhenTheFiveHourWindowHasNoPace() {
    #expect(Display.fiveHour(nil, now: now) == nil)
    // Five minutes in: a single request would set the pace.
    #expect(Display.fiveHour(window(used: 8, resetsIn: 5 * hour - 300), now: now)?.outlook == .tooEarly)
    #expect(Display.fiveHour(window(used: 100, resetsIn: hour), now: now)?.outlook == .usedUp)
    // Its reset has passed: nothing is used until a request opens a new one.
    let idle = Display.fiveHour(window(used: 70, resetsIn: -60), now: now)
    #expect(idle == FiveHourView(percent: 0, elapsed: 0, resetsAt: nil, outlook: .idle))
}

@Test func placesTheCyclesRunOutOnItsBar() throws {
    let payload = try fixturePayload()
    let claude = payload.providers[0]
    // 2026-10-11 15:00 in a cycle from 10-05 07:00 to 10-12 07:00: 152 of its 168 hours.
    let percent = try #require(Display.runOutPercent(claude, cycle: Display.cycle(of: claude, in: payload)))
    #expect(abs(percent - 152.0 / 168 * 100) < 0.001)
    // No percentage, no pace: no marker.
    #expect(Display.runOutPercent(payload.providers[1], cycle: payload.cycle) == nil)
}

@Test func picksTheIconsNumberAndRing() {
    let cycle = MenuBarFigure(name: nil, percent: 18, status: .good, lastReportAt: nil)
    let fiveHour = FiveHourView(percent: 85, elapsed: 50, resetsAt: now, outlook: .lasts)

    let standard = Display.iconFigures(cycle: cycle, fiveHour: fiveHour, number: .cycle, ring: .fiveHour)
    #expect(standard.number == IconFigure(percent: 18, status: .good))
    #expect(standard.ring == IconFigure(percent: 85, status: .warning))

    let swapped = Display.iconFigures(cycle: cycle, fiveHour: fiveHour, number: .fiveHour, ring: .cycle)
    #expect(swapped.number.percent == 85 && swapped.ring.percent == 18)

    // No 5-hour reading (another provider, or none yet): the cycle's figure stands in.
    let without = Display.iconFigures(cycle: cycle, fiveHour: nil, number: .cycle, ring: .fiveHour)
    #expect(without.ring == IconFigure(percent: 18, status: .good))
    #expect(Display.ringNumberText(18.4) == "18" && Display.ringNumberText(nil) == "–")
}

@Test func hidesTheBreakdownOfASingleMachine() throws {
    let one = try provider(machines: 1)
    let two = try provider(machines: 2)
    #expect(!Display.showsBreakdown(one, mode: .auto))
    #expect(Display.showsBreakdown(two, mode: .auto))
    #expect(Display.showsBreakdown(one, mode: .always))
    #expect(!Display.showsBreakdown(two, mode: .never))
}

@Test func wordsTheFiveHourWindow() throws {
    let running = try #require(Display.fiveHour(window(used: 50, resetsIn: 3 * hour), now: now))
    let time = Display.timeText(now.addingTimeInterval(2 * hour), strings: .hu)
    #expect(Display.fiveHourOutlookText(running, strings: .hu) == "Ebben a tempóban \(time)-kor elfogy")
    #expect(Display.fiveHourLeftText(running, now: now, strings: .en) == "3h left")
    #expect(Display.fiveHourLeftText(running, now: now, strings: .hu) == "3 ó hátra")
    let idle = FiveHourView(percent: 0, elapsed: 0, resetsAt: nil, outlook: .idle)
    #expect(Display.fiveHourLeftText(idle, now: now, strings: .en) == nil)
    #expect(Display.fiveHourOutlookText(idle, strings: .de) == Strings.de.fiveHourIdle)
}

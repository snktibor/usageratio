import Foundation
import Testing
@testable import UsageRatioCore

/// clients/tests/fixtures/status-v1.json is the contract: tests/integration/status.test.ts
/// checks the server's answer has its shape, and this file that the app reads it.
private func fixture() throws -> Data {
    let clients = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    return try Data(contentsOf: clients.appending(path: "tests/fixtures/status-v1.json"))
}

@Test func decodesTheContractFixture() throws {
    let payload = try StatusPayload.decode(fixture())
    #expect(payload.v == 1)
    #expect(payload.cycle.period == "weekly")
    #expect(payload.cycle.end == Date(timeIntervalSince1970: 1_791_788_400))
    #expect(payload.providers.map(\.id) == ["claude", "codex"])

    let claude = payload.providers[0]
    #expect(claude.percent == 62.4)
    #expect(claude.isOfficial)
    #expect(claude.status == .warning)
    #expect(claude.pace?.projectedPercent == 108.03)
    #expect(claude.subLimits.first?.name == "Fable")
    #expect(claude.lastReportAt != nil)

    let codex = payload.providers[1]
    #expect(codex.percent == nil)
    #expect(codex.status == nil)
    #expect(codex.pace == nil)
    #expect(codex.lastReportAt == nil)
}

@Test func readsAnUnknownStatusAsNil() throws {
    var json = try #require(String(data: fixture(), encoding: .utf8))
    json = json.replacingOccurrences(of: "\"status\": \"warning\",\n      \"pace\"", with: "\"status\": \"exhausted\",\n      \"pace\"")
    let payload = try StatusPayload.decode(Data(json.utf8))
    #expect(payload.providers[0].status == nil)
}

@Test func acceptsDatesWithoutMilliseconds() throws {
    var json = try #require(String(data: fixture(), encoding: .utf8))
    json = json.replacingOccurrences(of: "2026-10-07T09:12:00.000Z", with: "2026-10-07T09:12:00Z")
    let payload = try StatusPayload.decode(Data(json.utf8))
    #expect(payload.generatedAt == Date(timeIntervalSince1970: 1_791_364_320))
}

@Test func normalizesTheServerURL() {
    #expect(normalizedServerURL("usage.example.com")?.absoluteString == "https://usage.example.com")
    #expect(normalizedServerURL(" https://usage.example.com/ ")?.absoluteString == "https://usage.example.com/")
    #expect(normalizedServerURL("http://localhost:3000")?.absoluteString == "http://localhost:3000")
    #expect(normalizedServerURL("http://usage.example.com") == nil)
    #expect(normalizedServerURL("") == nil)
    #expect(StatusClient.statusURL(base: URL(string: "https://usage.example.com/")!).absoluteString
        == "https://usage.example.com/api/status")
}

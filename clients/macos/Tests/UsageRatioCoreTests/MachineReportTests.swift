import Foundation
import Testing
@testable import UsageRatioCore

@Test func readsTheScriptsMachineAndGroup() {
    let config = """
    # usageratio client settings, written by install.sh. Private (chmod 600): it holds the API token.
    API_URL='https://usage.example.com/api/usage'
    API_TOKEN='ur_secret'
    MACHINE_ID='mac'
    GROUP_ID='Tibor'\\''s'
    PATH="$HOME/.nvm/versions/node/v22/bin:$PATH"
    """
    #expect(ReporterConfigFile.parse(config) == ReporterConfigFile(machineId: "mac", groupId: "Tibor's"))
}

@Test func readsDoubleQuotedBareAndExportedValues() {
    #expect(ReporterConfigFile.parse("export MACHINE_ID=\"mac studio\"\nGROUP_ID=home # comment")
        == ReporterConfigFile(machineId: "mac studio", groupId: "home"))
    // The last assignment wins, as in the shell; an empty or unclosed one counts as none.
    #expect(ReporterConfigFile.parse("MACHINE_ID=a\nMACHINE_ID=b\nGROUP_ID=''")
        == ReporterConfigFile(machineId: "b", groupId: nil))
    #expect(ReporterConfigFile.parse("MACHINE_ID='open") == ReporterConfigFile())
    #expect(ReporterConfigFile.parse("MY_MACHINE_ID=x") == ReporterConfigFile())
}

@Test func readsTheReportersResult() {
    #expect(MachineReportOutcome.parse(exitCode: 0, output: "✅ Sync successful: 2 providers sent.") == .sent)

    let cases: [(Int32, String, MachineReportProblem)] = [
        (1, #"❌ Sync failed: server answered HTTP 403: {"error":"machine_mismatch"}"#, .machineMismatch),
        (1, #"❌ Sync failed: server answered HTTP 403: {"error":"read_only_token"}"#, .readOnlyToken),
        (3, #"❌ Sync failed: ccusage could not be read: Cycle endpoint answered HTTP 401: {"error":"unauthorized"}"#, .unauthorized),
        (1, #"❌ Sync failed: server answered HTTP 429: {"error":"rate_limited"}"#, .rateLimited),
        (1, "❌ Sync failed: server answered HTTP 503: ", .server(503)),
        (2, "❌ Sync failed: Node.js was not found (it is required by ccusage and the JSON parser)", .nodeMissing),
        (3, "❌ Sync failed: ccusage could not be read: Neither ccusage nor npx was found in PATH.", .nodeMissing),
        (1, "❌ Sync failed: could not reach https://u.example.com/api/usage (curl exit 6): ", .network),
        (3, "❌ Sync failed: ccusage could not be read: curl: (6) Could not resolve host: u.example.com", .network),
        (3, "❌ Sync failed: ccusage could not be read: SyntaxError: Unexpected token", .ccusageFailed),
        (2, "❌ Sync failed: MACHINE_ID and GROUP_ID must be set in /x", .other("MACHINE_ID and GROUP_ID must be set in /x")),
        (1, "", .other("exit 1")),
    ]
    for (code, output, problem) in cases {
        #expect(MachineReportOutcome.parse(exitCode: code, output: output) == .failed(problem), "\(output)")
    }
}

@Test func reportsHourlyAndRetriesAFailureSooner() {
    let now = Date(timeIntervalSince1970: 1_791_533_100)
    #expect(MachineReportPolicy.isDue(lastAttempt: nil, lastFailed: false, now: now))
    #expect(!MachineReportPolicy.isDue(lastAttempt: now.addingTimeInterval(-3000), lastFailed: false, now: now))
    #expect(MachineReportPolicy.isDue(lastAttempt: now.addingTimeInterval(-3600), lastFailed: false, now: now))
    #expect(MachineReportPolicy.isDue(lastAttempt: now.addingTimeInterval(-900), lastFailed: true, now: now))
    #expect(!MachineReportPolicy.isDue(lastAttempt: now.addingTimeInterval(-600), lastFailed: true, now: now))
    // A clock set back: report rather than wait for it to catch up.
    #expect(MachineReportPolicy.isDue(lastAttempt: now.addingTimeInterval(600), lastFailed: false, now: now))
}

@Test func namesEveryProblemInEveryLanguage() {
    let problems: [MachineReportProblem] = [
        .reporterMissing, .nodeMissing, .ccusageFailed, .unauthorized, .machineMismatch,
        .readOnlyToken, .rateLimited, .server(500), .network, .timedOut,
    ]
    for strings in [Strings.en, .hu, .de] {
        for problem in problems {
            #expect(!strings.message(for: problem).isEmpty)
        }
    }
    #expect(Strings.hu.message(for: .server(502)) == "a szerver HTTP 502 választ adott")
    #expect(Strings.en.message(for: .other("as is")) == "as is")
}

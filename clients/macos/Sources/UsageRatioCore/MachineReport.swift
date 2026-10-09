import Foundation

/// The machine name and group the shell reporter uses on this Mac, read from its config file
/// (`~/.config/usageratio/config`, written by clients/setup/install.sh). The app starts from
/// them, so it carries on the script's figures under the same name. The token is never read.
public struct ReporterConfigFile: Equatable, Sendable {
    public var machineId: String?
    public var groupId: String?

    public init(machineId: String? = nil, groupId: String? = nil) {
        self.machineId = machineId
        self.groupId = groupId
    }

    /// The `MACHINE_ID=` and `GROUP_ID=` assignments of the plain shell file: quoted with '…'
    /// (install.sh's way, `'\''` for a quote inside), "…", or bare; the last one wins, like in the shell.
    public static func parse(_ text: String) -> ReporterConfigFile {
        var result = ReporterConfigFile()
        for rawLine in text.split(whereSeparator: \.isNewline) {
            var line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("export ") { line = String(line.dropFirst(7)).trimmingCharacters(in: .whitespaces) }
            guard let equals = line.firstIndex(of: "=") else { continue }
            let key = line[..<equals]
            guard key == "MACHINE_ID" || key == "GROUP_ID" else { continue }
            let value = shellValue(line[line.index(after: equals)...])
            let kept = value.flatMap { $0.isEmpty ? nil : $0 }
            if key == "MACHINE_ID" { result.machineId = kept } else { result.groupId = kept }
        }
        return result
    }

    /// One shell word made of quoted and bare parts; nil when a quote is left open.
    private static func shellValue(_ text: Substring) -> String? {
        var value = ""
        var rest = text[...]
        while let first = rest.first {
            switch first {
            case "'", "\"":
                rest = rest.dropFirst()
                guard let close = rest.firstIndex(of: first) else { return nil }
                value += rest[..<close]
                rest = rest[rest.index(after: close)...]
            case "\\":
                rest = rest.dropFirst()
                if let escaped = rest.first {
                    value.append(escaped)
                    rest = rest.dropFirst()
                }
            case " ", "\t", "#", ";":
                return value
            default:
                value.append(first)
                rest = rest.dropFirst()
            }
        }
        return value
    }
}

/// Why this Mac's report did not go out.
public enum MachineReportProblem: Equatable, Sendable {
    /// The app was built without the reporter (a `swift run` build).
    case reporterMissing
    case nodeMissing
    case ccusageFailed
    case unauthorized
    case machineMismatch
    case readOnlyToken
    case rateLimited
    case server(Int)
    case network
    case timedOut
    /// Anything else, in the reporter's own words.
    case other(String)
}

public enum MachineReportOutcome: Equatable, Sendable {
    case sent
    case failed(MachineReportProblem)

    /// Reads the shared reporter's result (clients/shared/report-usage-core.sh, manual output):
    /// exit 0 sent · 1 sending failed · 2 bad settings · 3 ccusage could not be read; on failure
    /// it prints "❌ Sync failed: …", with the server's HTTP status and error code when it answered.
    public static func parse(exitCode: Int32, output: String) -> MachineReportOutcome {
        if exitCode == 0 { return .sent }
        let message = failureLine(in: output)
        if let status = httpStatus(in: message) {
            switch status {
            case 401: return .failed(.unauthorized)
            case 403 where message.contains("machine_mismatch"): return .failed(.machineMismatch)
            case 403 where message.contains("read_only_token"): return .failed(.readOnlyToken)
            case 429: return .failed(.rateLimited)
            default: return .failed(.server(status))
            }
        }
        if ["Node.js was not found", "ccusage nor npx", "ccusage was not found", "npx was not found"]
            .contains(where: message.contains) {
            return .failed(.nodeMissing)
        }
        if message.contains("could not reach") || message.contains("curl: (") { return .failed(.network) }
        if exitCode == 3 { return .failed(.ccusageFailed) }
        return .failed(.other(message.isEmpty ? "exit \(exitCode)" : String(message.prefix(160))))
    }

    private static func failureLine(in output: String) -> String {
        let lines = output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        let marker = "Sync failed:"
        if let line = lines.last(where: { $0.contains(marker) }), let range = line.range(of: marker) {
            return line[range.upperBound...].trimmingCharacters(in: .whitespaces)
        }
        return lines.last(where: { !$0.isEmpty }) ?? ""
    }

    /// "server answered HTTP 403: …" or "Cycle endpoint answered HTTP 401: …".
    private static func httpStatus(in message: String) -> Int? {
        guard let range = message.range(of: "HTTP ") else { return nil }
        let digits = message[range.upperBound...].prefix(3)
        guard digits.count == 3, digits.allSatisfy(\.isNumber) else { return nil }
        return Int(digits)
    }
}

/// When the app reports this Mac: hourly, like the script's cron job, and a failed run again sooner.
public enum MachineReportPolicy {
    public static let interval: TimeInterval = 3600
    public static let retryInterval: TimeInterval = 900

    public static func isDue(lastAttempt: Date?, lastFailed: Bool, now: Date) -> Bool {
        // A clock set back since then would otherwise hold the report off until it caught up.
        guard let lastAttempt, lastAttempt <= now else { return true }
        return now.timeIntervalSince(lastAttempt) >= (lastFailed ? retryInterval : interval)
    }
}

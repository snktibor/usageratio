import Foundation
import SystemConfiguration
import UsageRatioCore

/// Reports this Mac's token usage with the shared reporter the scripts use
/// (clients/shared/report-usage-core.sh and ccusage-providers.cjs, bundled into
/// Contents/Resources/reporter by scripts/build-app.sh), so the numbers come out
/// exactly as the cron job's would. The script's own config file, when there is
/// one, is still read by it (PATH, COST); the app's server, token, machine and
/// group win through the environment, and the token never touches the disk.
enum MachineReporter {
    /// ccusage through npx may first download itself.
    static let timeout: TimeInterval = 300

    static var coreScript: URL? {
        guard let url = Bundle.main.resourceURL?.appending(path: "reporter/report-usage-core.sh"),
              FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }

    /// The script's machine name and group on this Mac, if it was ever installed here.
    static func scriptConfig(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> ReporterConfigFile? {
        let file = home.appending(path: ".config/usageratio/config")
        return (try? String(contentsOf: file, encoding: .utf8)).map(ReporterConfigFile.parse)
    }

    /// The name the script falls back to (`scutil --get LocalHostName`).
    static var localHostName: String? {
        SCDynamicStoreCopyLocalHostName(nil) as String?
    }

    /// Where Node.js may live beyond the reporter's own PATH: nvm's newest version and Volta.
    static func extraNodeFolders(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> [String] {
        var folders: [String] = []
        let nvm = home.appending(path: ".nvm/versions/node")
        let versions = (try? FileManager.default.contentsOfDirectory(atPath: nvm.path)) ?? []
        if let newest = versions.filter({ $0.hasPrefix("v") })
            .max(by: { $0.compare($1, options: .numeric) == .orderedAscending }) {
            folders.append(nvm.appending(path: "\(newest)/bin").path)
        }
        folders.append(home.appending(path: ".volta/bin").path)
        return folders
    }

    /// Whether `node` is on the PATH the reporter will run with.
    static func nodeFound(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> Bool {
        let reporterPath = ["/opt/homebrew/bin", "/usr/local/bin", home.appending(path: ".local/bin").path,
                            home.appending(path: ".npm-global/bin").path, "/usr/bin", "/bin"]
        return (extraNodeFolders(home: home) + reporterPath)
            .contains { FileManager.default.isExecutableFile(atPath: "\($0)/node") }
    }

    static func run(base: URL, token: String, machineId: String, groupId: String) async -> MachineReportOutcome {
        guard let script = coreScript else { return .failed(.reporterMissing) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [script.path]
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = (extraNodeFolders() + ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]).joined(separator: ":")
        environment["USAGERATIO_API_URL"] = base.appending(path: "api/usage").absoluteString
        environment["USAGERATIO_API_TOKEN"] = token
        environment["USAGERATIO_MACHINE_ID"] = machineId
        environment["USAGERATIO_GROUP_ID"] = groupId
        // Readable results to parse, yet reported as a scheduled (hourly) machine.
        environment["USAGERATIO_OUTPUT_MODE"] = "manual"
        environment["USAGERATIO_REPORT_MODE"] = "auto"
        environment["USAGERATIO_INTERVAL_MINUTES"] = "60"
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        process.standardInput = FileHandle.nullDevice

        let output = OutputBuffer()
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil } else { output.append(data) }
        }
        let running = RunningProcess(process)
        let finished: Bool = await withCheckedContinuation { continuation in
            let resume = ResumeOnce(continuation)
            process.terminationHandler = { _ in resume(true) }
            do {
                try process.run()
            } catch {
                resume(false)
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                running.terminateIfRunning { output.timedOut = true }
            }
        }
        pipe.fileHandleForReading.readabilityHandler = nil
        guard finished else { return .failed(.other("bash could not be started")) }
        if output.timedOut { return .failed(.timedOut) }
        return MachineReportOutcome.parse(exitCode: process.terminationStatus, output: output.text)
    }
}

/// What the reporter printed, gathered from the pipe's background reads.
private final class OutputBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()
    private var didTimeOut = false

    func append(_ chunk: Data) {
        lock.withLock { data.append(chunk) }
    }

    var text: String { lock.withLock { String(decoding: data, as: UTF8.self) } }

    var timedOut: Bool {
        get { lock.withLock { didTimeOut } }
        set { lock.withLock { didTimeOut = newValue } }
    }
}

/// The process, for the timeout to stop from another thread.
private final class RunningProcess: @unchecked Sendable {
    private let process: Process
    init(_ process: Process) { self.process = process }

    /// `before` runs first, so the exit it causes already reads as a timeout.
    func terminateIfRunning(_ before: () -> Void) {
        guard process.isRunning else { return }
        before()
        process.terminate()
    }
}

/// A continuation resumed by whichever comes first: the exit, or a failed start.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Bool, Never>?
    init(_ continuation: CheckedContinuation<Bool, Never>) { self.continuation = continuation }

    func callAsFunction(_ value: Bool) {
        let pending = lock.withLock { () -> CheckedContinuation<Bool, Never>? in
            defer { continuation = nil }
            return continuation
        }
        pending?.resume(returning: value)
    }
}

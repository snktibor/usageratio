import Foundation
import UsageRatioCore

/// What one source gave: the snapshot read from it, and the date of the file behind it
/// (`fileDate` nil: there is no file at all).
struct SourceReading: Sendable {
    let snapshot: LimitsSnapshot?
    let fileDate: Date?

    static let missing = SourceReading(snapshot: nil, fileDate: nil)
}

/// Where this Mac keeps the providers' own usage limits: Claude Code's status line (saved by
/// the pass-through script) or, for Claude run inside T3 Code, T3 Code's provider event log, and
/// Codex's session logs. Read only; every failure is "no snapshot".
enum LimitSources {
    /// Of a Codex log, only the tail is read: the newest limits are at the end.
    private static let codexTail: UInt64 = 512 * 1024
    private static let codexDayFolders = 3
    /// T3 Code logs every SDK message, so a turn can bury the limits deep: read more of it.
    private static let t3Tail: UInt64 = 4 * 1024 * 1024
    /// One log per T3 thread; the newest few are searched (the newest may be a Codex thread).
    private static let t3Logs = 5

    static func readAll(home: URL = FileManager.default.homeDirectoryForCurrentUser, codexHome: String? = ProcessInfo.processInfo.environment["CODEX_HOME"])
        async -> (claude: SourceReading, codex: SourceReading)
    {
        await Task.detached {
            (claude: claude(home: home), codex: codex(home: home, codexHome: codexHome))
        }.value
    }

    /// The later of the status line's snapshot and T3 Code's log, so both ways of running Claude count.
    static func claude(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> SourceReading {
        let statusLine = claudeStatusLine(home: home)
        let t3 = claudeT3(home: home)
        guard let snapshot = LimitsSnapshot.newest(statusLine.snapshot, t3.snapshot) else {
            return statusLine.fileDate != nil ? statusLine : t3
        }
        return snapshot == t3.snapshot ? t3 : statusLine
    }

    private static func claudeStatusLine(home: URL) -> SourceReading {
        let file = home.appending(path: ".usageratio/claude-limits.json")
        guard let date = modificationDate(file) else { return .missing }
        let snapshot = (try? Data(contentsOf: file)).flatMap(ClaudeLimits.parse)
        return SourceReading(snapshot: snapshot, fileDate: date)
    }

    /// The newest Claude limits in T3 Code's newest few `events.*.log` files.
    private static func claudeT3(home: URL) -> SourceReading {
        let folder = home.appending(path: ".t3/userdata/logs/provider")
        let logs = children(of: folder)
            .filter { $0.lastPathComponent.hasPrefix("events.") && $0.pathExtension == "log" }
            .compactMap { file in modificationDate(file).map { (file, $0) } }
            .sorted { $0.1 > $1.1 }
            .prefix(t3Logs)
        guard let newestDate = logs.first?.1 else { return .missing }
        for (file, date) in logs {
            if let text = tail(of: file, bytes: t3Tail), let snapshot = T3ClaudeLimits.latest(inLog: text) {
                return SourceReading(snapshot: snapshot, fileDate: date)
            }
        }
        return SourceReading(snapshot: nil, fileDate: newestDate)
    }

    static func codex(home: URL = FileManager.default.homeDirectoryForCurrentUser, codexHome: String? = nil) -> SourceReading {
        let root = codexHome.flatMap { $0.isEmpty ? nil : URL(fileURLWithPath: $0) } ?? home.appending(path: ".codex")
        guard let (file, date) = newestRollout(in: root.appending(path: "sessions")) else { return .missing }
        guard let text = tail(of: file, bytes: codexTail) else { return SourceReading(snapshot: nil, fileDate: date) }
        return SourceReading(snapshot: CodexLimits.latest(inLog: text), fileDate: date)
    }

    // MARK: Files

    private static func modificationDate(_ url: URL) -> Date? {
        (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
    }

    private static func children(of folder: URL) -> [URL] {
        (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    }

    /// The newest `rollout-*.jsonl` of the newest few day folders (sessions/YYYY/MM/DD).
    private static func newestRollout(in sessions: URL) -> (URL, Date)? {
        func newestFirst(_ folder: URL) -> [URL] {
            children(of: folder).filter { Int($0.lastPathComponent) != nil }.sorted { $0.lastPathComponent > $1.lastPathComponent }
        }
        var days: [URL] = []
        outer: for year in newestFirst(sessions) {
            for month in newestFirst(year) {
                for day in newestFirst(month) {
                    days.append(day)
                    if days.count == codexDayFolders { break outer }
                }
            }
        }
        var best: (URL, Date)?
        for day in days {
            for file in children(of: day)
            where file.lastPathComponent.hasPrefix("rollout-") && file.pathExtension == "jsonl" {
                guard let date = modificationDate(file) else { continue }
                if best == nil || date > best!.1 { best = (file, date) }
            }
        }
        return best
    }

    /// The last `bytes` as text, without a first line that started mid-file.
    private static func tail(of file: URL, bytes: UInt64) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }
        do {
            let size = try handle.seekToEnd()
            let start = size > bytes ? size - bytes : 0
            try handle.seek(toOffset: start)
            guard let data = try handle.readToEnd() else { return nil }
            var text = String(decoding: data, as: UTF8.self)
            if start > 0, let newline = text.firstIndex(of: "\n") {
                text = String(text[text.index(after: newline)...])
            } else if start > 0 {
                return nil
            }
            return text
        } catch {
            return nil
        }
    }
}

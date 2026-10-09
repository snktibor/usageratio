import Foundation

/// One window of a provider's own subscription limit, as the provider's tool reported it.
public struct LimitWindow: Equatable, Sendable {
    public let usedPercent: Double
    public let resetsAt: Date

    public init(usedPercent: Double, resetsAt: Date) {
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
    }
}

/// What a provider's own tool last said about its limits on this Mac. Only the
/// weekly window is uploaded (POST /api/official-usage/report); the 5-hour one is shown.
public struct LimitsSnapshot: Equatable, Sendable {
    /// The dashboard's provider id: "claude", or "openai" for Codex.
    public let providerId: String
    public let weekly: LimitWindow?
    public let fiveHour: LimitWindow?
    public let observedAt: Date

    public init(providerId: String, weekly: LimitWindow?, fiveHour: LimitWindow?, observedAt: Date) {
        self.providerId = providerId
        self.weekly = weekly
        self.fiveHour = fiveHour
        self.observedAt = observedAt
    }
}

private func number(_ value: Any?) -> Double? {
    guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
    let double = value.doubleValue
    return double.isFinite ? double : nil
}

/// The file Claude Code's status line pass-through writes (clients/macos/scripts/statusline-tee.sh):
/// Claude Code's own `rate_limits` (https://code.claude.com/docs/en/statusline) and when they were seen.
public enum ClaudeLimits {
    public static func parse(_ data: Data) -> LimitsSnapshot? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let limits = object["rate_limits"] as? [String: Any],
              let observed = number(object["observed_at"])
        else { return nil }
        func window(_ key: String) -> LimitWindow? {
            guard let entry = limits[key] as? [String: Any],
                  let percent = number(entry["used_percentage"]), let resetsAt = number(entry["resets_at"])
            else { return nil }
            return LimitWindow(usedPercent: percent, resetsAt: Date(timeIntervalSince1970: resetsAt))
        }
        let weekly = window("seven_day")
        let fiveHour = window("five_hour")
        guard weekly != nil || fiveHour != nil else { return nil }
        return LimitsSnapshot(
            providerId: "claude", weekly: weekly, fiveHour: fiveHour,
            observedAt: Date(timeIntervalSince1970: observed)
        )
    }
}

/// Codex's own session log (~/.codex/sessions/…/rollout-*.jsonl): its `token_count`
/// events carry the account's `rate_limits`. Read from the end: the newest one wins.
public enum CodexLimits {
    private static let weeklyMinutes = 10_000...10_200
    private static let fiveHourMinutes = 280...320

    public static func latest(inLog text: String) -> LimitsSnapshot? {
        for line in text.split(separator: "\n", omittingEmptySubsequences: true).reversed() {
            guard line.contains("rate_limits"), let snapshot = parse(line: line) else { continue }
            return snapshot
        }
        return nil
    }

    private static func parse(line: Substring) -> LimitsSnapshot? {
        guard let object = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
              let stamp = object["timestamp"] as? String,
              let observedAt = parseDate(stamp)
        else { return nil }
        let payload = object["payload"] as? [String: Any]
        guard let limits = (payload?["rate_limits"] ?? object["rate_limits"]) as? [String: Any] else { return nil }

        var weekly: LimitWindow?
        var fiveHour: LimitWindow?
        for key in ["primary", "secondary"] {
            guard let entry = limits[key] as? [String: Any],
                  let percent = number(entry["used_percent"]),
                  let minutes = number(entry["window_minutes"]).map({ Int($0) })
            else { continue }
            let resetsAt: Date
            if let absolute = number(entry["resets_at"]) {
                resetsAt = Date(timeIntervalSince1970: absolute)
            } else if let relative = number(entry["resets_in_seconds"]) {
                resetsAt = observedAt.addingTimeInterval(relative)
            } else {
                continue
            }
            let window = LimitWindow(usedPercent: percent, resetsAt: resetsAt)
            if weeklyMinutes.contains(minutes) { weekly = window }
            if fiveHourMinutes.contains(minutes) { fiveHour = window }
        }
        guard weekly != nil || fiveHour != nil else { return nil }
        return LimitsSnapshot(providerId: "openai", weekly: weekly, fiveHour: fiveHour, observedAt: observedAt)
    }

    private static func parseDate(_ text: String) -> Date? {
        (try? Date(text, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)))
            ?? (try? Date(text, strategy: .iso8601))
    }
}

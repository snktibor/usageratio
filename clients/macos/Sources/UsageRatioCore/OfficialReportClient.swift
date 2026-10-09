import Foundation

/// When a provider's cycle resets: weekday (0 = Sunday), hour and minute on the dashboard's clock.
public struct ResetMoment: Equatable, Sendable, Codable {
    public let weekday: Int
    public let hour: Int
    public let minute: Int

    public init(weekday: Int, hour: Int, minute: Int) {
        self.weekday = weekday
        self.hour = hour
        self.minute = minute
    }
}

/// Why the server declined a figure that was otherwise well-formed.
public enum OfficialReportRefusal: String, Equatable, Sendable, Codable {
    case notOfficialToken, periodNotWeekly, staleReading
}

public enum OfficialReportOutcome: Equatable, Sendable {
    /// `saved`: the figure was stored; `movedTo`: the provider's weekly reset moved to this moment.
    case accepted(saved: Bool, movedTo: ResetMoment?)
    case refused(OfficialReportRefusal)
}

/// One POST /api/official-usage/report. Ephemeral session: no cookies, no cache on disk.
public struct OfficialReportClient: Sendable {
    private let session: URLSession

    public init(session: URLSession = URLSession(configuration: .ephemeral)) {
        self.session = session
    }

    public static func reportURL(base: URL) -> URL {
        base.appending(path: "api/official-usage/report")
    }

    /// The request body; nil while the snapshot has no weekly window.
    public static func body(for snapshot: LimitsSnapshot) -> Data? {
        guard let weekly = snapshot.weekly else { return nil }
        let milliseconds = { (date: Date) in Int((date.timeIntervalSince1970 * 1000).rounded()) }
        let object: [String: Any] = [
            "providerId": snapshot.providerId,
            "usedPercent": weekly.usedPercent,
            "resetsAtMs": milliseconds(weekly.resetsAt),
            "observedAtMs": milliseconds(snapshot.observedAt),
        ]
        return try? JSONSerialization.data(withJSONObject: object)
    }

    private struct Accepted: Decodable {
        let saved: Bool
        let reset: ResetMoment?
    }

    private struct Failure: Decodable { let error: String }

    public static func outcome(status: Int, data: Data) throws(StatusError) -> OfficialReportOutcome {
        let decoder = JSONDecoder()
        let error = (try? decoder.decode(Failure.self, from: data))?.error
        switch status {
        case 200:
            guard let answer = try? decoder.decode(Accepted.self, from: data) else { throw .invalidResponse }
            return .accepted(saved: answer.saved, movedTo: answer.reset)
        case 401:
            throw .unauthorized
        case 403:
            guard error == "official_scope_required" || error == "read_only_token" else { throw .invalidResponse }
            return .refused(.notOfficialToken)
        case 409:
            switch error {
            case "period_not_weekly": return .refused(.periodNotWeekly)
            case "stale_reading": return .refused(.staleReading)
            default: throw .invalidResponse
            }
        case 429:
            throw .rateLimited(retryAfter: nil)
        default:
            throw .server(status: status)
        }
    }

    public func send(
        _ snapshot: LimitsSnapshot, base: URL, token: String
    ) async throws(StatusError) -> OfficialReportOutcome {
        guard let body = Self.body(for: snapshot) else { throw .invalidResponse }
        var request = URLRequest(url: Self.reportURL(base: base), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw .network
        }
        guard let http = response as? HTTPURLResponse else { throw .invalidResponse }
        return try Self.outcome(status: http.statusCode, data: data)
    }
}

public enum UploadPolicy {
    /// A weekly figure newer than the last one uploaded for that provider.
    public static func shouldUpload(_ snapshot: LimitsSnapshot, lastUploaded: Date?) -> Bool {
        guard snapshot.weekly != nil else { return false }
        guard let lastUploaded else { return true }
        return snapshot.observedAt > lastUploaded
    }
}

import Foundation

/// GET /api/status, version 1: the shape `StatusPayload` in lib/status.ts.
/// Percentages are 0–100 (above 100 when over the limit); a null one means
/// nothing tells how much of the budget is gone (token limits off, and no
/// official reading typed on the dashboard).
public struct StatusPayload: Decodable, Equatable, Sendable {
    public let v: Int
    public let generatedAt: Date
    public let cycle: Cycle
    public let providers: [Provider]

    public struct Cycle: Decodable, Equatable, Sendable {
        /// "weekly" or "monthly".
        public let period: String
        public let start: Date
        public let end: Date
        public let timeZone: String
    }

    public struct Provider: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let percent: Double?
        /// "official" or "estimate"; nil when `percent` is.
        public let source: String?
        public let estimatedPercent: Double?
        public let asOf: Date
        public let tokens: Double
        public let limit: Double?
        public let status: QuotaStatus?
        public let pace: Pace?
        public let subLimits: [SubLimit]
        /// Empty from a server older than the breakdown.
        public let groups: [Share]
        public let machines: [Machine]
        public let lastReportAt: Date?

        public var isOfficial: Bool { source == "official" }
    }

    /// A group's part of its provider's figure: `percent` is of the provider's whole budget.
    public struct Share: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let percent: Double?
        public let tokens: Double
    }

    public struct Machine: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let groupId: String
        public let percent: Double?
        public let tokens: Double
        public let lastReportAt: Date
    }

    public struct Pace: Decodable, Equatable, Sendable {
        public let projectedPercent: Double?
        public let runOutAt: Date?
    }

    public struct SubLimit: Decodable, Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let percent: Double?
        /// "official", "provider" or "measured"; nil while unknown.
        public let source: String?
        public let status: QuotaStatus?
    }

    /// The version this app reads; a payload of another one is refused rather than misread.
    public static let supportedVersion = 1

    public static func decode(_ data: Data) throws -> StatusPayload {
        try decoder.decode(StatusPayload.self, from: data)
    }

    /// The server writes `Date.prototype.toISOString()`: always with milliseconds,
    /// which `.iso8601` alone does not accept.
    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = try? Date(text, strategy: .iso8601.year().month().day().time(includingFractionalSeconds: true)) {
                return date
            }
            if let date = try? Date(text, strategy: .iso8601) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "not an ISO 8601 date: \(text)")
        }
        return decoder
    }()
}

/// lib/quota.ts `QuotaStatus`. An unknown value (a future server) reads as nil, not as a decoding failure.
public enum QuotaStatus: String, Sendable, Decodable {
    case good, warning, critical

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let value = QuotaStatus(rawValue: raw) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: raw))
        }
        self = value
    }
}

extension StatusPayload.Provider {
    private enum CodingKeys: String, CodingKey {
        case id, label, percent, source, estimatedPercent, asOf, tokens, limit, status, pace, subLimits, groups,
            machines, lastReportAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        percent = try c.decodeIfPresent(Double.self, forKey: .percent)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        estimatedPercent = try c.decodeIfPresent(Double.self, forKey: .estimatedPercent)
        asOf = try c.decode(Date.self, forKey: .asOf)
        tokens = try c.decode(Double.self, forKey: .tokens)
        limit = try c.decodeIfPresent(Double.self, forKey: .limit)
        status = try? c.decodeIfPresent(QuotaStatus.self, forKey: .status)
        pace = try c.decodeIfPresent(StatusPayload.Pace.self, forKey: .pace)
        subLimits = try c.decodeIfPresent([StatusPayload.SubLimit].self, forKey: .subLimits) ?? []
        groups = try c.decodeIfPresent([StatusPayload.Share].self, forKey: .groups) ?? []
        machines = try c.decodeIfPresent([StatusPayload.Machine].self, forKey: .machines) ?? []
        lastReportAt = try c.decodeIfPresent(Date.self, forKey: .lastReportAt)
    }
}

extension StatusPayload.SubLimit {
    private enum CodingKeys: String, CodingKey { case id, name, percent, source, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        percent = try c.decodeIfPresent(Double.self, forKey: .percent)
        source = try c.decodeIfPresent(String.self, forKey: .source)
        status = try? c.decodeIfPresent(QuotaStatus.self, forKey: .status)
    }
}

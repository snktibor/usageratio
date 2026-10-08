import Foundation

/// What of the chosen provider the menu bar shows: all of it, or one group's or machine's part.
public enum MenuBarScope: Hashable, Sendable {
    case total
    case group(String)
    case machine(String)

    /// The UserDefaults form: nil, "group:<id>" or "machine:<id>".
    public var storage: String? {
        switch self {
        case .total: nil
        case .group(let id): "group:\(id)"
        case .machine(let id): "machine:\(id)"
        }
    }

    public init(storage: String?) {
        guard let storage, let colon = storage.firstIndex(of: ":") else {
            self = .total
            return
        }
        let id = String(storage[storage.index(after: colon)...])
        switch storage[..<colon] {
        case "group" where !id.isEmpty: self = .group(id)
        case "machine" where !id.isEmpty: self = .machine(id)
        default: self = .total
        }
    }
}

public struct MenuBarFigure: Equatable, Sendable {
    /// The group's or machine's id; nil for the provider's own figure.
    public let name: String?
    public let percent: Double?
    public let status: QuotaStatus?
    public let lastReportAt: Date?
}

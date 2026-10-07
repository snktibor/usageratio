import Foundation

public enum StatusError: Error, Equatable, Sendable {
    /// No server URL or token saved yet.
    case notConfigured
    /// 401: the token is wrong or revoked.
    case unauthorized
    /// 429, with the server's `Retry-After` in seconds when it sent one.
    case rateLimited(retryAfter: TimeInterval?)
    /// Any other non-200 answer; 503 is the store being down.
    case server(status: Int)
    /// The payload was not a version this app reads.
    case unsupportedVersion(Int)
    case invalidResponse
    /// The request never got an answer: offline, DNS, TLS, timeout.
    case network
}

/// One GET /api/status. Ephemeral session: no cookies, no cache on disk.
public struct StatusClient: Sendable {
    private let session: URLSession

    public init(session: URLSession = URLSession(configuration: .ephemeral)) {
        self.session = session
    }

    public static func statusURL(base: URL) -> URL {
        base.appending(path: "api/status")
    }

    public func fetch(base: URL, token: String) async throws(StatusError) -> StatusPayload {
        var request = URLRequest(url: Self.statusURL(base: base), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw .network
        }
        guard let http = response as? HTTPURLResponse else { throw .invalidResponse }

        switch http.statusCode {
        case 200:
            break
        case 401:
            throw .unauthorized
        case 429:
            throw .rateLimited(retryAfter: http.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init))
        default:
            throw .server(status: http.statusCode)
        }

        let payload: StatusPayload
        do {
            payload = try StatusPayload.decode(data)
        } catch {
            throw .invalidResponse
        }
        guard payload.v == StatusPayload.supportedVersion else { throw .unsupportedVersion(payload.v) }
        return payload
    }
}

/// The server URL as typed on the settings screen: https, or http only for this
/// machine or the local network (a dev server); a trailing slash or path is kept as the base.
public func normalizedServerURL(_ text: String) -> URL? {
    var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return nil }
    if !trimmed.contains("://") { trimmed = "https://\(trimmed)" }
    guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), let host = url.host(), !host.isEmpty
    else { return nil }
    if scheme == "https" { return url }
    let local = host == "localhost" || host == "127.0.0.1" || host.hasSuffix(".local")
    return scheme == "http" && local ? url : nil
}

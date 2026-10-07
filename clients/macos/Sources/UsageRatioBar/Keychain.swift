import Foundation
import Security

/// The API token lives in the login keychain, never in UserDefaults. An
/// ad-hoc signed rebuild is a different app to the keychain, so the first
/// read after one asks once for access ("Always Allow").
enum Keychain {
    private static let service = "UsageRatioBar"
    private static let account = "api-token"

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func readToken() -> String? {
        var item: CFTypeRef?
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        guard SecItemCopyMatching(request as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func saveToken(_ token: String) -> Bool {
        let data = Data(token.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "UsageRatio menu bar token"
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    static var hasToken: Bool {
        var request = query
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        // Asks for the attributes only: the keychain need not unlock the secret just to say it exists.
        request[kSecReturnAttributes as String] = true
        return SecItemCopyMatching(request as CFDictionary, nil) == errSecSuccess
    }
}

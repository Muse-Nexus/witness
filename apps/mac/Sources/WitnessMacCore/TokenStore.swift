import Foundation
import os
import Security

/// A saved device token and the Witness address it was saved for.
public struct SavedKey: Equatable, Sendable {
    public var token: String
    /// `ServerBinding.string(for:)` of the address the token was checked and saved with,
    /// or nil when none was recorded (a key saved before 0.2.0).
    public var server: String?

    public init(token: String, server: String?) {
        self.token = token
        self.server = server
    }
}

/// Holds the device token. The real store is the Keychain; tests use `InMemoryTokenStore`.
///
/// A token is saved together with the address it was checked against, and is only ever
/// sent there (`token(for:)`). `config.json` is an ordinary file, so if its address
/// changes without the key being saved again, nothing is sent until the person adds the
/// key again for the new address.
public protocol TokenStore: Sendable {
    func readSavedKey() throws -> SavedKey?
    /// Saves the token, tied to `server` (a URL from `ConfigValidation.normalizedAPIURL`).
    func writeToken(_ token: String, server: URL) throws
    func deleteToken() throws
    /// Where a saved token lives, for `witness-mac status`.
    var savedLocation: String { get }
    /// False only for `WITNESS_TOKEN`, where the person running the command supplies the
    /// token and the address together.
    var isTiedToServer: Bool { get }
}

extension TokenStore {
    public var savedLocation: String { "saved in the Keychain" }
    public var isTiedToServer: Bool { true }

    public func readToken() throws -> String? {
        try readSavedKey()?.token
    }

    /// The token to send to `server`, or nil when none is saved.
    /// - Throws: `KeyBindingError.otherAddress` when the saved token was saved for a
    ///   different address, or before addresses were recorded with it.
    public func token(for server: URL) throws -> String? {
        guard let saved = try readSavedKey() else { return nil }
        guard isTiedToServer else { return saved.token }
        guard let bound = saved.server, bound == ServerBinding.string(for: server) else {
            throw KeyBindingError.otherAddress
        }
        return saved.token
    }
}

/// How a saved key names the address it belongs to: scheme and host in lower case, no
/// default port, no trailing slash. Two spellings of one address give the same string.
public enum ServerBinding {
    public static func string(for url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url.absoluteString
        }
        let scheme = components.scheme?.lowercased()
        components.scheme = scheme
        components.host = components.host?.lowercased()
        if (scheme == "https" && components.port == 443) || (scheme == "http" && components.port == 80) {
            components.port = nil
        }
        components.query = nil
        components.fragment = nil
        var value = components.string ?? url.absoluteString
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }
}

public enum KeyBindingError: Error, Equatable, CustomStringConvertible {
    /// The saved key belongs to another address (or to no recorded address).
    case otherAddress

    public var description: String {
        "The saved key was saved for a different Witness address, so nothing is sent to this one. Add the key again for this address."
    }
}

/// Picks the token store for the real CLI: `WITNESS_TOKEN` when it is set, the Keychain otherwise.
public enum TokenStores {
    public static func standard(environment: [String: String]) -> any TokenStore {
        if let token = environment[EnvironmentTokenStore.variable], !token.isEmpty {
            return EnvironmentTokenStore(token: token)
        }
        return KeychainTokenStore()
    }
}

public enum EnvironmentTokenError: Error, Equatable, CustomStringConvertible {
    case differentToken

    public var description: String {
        "WITNESS_TOKEN is set to a different token. Unset it to save this one in the Keychain."
    }
}

/// The device token from the `WITNESS_TOKEN` environment variable, for tests and
/// scripted runs of the CLI (the end-to-end test uses it). The Keychain is never read or
/// written: `login` with the same token saves only the server address, and `logout` has
/// nothing to remove. The menu-bar app never uses it in a release build.
public struct EnvironmentTokenStore: TokenStore {
    public static let variable = "WITNESS_TOKEN"
    public let token: String

    public init(token: String) {
        self.token = token
    }

    public func readSavedKey() throws -> SavedKey? { SavedKey(token: token, server: nil) }

    public func writeToken(_ token: String, server: URL) throws {
        guard token == self.token else { throw EnvironmentTokenError.differentToken }
    }

    public func deleteToken() throws {}

    public var savedLocation: String { "from WITNESS_TOKEN (the Keychain is not used)" }

    public var isTiedToServer: Bool { false }
}

public enum KeychainError: Error, Equatable, CustomStringConvertible {
    case status(OSStatus)
    case unexpectedData

    public var description: String {
        switch self {
        case .status(let status):
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "error \(status)"
            return "Keychain: \(message)"
        case .unexpectedData:
            return "Keychain: the saved device token could not be read."
        }
    }
}

/// Stores the device token as a generic password in the login Keychain, with the address
/// it belongs to in the item's generic attribute (`kSecAttrGeneric`).
///
/// The item is `ThisDeviceOnly` (never synced to iCloud) and readable after the
/// first unlock, so a background scan can run while the screen is locked.
public struct KeychainTokenStore: TokenStore {
    public static let defaultService = "studio.musenexus.witness"
    public static let defaultAccount = "device-token"

    public let service: String
    public let account: String

    public init(service: String = defaultService, account: String = defaultAccount) {
        self.service = service
        self.account = account
    }

    var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    /// What is written for a token: the secret, and the address it is for.
    static func itemValues(token: String, server: URL) -> [String: Any] {
        [
            kSecValueData as String: Data(token.utf8),
            kSecAttrGeneric as String: Data(ServerBinding.string(for: server).utf8),
        ]
    }

    /// Reads the token and its address from one `SecItemCopyMatching` result.
    static func savedKey(from item: [String: Any]) throws -> SavedKey {
        guard let data = item[kSecValueData as String] as? Data, let token = String(data: data, encoding: .utf8) else {
            throw KeychainError.unexpectedData
        }
        let server = (item[kSecAttrGeneric as String] as? Data).flatMap { String(data: $0, encoding: .utf8) }
        return SavedKey(token: token, server: server?.isEmpty == true ? nil : server)
    }

    public func readSavedKey() throws -> SavedKey? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let item = result as? [String: Any] else { throw KeychainError.unexpectedData }
            return try Self.savedKey(from: item)
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.status(status)
        }
    }

    public func writeToken(_ token: String, server: URL) throws {
        let values = Self.itemValues(token: token, server: server)
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, values as CFDictionary)
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var item = baseQuery.merging(values) { _, new in new }
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            item[kSecAttrLabel as String] = "Muse Nexus Witness device token"
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw KeychainError.status(addStatus) }
        default:
            throw KeychainError.status(updateStatus)
        }
    }

    public func deleteToken() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.status(status)
        }
    }
}

/// A token store that lives only in memory, for tests and previews.
public final class InMemoryTokenStore: TokenStore {
    private let storage: OSAllocatedUnfairLock<SavedKey?>

    /// - Parameter server: the address the token is for, as a URL string; nil for a
    ///   key saved before addresses were recorded.
    public init(token: String? = nil, server: String? = nil) {
        storage = OSAllocatedUnfairLock(initialState: token.map { token in
            SavedKey(token: token, server: server.flatMap(URL.init(string:)).map(ServerBinding.string(for:)))
        })
    }

    public func readSavedKey() throws -> SavedKey? {
        storage.withLock { $0 }
    }

    public func writeToken(_ token: String, server: URL) throws {
        storage.withLock { $0 = SavedKey(token: token, server: ServerBinding.string(for: server)) }
    }

    public func deleteToken() throws {
        storage.withLock { $0 = nil }
    }
}

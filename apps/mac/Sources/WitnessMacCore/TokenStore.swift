import Foundation
import os
import Security

/// Holds the device token. The real store is the Keychain; tests use `InMemoryTokenStore`.
public protocol TokenStore: Sendable {
    func readToken() throws -> String?
    func writeToken(_ token: String) throws
    func deleteToken() throws
    /// Where a saved token lives, for `witness-mac status`.
    var savedLocation: String { get }
}

extension TokenStore {
    public var savedLocation: String { "saved in the Keychain" }
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
/// scripted runs (the end-to-end test uses it). The Keychain is never read or
/// written: `login` with the same token saves only the server address, and
/// `logout` has nothing to remove.
public struct EnvironmentTokenStore: TokenStore {
    public static let variable = "WITNESS_TOKEN"
    public let token: String

    public init(token: String) {
        self.token = token
    }

    public func readToken() throws -> String? { token }

    public func writeToken(_ token: String) throws {
        guard token == self.token else { throw EnvironmentTokenError.differentToken }
    }

    public func deleteToken() throws {}

    public var savedLocation: String { "from WITNESS_TOKEN (the Keychain is not used)" }
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

/// Stores the device token as a generic password in the login Keychain.
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

    public func readToken() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data, let token = String(data: data, encoding: .utf8) else {
                throw KeychainError.unexpectedData
            }
            return token
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.status(status)
        }
    }

    public func writeToken(_ token: String) throws {
        let data = Data(token.utf8)
        let update: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        switch updateStatus {
        case errSecSuccess:
            return
        case errSecItemNotFound:
            var item = baseQuery
            item[kSecValueData as String] = data
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
    private let storage: OSAllocatedUnfairLock<String?>

    public init(token: String? = nil) {
        storage = OSAllocatedUnfairLock(initialState: token)
    }

    public func readToken() throws -> String? {
        storage.withLock { $0 }
    }

    public func writeToken(_ token: String) throws {
        storage.withLock { $0 = token }
    }

    public func deleteToken() throws {
        storage.withLock { $0 = nil }
    }
}

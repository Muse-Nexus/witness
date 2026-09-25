import Foundation

/// Where Witness for Mac keeps its own files.
public struct WitnessPaths: Sendable, Equatable {
    /// `~/Library/Application Support/Witness`
    public var supportDirectory: URL
    public var messagesDatabase: URL

    public init(supportDirectory: URL, messagesDatabase: URL) {
        self.supportDirectory = supportDirectory
        self.messagesDatabase = messagesDatabase
    }

    /// Overrides the support directory (config.json, cursor.json, lexicon.json): for tests
    /// and scripted runs of the CLI. A release build of the menu-bar app ignores it
    /// (`AppLaunchConfiguration`).
    public static let supportDirectoryVariable = "WITNESS_SUPPORT_DIR"

    public static func standard(environment: [String: String] = [:]) -> WitnessPaths {
        let supportDirectory: URL
        if let override = environment[supportDirectoryVariable], !override.isEmpty {
            supportDirectory = URL(fileURLWithPath: (override as NSString).expandingTildeInPath, isDirectory: true)
        } else {
            let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
            supportDirectory = applicationSupport.appendingPathComponent("Witness", isDirectory: true)
        }
        return WitnessPaths(supportDirectory: supportDirectory, messagesDatabase: MessagesDatabase.defaultURL)
    }

    public var configFile: URL { supportDirectory.appendingPathComponent("config.json") }
    public var cursorFile: URL { supportDirectory.appendingPathComponent("cursor.json") }
}

/// Settings stored in `config.json`. The device token is not here; it lives in the Keychain.
public struct WitnessConfig: Codable, Equatable, Sendable {
    public var apiUrl: String
    /// How far back to look, in days, when `--lookback` is not given. Without it too, a first
    /// scan looks back a year (`Lookback.default`) and a later one keeps the earlier choice.
    public var lookbackDays: Int?

    public init(apiUrl: String, lookbackDays: Int? = nil) {
        self.apiUrl = apiUrl
        self.lookbackDays = lookbackDays
    }
}

public enum ConfigError: Error, Equatable, CustomStringConvertible {
    case invalidURL
    case insecureURL
    case invalidToken

    public var description: String {
        switch self {
        case .invalidURL:
            "That server address does not look right. Use the full address, for example https://witness.example.com"
        case .insecureURL:
            "The server address must start with https:// (plain http is only allowed for localhost)."
        case .invalidToken:
            "That does not look like a device token. Device tokens start with wit_dev_ and come from Witness settings."
        }
    }
}

public struct ConfigStore: Sendable {
    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public func load() throws -> WitnessConfig? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        return try JSONDecoder().decode(WitnessConfig.self, from: Data(contentsOf: fileURL))
    }

    public func save(_ config: WitnessConfig) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        try AtomicFile.write(encoder.encode(config), to: fileURL)
    }

    public func delete() throws {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        try FileManager.default.removeItem(at: fileURL)
    }
}

public enum ConfigValidation {
    public static let deviceTokenPrefix = "wit_dev_"

    /// Accepts `https://` addresses, and `http://` only for this machine, so a
    /// bearer token is never sent in the clear over a network. An address with a user
    /// name or password in it is refused: it would sit in config.json in plain text, and
    /// `https://witness.example.com@other.example` really points at `other.example`.
    ///
    /// - Parameter allowLocalHTTP: whether `http://localhost` is allowed. The CLI allows
    ///   it for development; the released menu-bar app does not, so a local listener can
    ///   never stand in for a Witness.
    public static func normalizedAPIURL(_ raw: String, allowLocalHTTP: Bool = true) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              let host = components.host, !host.isEmpty,
              components.percentEncodedUser == nil, components.percentEncodedPassword == nil,
              !hasUserInfo(trimmed),
              components.query == nil, components.fragment == nil
        else { throw ConfigError.invalidURL }

        switch scheme {
        case "https":
            break
        case "http" where allowLocalHTTP && ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased()):
            break
        case "http":
            throw ConfigError.insecureURL
        default:
            throw ConfigError.invalidURL
        }

        var normalized = trimmed
        while normalized.hasSuffix("/") { normalized.removeLast() }
        // The phone-key screen shows the full capture address; the Mac adds that path itself.
        for suffix in ["/api/v1/capture", "/api/v1"] where normalized.lowercased().hasSuffix(suffix) {
            normalized.removeLast(suffix.count)
            while normalized.hasSuffix("/") { normalized.removeLast() }
        }
        guard let url = URL(string: normalized) else { throw ConfigError.invalidURL }
        return url
    }

    /// An "@" anywhere in the authority (between "//" and the next "/"), even an empty user
    /// name, which URLComponents reports as no user at all.
    static func hasUserInfo(_ address: String) -> Bool {
        guard let start = address.range(of: "//") else { return false }
        let authority = address[start.upperBound...].prefix { $0 != "/" && $0 != "?" && $0 != "#" }
        return authority.contains("@")
    }

    public static func validatedDeviceToken(_ raw: String) throws -> String {
        let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let suffix = token.dropFirst(deviceTokenPrefix.count)
        guard token.hasPrefix(deviceTokenPrefix),
              suffix.count >= 16,
              suffix.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
        else { throw ConfigError.invalidToken }
        return token
    }
}

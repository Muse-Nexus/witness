import Foundation

/// Saves a checked address and its key together: the address in `config.json`, the key in
/// the Keychain, tied to that address. It is one change: if either part cannot be saved,
/// both are put back as they were, so a failed save never leaves a new key next to an old
/// address (or the other way round).
public struct SignInStore: Sendable {
    public let paths: WitnessPaths
    public let tokenStore: any TokenStore

    public init(paths: WitnessPaths, tokenStore: any TokenStore) {
        self.paths = paths
        self.tokenStore = tokenStore
    }

    /// - Parameter server: a URL from `ConfigValidation.normalizedAPIURL`.
    /// - Throws: the first error. Nothing is changed when it throws, as far as this Mac allows.
    public func save(token: String, server: URL) throws {
        let configURL = paths.configFile
        let configStore = ConfigStore(fileURL: configURL)

        // What is there now, read before anything is written, so it can be put back. If it
        // cannot be read, nothing is written.
        let previousKey = try tokenStore.readSavedKey()
        let previousConfig: Data? = FileManager.default.fileExists(atPath: configURL.path)
            ? try Data(contentsOf: configURL)
            : nil

        // Other settings in config.json (the CLI's lookbackDays) are kept.
        var config = (try? configStore.load()) ?? WitnessConfig(apiUrl: server.absoluteString)
        config.apiUrl = server.absoluteString

        do {
            try tokenStore.writeToken(token, server: server)
            try configStore.save(config)
        } catch {
            try? tokenStore.restore(previousKey)
            if let previousConfig {
                try? AtomicFile.write(previousConfig, to: configURL)
            } else {
                try? configStore.delete()
            }
            throw error
        }
    }
}

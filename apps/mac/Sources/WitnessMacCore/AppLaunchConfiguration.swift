import Foundation

/// What the menu-bar app takes from the environment it was started with.
///
/// Witness.app holds Full Disk Access (and Contacts, with names on). Any program running
/// as the same person can start it with extra environment variables (`open --env`), so a
/// release build takes nothing from its environment: it always uses
/// `~/Library/Application Support/Witness`, the Keychain, the lexicon inside the app, and
/// https only. A development build still honours `WITNESS_SUPPORT_DIR`, `WITNESS_TOKEN`
/// and `WITNESS_LEXICON`, and allows `http://localhost`.
public struct AppLaunchConfiguration: Sendable {
    public let isDevelopmentBuild: Bool
    /// The variables the app honours: all of them in a development build, none otherwise.
    public let environment: [String: String]
    public let paths: WitnessPaths
    public let tokenStore: any TokenStore

    public init(processEnvironment: [String: String], isDevelopmentBuild: Bool) {
        self.isDevelopmentBuild = isDevelopmentBuild
        environment = isDevelopmentBuild ? processEnvironment : [:]
        paths = .standard(environment: environment)
        tokenStore = TokenStores.standard(environment: environment)
    }

    /// Fixed paths and key store, with no environment at all (debug snapshots, tests).
    public init(isDevelopmentBuild: Bool, paths: WitnessPaths, tokenStore: any TokenStore) {
        self.isDevelopmentBuild = isDevelopmentBuild
        environment = [:]
        self.paths = paths
        self.tokenStore = tokenStore
    }

    /// Whether `http://localhost` may be used as a Witness address.
    public var allowsLocalHTTP: Bool { isDevelopmentBuild }

    /// The lexicon to use: the copy inside the app. Only a development build, run from a
    /// build folder, looks elsewhere (`LexiconLocator`).
    public func lexiconURL(bundled: URL?) -> URL? {
        if let bundled { return bundled }
        guard isDevelopmentBuild else { return nil }
        return LexiconLocator.resolve(explicitPath: nil, environment: environment, supportDirectory: paths.supportDirectory)
    }
}

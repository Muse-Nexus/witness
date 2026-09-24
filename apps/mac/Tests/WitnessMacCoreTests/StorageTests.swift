import Foundation
import Security
import Testing
@testable import WitnessMacCore

@Suite("CursorStore")
struct CursorStoreTests {
    @Test("Nothing saved yet reads as nil")
    func emptyStore() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        #expect(try CursorStore(fileURL: temp.file("Witness/cursor.json")).load() == nil)
    }

    @Test("Saves atomically with private permissions and reads back")
    func roundTrip() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let directory = temp.url.appendingPathComponent("Witness")
        let store = CursorStore(fileURL: directory.appendingPathComponent("cursor.json"))
        let state = CursorState(lastRowID: 4_812, notBefore: 1_787_659_200_000, updatedAt: 1_790_251_200_000)

        try store.save(state)
        try store.save(state) // overwriting works too
        #expect(try store.load() == state)

        let fileMode = try FileManager.default.attributesOfItem(atPath: store.fileURL.path)[.posixPermissions] as? Int
        let directoryMode = try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? Int
        #expect(fileMode == 0o600)
        #expect(directoryMode == 0o700)
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path) == ["cursor.json"], "no temp files left")

        let json = try String(contentsOf: store.fileURL, encoding: .utf8)
        #expect(json.contains("\"lastRowID\" : 4812"))
    }

    @Test("First run starts just before the lookback window")
    func initialStateWithLookback() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let scenario = try StandardScenario(url: temp.file("chat.db"))
        let database = try MessagesDatabase(url: scenario.database.url)

        let thirtyDays = try CursorStore.initialState(database: database, now: testNow, lookbackDays: 30)
        #expect(thirtyDays.lastRowID == scenario.rows["thanks"]! - 1)
        #expect(thirtyDays.notBefore == AppleTime.unixMilliseconds(testNow) - 30 * dayMilliseconds)

        let ninetyDays = try CursorStore.initialState(database: database, now: testNow, lookbackDays: 90)
        #expect(ninetyDays.lastRowID == scenario.rows["old"]! - 1)

        let noLookback = try CursorStore.initialState(database: database, now: testNow, lookbackDays: 0)
        #expect(noLookback.lastRowID == scenario.maxRowID, "nothing is newer than now")
    }

    @Test("First run on an empty database starts at zero")
    func initialStateEmpty() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let db = try SyntheticChatDatabase(url: temp.file("chat.db"))
        let state = try CursorStore.initialState(database: MessagesDatabase(url: db.url), now: testNow)
        #expect(state.lastRowID == 0)
    }
}

@Suite("Config")
struct ConfigTests {
    @Test("Server addresses are normalised and must be https unless local")
    func apiURLs() throws {
        #expect(try ConfigValidation.normalizedAPIURL("https://witness.example.com/").absoluteString == "https://witness.example.com")
        #expect(try ConfigValidation.normalizedAPIURL(" https://example.com/witness// ").absoluteString == "https://example.com/witness")
        #expect(try ConfigValidation.normalizedAPIURL("http://localhost:8787").absoluteString == "http://localhost:8787")
        #expect(try ConfigValidation.normalizedAPIURL("http://127.0.0.1:8787").absoluteString == "http://127.0.0.1:8787")
        #expect(throws: ConfigError.insecureURL) { try ConfigValidation.normalizedAPIURL("http://witness.example.com") }
        #expect(throws: ConfigError.invalidURL) { try ConfigValidation.normalizedAPIURL("witness.example.com") }
        #expect(throws: ConfigError.invalidURL) { try ConfigValidation.normalizedAPIURL("ftp://witness.example.com") }
        #expect(throws: ConfigError.invalidURL) { try ConfigValidation.normalizedAPIURL("https://witness.example.com/?x=1") }
    }

    @Test("Server addresses never carry a user name or password")
    func apiURLsWithoutUserInfo() {
        // Credentials in the address would be saved in plain config.json and sent on every request,
        // and "https://witness.example.com@other.example" really points at other.example.
        for raw in [
            "https://user:secret@witness.example.com",
            "https://user@witness.example.com",
            "https://:secret@witness.example.com",
            "https://@witness.example.com",
            "https://witness.example.com@other.example.com",
            "http://user:secret@localhost:8787",
        ] {
            #expect(throws: ConfigError.invalidURL, "\(raw)") { try ConfigValidation.normalizedAPIURL(raw) }
        }
    }

    @Test("Device tokens must look like wit_dev_ tokens")
    func deviceTokens() throws {
        let token = "wit_dev_" + String(repeating: "Ab3-_", count: 8)
        #expect(try ConfigValidation.validatedDeviceToken("  \(token)\n") == token)
        #expect(throws: ConfigError.invalidToken) { try ConfigValidation.validatedDeviceToken("wit_agent_" + String(repeating: "a", count: 40)) }
        #expect(throws: ConfigError.invalidToken) { try ConfigValidation.validatedDeviceToken("wit_dev_short") }
        #expect(throws: ConfigError.invalidToken) { try ConfigValidation.validatedDeviceToken("wit_dev_" + String(repeating: "a", count: 20) + " x") }
    }

    @Test("config.json round-trips and never contains the token")
    func configStore() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let store = ConfigStore(fileURL: temp.file("Witness/config.json"))
        #expect(try store.load() == nil)
        let config = WitnessConfig(apiUrl: "https://witness.example.com", lookbackDays: 14)
        try store.save(config)
        #expect(try store.load() == config)
        let json = try String(contentsOf: store.fileURL, encoding: .utf8)
        #expect(json.contains("https://witness.example.com"))
        #expect(!json.contains("wit_"))
        try store.delete()
        #expect(try store.load() == nil)
    }

    static let server = URL(string: "https://witness.example.com")!

    @Test("The in-memory token store behaves like the Keychain store")
    func inMemoryTokens() throws {
        let store = InMemoryTokenStore()
        #expect(try store.readToken() == nil)
        try store.writeToken("wit_dev_one", server: Self.server)
        try store.writeToken("wit_dev_two", server: Self.server)
        #expect(try store.readToken() == "wit_dev_two")
        #expect(try store.readSavedKey() == SavedKey(token: "wit_dev_two", server: "https://witness.example.com"))
        try store.deleteToken()
        try store.deleteToken()
        #expect(try store.readToken() == nil)
    }

    @Test("A key is given only for the address it was saved for")
    func keyTiedToAddress() throws {
        let store = InMemoryTokenStore()
        #expect(try store.token(for: Self.server) == nil, "nothing saved")
        try store.writeToken("wit_dev_one", server: Self.server)
        #expect(try store.token(for: Self.server) == "wit_dev_one")
        #expect(try store.token(for: URL(string: "HTTPS://WITNESS.example.com:443/")!) == "wit_dev_one", "the same address, written differently")
        #expect(throws: KeyBindingError.otherAddress) { try store.token(for: URL(string: "https://witness.example.net")!) }
        #expect(throws: KeyBindingError.otherAddress) { try store.token(for: URL(string: "http://witness.example.com")!) }
        #expect(throws: KeyBindingError.otherAddress) { try store.token(for: URL(string: "https://witness.example.com:8443")!) }
        #expect(throws: KeyBindingError.otherAddress) { try store.token(for: URL(string: "http://127.0.0.1:8787")!) }

        // A key saved before addresses were recorded goes nowhere until it is saved again.
        let older = InMemoryTokenStore(token: "wit_dev_old")
        #expect(throws: KeyBindingError.otherAddress) { try older.token(for: Self.server) }
        #expect(!KeyBindingError.otherAddress.description.contains("!"))
    }

    @Test("Addresses are compared without case, default ports or a trailing slash")
    func serverBinding() {
        #expect(ServerBinding.string(for: URL(string: "HTTPS://Witness.Example.COM:443/")!) == "https://witness.example.com")
        #expect(ServerBinding.string(for: URL(string: "http://localhost:80")!) == "http://localhost")
        #expect(ServerBinding.string(for: URL(string: "https://example.com/witness/")!) == "https://example.com/witness")
        #expect(ServerBinding.string(for: URL(string: "https://example.com:8443")!) == "https://example.com:8443")
    }

    @Test("The Keychain item is addressed by the Witness service and account, and carries its address")
    func keychainQuery() throws {
        let query = KeychainTokenStore().baseQuery
        #expect(query[kSecAttrService as String] as? String == "studio.musenexus.witness")
        #expect(query[kSecAttrAccount as String] as? String == "device-token")
        #expect((query[kSecClass as String] as? String) == (kSecClassGenericPassword as String))

        let values = KeychainTokenStore.itemValues(token: "wit_dev_SYNTHETIC", server: URL(string: "https://Witness.example.com/")!)
        #expect(values[kSecValueData as String] as? Data == Data("wit_dev_SYNTHETIC".utf8))
        #expect(values[kSecAttrGeneric as String] as? Data == Data("https://witness.example.com".utf8))

        // Reading back what SecItemCopyMatching returns, with and without the address.
        var item = values
        item[kSecAttrService as String] = "studio.musenexus.witness"
        #expect(try KeychainTokenStore.savedKey(from: item) == SavedKey(token: "wit_dev_SYNTHETIC", server: "https://witness.example.com"))
        item[kSecAttrGeneric as String] = nil
        #expect(try KeychainTokenStore.savedKey(from: item) == SavedKey(token: "wit_dev_SYNTHETIC", server: nil))
        #expect(throws: KeychainError.unexpectedData) { try KeychainTokenStore.savedKey(from: [:]) }
    }

    @Test("Standard paths live under Application Support/Witness")
    func standardPaths() {
        let paths = WitnessPaths.standard()
        #expect(paths.supportDirectory.path.hasSuffix("Library/Application Support/Witness"))
        #expect(paths.configFile.lastPathComponent == "config.json")
        #expect(paths.cursorFile.lastPathComponent == "cursor.json")
        #expect(paths.messagesDatabase.path.hasSuffix("Library/Messages/chat.db"))
    }

    @Test("WITNESS_SUPPORT_DIR moves the support directory, and only that")
    func supportDirectoryOverride() {
        let paths = WitnessPaths.standard(environment: ["WITNESS_SUPPORT_DIR": "/tmp/witness-e2e/support"])
        #expect(paths.supportDirectory.path == "/tmp/witness-e2e/support")
        #expect(paths.configFile.path == "/tmp/witness-e2e/support/config.json")
        #expect(paths.messagesDatabase.path.hasSuffix("Library/Messages/chat.db"))
        #expect(WitnessPaths.standard(environment: ["WITNESS_SUPPORT_DIR": ""]).supportDirectory.path.hasSuffix("Application Support/Witness"))
    }

    @Test("WITNESS_TOKEN replaces the Keychain entirely")
    func environmentToken() throws {
        let store = TokenStores.standard(environment: ["WITNESS_TOKEN": "wit_dev_SYNTHETIC"])
        let environment = try #require(store as? EnvironmentTokenStore)
        #expect(try environment.readToken() == "wit_dev_SYNTHETIC")
        try environment.writeToken("wit_dev_SYNTHETIC", server: Self.server)
        #expect(throws: EnvironmentTokenError.differentToken) { try environment.writeToken("wit_dev_OTHER", server: Self.server) }
        try environment.deleteToken()
        #expect(try environment.readToken() == "wit_dev_SYNTHETIC")
        // The person running the command gives the token and the address together.
        #expect(try environment.token(for: URL(string: "http://127.0.0.1:8787")!) == "wit_dev_SYNTHETIC")
        #expect(environment.savedLocation.contains("WITNESS_TOKEN"))
        #expect(TokenStores.standard(environment: [:]) is KeychainTokenStore)
        #expect(TokenStores.standard(environment: ["WITNESS_TOKEN": ""]) is KeychainTokenStore)
    }

    @Test("A release build of the app ignores WITNESS_SUPPORT_DIR, WITNESS_TOKEN and WITNESS_LEXICON")
    func releaseAppIgnoresEnvironment() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        try Data(#"{"version":1,"categories":{}}"#.utf8).write(to: temp.file("lexicon.json"))
        let environment = [
            "WITNESS_SUPPORT_DIR": temp.url.path,
            "WITNESS_TOKEN": "wit_dev_SYNTHETIC",
            "WITNESS_LEXICON": temp.file("lexicon.json").path,
        ]

        let release = AppLaunchConfiguration(processEnvironment: environment, isDevelopmentBuild: false)
        #expect(release.paths == WitnessPaths.standard())
        #expect(release.tokenStore is KeychainTokenStore)
        #expect(release.environment.isEmpty)
        #expect(!release.allowsLocalHTTP)
        #expect(release.lexiconURL(bundled: nil) == nil, "only the lexicon inside the app")
        let bundled = URL(fileURLWithPath: "/Applications/Witness.app/Contents/Resources/lexicon.json")
        #expect(release.lexiconURL(bundled: bundled) == bundled)

        let development = AppLaunchConfiguration(processEnvironment: environment, isDevelopmentBuild: true)
        #expect(development.paths.supportDirectory.path == temp.url.path)
        #expect(development.tokenStore is EnvironmentTokenStore)
        #expect(development.allowsLocalHTTP)
        #expect(development.lexiconURL(bundled: nil)?.path == temp.file("lexicon.json").path)
    }
}

@Suite("FullDiskAccess")
struct FullDiskAccessTests {
    @Test("A readable file is granted")
    func granted() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let file = temp.file("chat.db")
        try Data("synthetic".utf8).write(to: file)
        #expect(FullDiskAccess.check(path: file.path) == .granted)
    }

    @Test("An unreadable file is denied", .enabled(if: getuid() != 0, "root ignores file permissions"))
    func denied() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let file = temp.file("chat.db")
        try Data("synthetic".utf8).write(to: file)
        #expect(chmod(file.path, 0o000) == 0)
        defer { chmod(file.path, 0o600) }
        #expect(FullDiskAccess.check(path: file.path) == .denied)
        #expect(FileManager.default.fileExists(atPath: file.path), "fileExists would have said yes")
    }

    @Test("A missing file is missing, including under a file")
    func missing() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        #expect(FullDiskAccess.check(path: temp.file("absent.db").path) == .missing)
        let file = temp.file("plain")
        try Data().write(to: file)
        #expect(FullDiskAccess.check(path: file.appendingPathComponent("chat.db").path) == .missing)
    }

    @Test("The Settings link opens Full Disk Access")
    func settingsLink() {
        #expect(FullDiskAccess.settingsURLString == "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        #expect(URL(string: FullDiskAccess.settingsURLString) != nil)
    }
}

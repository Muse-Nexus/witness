import Foundation
import Security
import Testing
@testable import WitnessMacCore

@Suite("CLI parsing")
struct CLIParserTests {
    @Test("Commands and their options")
    func commands() throws {
        #expect(try CLIParser.parse([]) == .help)
        #expect(try CLIParser.parse(["--help"]) == .help)
        #expect(try CLIParser.parse(["--version"]) == .version)
        #expect(try CLIParser.parse(["status"]) == .status(SourceOptions()))
        #expect(try CLIParser.parse(["status", "--db", "/tmp/chat.db"]) == .status(SourceOptions(databasePath: "/tmp/chat.db")))
        #expect(try CLIParser.parse(["logout"]) == .logout)
        #expect(try CLIParser.parse(["run", "--lexicon=/tmp/l.json"]) == .run(SourceOptions(lexiconPath: "/tmp/l.json")))
        #expect(
            try CLIParser.parse(["scan", "--once", "--db", "/tmp/chat.db", "--lexicon", "/tmp/l.json", "--dry-run", "--lookback-days", "7"])
                == .scan(SourceOptions(databasePath: "/tmp/chat.db", lexiconPath: "/tmp/l.json", lookbackDays: 7), dryRun: true)
        )
        #expect(try CLIParser.parse(["scan", "--once"]) == .scan(SourceOptions(), dryRun: false))
        #expect(
            try CLIParser.parse(["login", "--url", "https://witness.example.com", "--token=wit_dev_x"])
                == .login(url: "https://witness.example.com", token: "wit_dev_x")
        )
        #expect(try CLIParser.parse(["login", "--url", "https://witness.example.com"]) == .login(url: "https://witness.example.com", token: nil))
    }

    @Test("Mistakes get a plain explanation", arguments: [
        ["frobnicate"],
        ["scan", "--db"],
        ["scan", "--db", "--dry-run"],
        ["scan", "extra"],
        ["scan", "--lookback-days", "soon"],
        ["scan", "--dry-run=yes"],
        ["status", "--lookback-days", "3"],
        ["login"],
        ["login", "--url", "https://witness.example.com", "--verbose"],
        ["logout", "now"],
    ])
    func usageErrors(arguments: [String]) {
        #expect(throws: CLIUsageError.self) { try CLIParser.parse(arguments) }
    }
}

@Suite("CLI runner")
struct CLIRunnerTests {
    static let token = "wit_dev_" + String(repeating: "R", count: 43)

    struct Harness {
        let temp: TemporaryDirectory
        let scenario: StandardScenario
        let output = LineBuffer()
        let errors = LineBuffer()
        let tokenStore = InMemoryTokenStore()
        let transport = MockTransport()
        let paths: WitnessPaths

        init() throws {
            temp = try TemporaryDirectory()
            try FileManager.default.createDirectory(at: temp.file("Messages"), withIntermediateDirectories: true)
            scenario = try StandardScenario(url: temp.file("Messages/chat.db"))
            paths = WitnessPaths(supportDirectory: temp.file("Witness"), messagesDatabase: scenario.database.url)
        }

        var runner: CLIRunner {
            CLIRunner(environment: CLIEnvironment(
                paths: paths,
                tokenStore: tokenStore,
                transport: transport,
                retryPolicy: RetryPolicy(maxAttempts: 1, baseDelay: 0, maxDelay: 0, jitter: 0),
                environment: [:],
                now: { testNow },
                output: output.append,
                errorOutput: errors.append,
                readSecret: { _ in CLIRunnerTests.token },
                watchDebounce: 0.1,
                watchSafetyInterval: 0
            ))
        }

        func run(_ arguments: String...) async -> Int32 {
            await runner.run(arguments: arguments)
        }

        /// Everything printed, to check that no message text ever appears.
        var everything: String { output.text + "\n" + errors.text }
    }

    @Test("status reports access, server, token and cursor without secrets or messages")
    func status() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        #expect(await harness.run("login", "--url", "https://witness.example.com/") == ExitCode.ok)
        #expect(await harness.run("status", "--lexicon", Fixtures.lexiconURL.path) == ExitCode.ok)

        let text = harness.output.text
        #expect(text.contains("MUSE NEXUS"))
        #expect(text.contains("Witness."))
        #expect(text.contains("Messages access") && text.contains("granted"))
        #expect(text.contains("https://witness.example.com"))
        #expect(text.contains("saved in the Keychain"))
        #expect(text.contains("not started"))
        #expect(text.contains("version 1"))
        #expect(!harness.everything.contains(Self.token))
        for message in StandardScenario.Text.all {
            #expect(!harness.everything.contains(message))
        }
    }

    @Test("status explains how to grant Full Disk Access", .enabled(if: getuid() != 0))
    func statusWithoutAccess() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let path = harness.scenario.database.url.path
        #expect(chmod(path, 0o000) == 0)
        defer { chmod(path, 0o644) }

        #expect(await harness.run("status") == ExitCode.ok)
        #expect(harness.output.text.contains("not granted"))
        #expect(harness.output.text.contains(FullDiskAccess.settingsURLString))

        #expect(await harness.run("scan", "--once", "--dry-run", "--lexicon", Fixtures.lexiconURL.path) == ExitCode.noPermission)
        #expect(harness.errors.text.contains("Full Disk Access"))
    }

    @Test("scan --dry-run prints counts only")
    func dryRun() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let code = await harness.run("scan", "--once", "--dry-run", "--lexicon", Fixtures.lexiconURL.path)
        #expect(code == ExitCode.ok)
        #expect(harness.output.lines == [
            "Dry run, nothing sent: scanned 13 · skipped 5 · excluded 3 · no cue 1 · candidates 4 · sent 0",
        ])
        #expect(await harness.transport.requests.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: harness.paths.cursorFile.path))
        for message in StandardScenario.Text.all {
            #expect(!harness.everything.contains(message))
        }
    }

    @Test("scan sends candidates once signed in, and prints counts only")
    func scan() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }

        #expect(await harness.run("scan", "--once", "--lexicon", Fixtures.lexiconURL.path) == ExitCode.configuration)
        #expect(harness.errors.text.contains("not signed in"))

        #expect(await harness.run("login", "--url", "https://witness.example.com", "--token", Self.token) == ExitCode.ok)
        #expect(await harness.run("scan", "--once", "--lexicon", Fixtures.lexiconURL.path) == ExitCode.ok)
        #expect(harness.output.lines.last == "scanned 13 · skipped 5 · excluded 3 · no cue 1 · candidates 4 · sent 4")
        // One check of the address and key at login, then the four candidates.
        #expect(await harness.transport.requests.count == 5)
        let authorization = await harness.transport.requests.last?.value(forHTTPHeaderField: "Authorization")
        #expect(authorization == "Bearer \(Self.token)")
        for message in StandardScenario.Text.all {
            #expect(!harness.everything.contains(message))
        }
        #expect(!harness.everything.contains(Self.token))
    }

    @Test("run scans at startup, again when Messages writes, and stops cleanly when cancelled")
    func runLoop() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        #expect(await harness.run("login", "--url", "https://witness.example.com") == ExitCode.ok)

        let runner = harness.runner
        let task = Task { await runner.run(.run(SourceOptions(lexiconPath: Fixtures.lexiconURL.path))) }

        func waitFor(_ fragment: String) async {
            let deadline = Date().addingTimeInterval(10)
            while Date() < deadline, !harness.output.text.contains(fragment) {
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
        }

        await waitFor("sent 4")
        #expect(harness.output.text.contains("candidates 4 · sent 4"))

        let handle = try harness.scenario.database.addHandle("+12065550111")
        try harness.scenario.database.addMessage(.init(
            guid: "F0000000-0000-4000-8000-0000000000F4", text: "Proud of you, always",
            handleID: handle, date: SyntheticChatDatabase.appleNanoseconds(daysAgo: 0.01)))
        await waitFor("candidates 1 · sent 1")
        #expect(harness.output.text.contains("scanned 1 · skipped 0 · excluded 0 · no cue 0 · candidates 1 · sent 1"))

        task.cancel()
        #expect(await task.value == ExitCode.ok)
        #expect(harness.output.lines.last == "Stopped.")
        #expect(await harness.transport.requests.count == 6)
        for message in StandardScenario.Text.all + ["Proud of you, always"] {
            #expect(!harness.everything.contains(message))
        }
    }

    @Test("A refused token exits with a permission error and a way forward")
    func refusedToken() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        #expect(await harness.run("login", "--url", "https://witness.example.com") == ExitCode.ok)
        await harness.transport.setReplies([.status(401)])
        #expect(await harness.run("scan", "--once", "--lexicon", Fixtures.lexiconURL.path) == ExitCode.noPermission)
        #expect(harness.errors.text.contains("witness-mac login"))
    }

    @Test("login validates the address and token")
    func loginValidation() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        #expect(await harness.run("login", "--url", "http://witness.example.com", "--token", Self.token) == ExitCode.usage)
        #expect(await harness.run("login", "--url", "https://witness.example.com", "--token", "wit_agent_nope") == ExitCode.usage)
        #expect(try harness.tokenStore.readToken() == nil)
        #expect(!FileManager.default.fileExists(atPath: harness.paths.configFile.path))
    }

    @Test("login checks the address and key, and takes the address the phone-key screen shows")
    func loginChecks() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        await harness.transport.setReplies([.status(400, body: #"{"error":{"code":"invalid_request","message":"x"}}"#)])
        #expect(await harness.run("login", "--url", "https://witness.example.com/api/v1/capture", "--token", Self.token) == ExitCode.ok)
        let saved = try ConfigStore(fileURL: harness.paths.configFile).load()
        #expect(saved?.apiUrl == "https://witness.example.com")
        let check = try #require(await harness.transport.requests.first)
        #expect(check.url?.absoluteString == "https://witness.example.com/api/v1/capture")
        #expect(check.httpBody == Data("{}".utf8))
    }

    @Test("login refuses an address that is not a Witness, or a refused key, and saves nothing")
    func loginRefuses() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        await harness.transport.setReplies([.status(404, body: "<html>Not found</html>")])
        #expect(await harness.run("login", "--url", "https://witness.example.com/elsewhere", "--token", Self.token) == ExitCode.usage)
        #expect(harness.errors.text.contains("There is no Witness at"))
        await harness.transport.setReplies([.status(401)])
        #expect(await harness.run("login", "--url", "https://witness.example.com", "--token", Self.token) == ExitCode.noPermission)
        #expect(try harness.tokenStore.readToken() == nil)
        #expect(!FileManager.default.fileExists(atPath: harness.paths.configFile.path))

        // An address that does not exist or is not trusted is a problem with the address.
        await harness.transport.setReplies([.failure(.cannotFindHost)])
        #expect(await harness.run("login", "--url", "https://witness.example.invalid", "--token", Self.token) == ExitCode.usage)
        #expect(harness.errors.text.contains("No server answers"))
        await harness.transport.setReplies([.failure(.serverCertificateUntrusted)])
        #expect(await harness.run("login", "--url", "https://witness.example.com", "--token", Self.token) == ExitCode.usage)
        #expect(harness.errors.text.contains("security certificate"))

        // Unreachable right now: nothing is saved, and it says to try again.
        await harness.transport.setReplies([.failure(.notConnectedToInternet)])
        #expect(await harness.run("login", "--url", "https://witness.example.com", "--token", Self.token) == ExitCode.temporaryFailure)
        #expect(harness.errors.text.contains("could not be reached just now, so nothing was saved"))
        #expect(try harness.tokenStore.readToken() == nil)
        #expect(!FileManager.default.fileExists(atPath: harness.paths.configFile.path))
    }

    @Test("A token is sent only to the address it was saved for")
    func tokenTiedToAddress() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        #expect(await harness.run("login", "--url", "https://witness.example.com") == ExitCode.ok)
        #expect(try harness.tokenStore.readSavedKey()?.server == "https://witness.example.com")

        // config.json now names another server; the token is not sent there.
        try ConfigStore(fileURL: harness.paths.configFile).save(WitnessConfig(apiUrl: "https://listener.example.net"))
        let before = await harness.transport.requests.count
        #expect(await harness.run("scan", "--once", "--lexicon", Fixtures.lexiconURL.path) == ExitCode.configuration)
        #expect(harness.errors.text.contains("saved for a different address"))
        #expect(await harness.transport.requests.count == before)
        #expect(await harness.run("status", "--lexicon", Fixtures.lexiconURL.path) == ExitCode.ok)
        #expect(harness.output.text.contains("saved for a different address"))
        #expect(!harness.everything.contains("!"))
    }

    @Test("logout removes the token")
    func logout() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        #expect(await harness.run("login", "--url", "https://witness.example.com") == ExitCode.ok)
        #expect(try harness.tokenStore.readToken() == Self.token)
        #expect(await harness.run("logout") == ExitCode.ok)
        #expect(try harness.tokenStore.readToken() == nil)
    }

    @Test("A Keychain that refuses access is reported, not mistaken for signed out")
    func keychainRefused() async throws {
        struct RefusingTokenStore: TokenStore {
            func readSavedKey() throws -> SavedKey? { throw KeychainError.status(errSecAuthFailed) }
            func writeToken(_ token: String, server: URL) throws { throw KeychainError.status(errSecAuthFailed) }
            func deleteToken() throws { throw KeychainError.status(errSecAuthFailed) }
        }
        let harness = try Harness()
        defer { harness.temp.remove() }
        try ConfigStore(fileURL: harness.paths.configFile).save(WitnessConfig(apiUrl: "https://witness.example.com"))
        var environment = harness.runner.env
        environment.tokenStore = RefusingTokenStore()
        let runner = CLIRunner(environment: environment)

        #expect(await runner.run(arguments: ["status"]) == ExitCode.ok)
        #expect(harness.output.text.contains("could not be read"))
        let code = await runner.run(arguments: ["scan", "--once", "--lexicon", Fixtures.lexiconURL.path])
        #expect(code == ExitCode.noPermission)
        #expect(harness.errors.text.contains("Always Allow"))
    }

    @Test("A missing lexicon is a configuration error")
    func missingLexicon() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let code = await harness.run("scan", "--once", "--dry-run", "--lexicon", harness.temp.file("nope.json").path)
        #expect(code == ExitCode.configuration)
    }

    @Test("A missing Messages database is reported plainly")
    func missingDatabase() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let code = await harness.run("scan", "--once", "--dry-run", "--db", harness.temp.file("absent/chat.db").path)
        #expect(code == ExitCode.noInput)
    }

    @Test("Product copy has no exclamation marks")
    func voice() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        _ = await harness.run("--help")
        _ = await harness.run("status")
        _ = await harness.run("login", "--url", "https://witness.example.com")
        _ = await harness.run("scan", "--once", "--dry-run", "--lexicon", Fixtures.lexiconURL.path)
        #expect(!harness.everything.contains("!"))
    }

    @Test("Colour only on a terminal and never with NO_COLOR")
    func colour() {
        #expect(Brand.shouldUseColor(environment: [:], isTerminal: true))
        #expect(!Brand.shouldUseColor(environment: [:], isTerminal: false))
        #expect(!Brand.shouldUseColor(environment: ["NO_COLOR": "1"], isTerminal: true))
        #expect(Brand(useColor: false).wordmark(subtitle: "for Mac") == "▍MUSE NEXUS\nWitness.  for Mac")
    }
}

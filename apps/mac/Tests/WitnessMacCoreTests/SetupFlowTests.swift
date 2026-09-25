import Darwin
import Foundation
import Testing
@testable import WitnessMacCore

@Suite("Setup flow")
struct SetupFlowTests {
    let now = testNow

    @Test("First run goes through the five steps in order and finishes after the last")
    func linear() {
        var flow = SetupFlow(progress: SetupProgress(), mode: .firstRun)
        #expect(flow.currentStep == .server)
        #expect(flow.stepCaption == "Step 1 of 5")
        #expect(!flow.canGoBack)

        var visited: [SetupStep] = []
        while let step = flow.currentStep {
            visited.append(step)
            flow.complete(now: now)
        }
        #expect(visited == [.server, .fullDiskAccess, .names, .startAtLogin, .lookback])
        #expect(flow.isAtEnd)
        #expect(flow.progress.isFinished)
        #expect(flow.progress.finishedAt == AppleTime.unixMilliseconds(now))
        #expect(SetupStep.allCases.allSatisfy { flow.progress.outcome(of: $0) == .done })
    }

    @Test("Every step can be skipped, and skipping never undoes a done step")
    func skipping() {
        var flow = SetupFlow(progress: SetupProgress(), mode: .firstRun)
        flow.markDone(.server)
        flow.skip(now: now) // server: already done, stays done
        #expect(flow.currentStep == .fullDiskAccess)
        flow.skip(now: now)
        flow.skip(now: now)
        flow.complete(now: now)
        flow.skip(now: now)
        #expect(flow.isAtEnd)
        #expect(flow.progress.outcome(of: .server) == .done)
        #expect(flow.progress.outcome(of: .fullDiskAccess) == .skipped)
        #expect(flow.progress.outcome(of: .names) == .skipped)
        #expect(flow.progress.outcome(of: .startAtLogin) == .done)
        #expect(flow.progress.outcome(of: .lookback) == .skipped)
        #expect(flow.progress.isFinished)
    }

    @Test("Back goes one step back, and from the closing screen to the last step")
    func back() {
        var flow = SetupFlow(progress: SetupProgress(), mode: .firstRun)
        flow.back()
        #expect(flow.currentStep == .server, "nothing before the first step")
        flow.complete(now: now)
        flow.complete(now: now)
        #expect(flow.currentStep == .names)
        flow.back()
        #expect(flow.currentStep == .fullDiskAccess)
        flow.go(to: .lookback)
        flow.complete(now: now)
        #expect(flow.isAtEnd && flow.canGoBack)
        flow.back()
        #expect(flow.currentStep == .lookback)
    }

    @Test("Quitting halfway resumes at the first step still open")
    func resume() {
        var flow = SetupFlow(progress: SetupProgress(), mode: .firstRun)
        flow.complete(now: now)
        flow.skip(now: now)
        let saved = flow.progress
        #expect(!saved.isFinished)

        let resumed = SetupFlow(progress: saved, mode: .firstRun)
        #expect(resumed.currentStep == .names)
    }

    @Test("Closing the window finishes setup and counts open steps as skipped")
    func close() {
        var flow = SetupFlow(progress: SetupProgress(), mode: .firstRun)
        flow.complete(now: now)
        flow.close(now: now)
        #expect(flow.isAtEnd)
        #expect(flow.progress.isFinished)
        #expect(flow.progress.outcome(of: .server) == .done)
        #expect(SetupStep.allCases.dropFirst().allSatisfy { flow.progress.outcome(of: $0) == .skipped })

        // Closing again later (from Settings) keeps the first finish time.
        var settings = SetupFlow(progress: flow.progress, mode: .settings)
        settings.close(now: now.addingTimeInterval(3_600))
        #expect(settings.progress.finishedAt == AppleTime.unixMilliseconds(now))
    }

    @Test("Settings opens at any step; with none given, at the server")
    func settingsMode() {
        let finished = SetupProgress(outcomes: [.server: .done], finishedAt: 1)
        #expect(SetupFlow(progress: finished, mode: .settings).currentStep == .server)
        #expect(SetupFlow(progress: finished, mode: .settings, startAt: .fullDiskAccess).currentStep == .fullDiskAccess)
        let allDone = SetupProgress(outcomes: Dictionary(uniqueKeysWithValues: SetupStep.allCases.map { ($0, .done) }), finishedAt: 1)
        #expect(SetupFlow(progress: allDone, mode: .firstRun).isAtEnd, "first run with nothing left shows the closing screen")
    }

    @Test("Progress survives a round trip through app-state.json and ignores unknown steps")
    func progressCoding() throws {
        var progress = SetupProgress(outcomes: [.server: .done, .names: .skipped], finishedAt: 42)
        progress.outcomes["photos"] = .skipped // a step from a newer version
        let decoded = try JSONDecoder().decode(SetupProgress.self, from: JSONEncoder().encode(progress))
        #expect(decoded == progress)
        #expect(decoded.outcome(of: .server) == .done)
        #expect(decoded.firstOpenStep == .fullDiskAccess)
    }
}

@Suite("Full Disk Access step")
struct FullDiskAccessStepTests {
    @Test("Shows the check mark as soon as access works")
    func granted() {
        let watch = FullDiskAccessWatch()
        #expect(watch.phase(for: .granted, now: testNow) == .granted)
    }

    @Test("Waits, then offers a relaunch a while after System Settings was opened")
    func relaunchHint() {
        var watch = FullDiskAccessWatch()
        #expect(watch.phase(for: .denied, now: testNow) == .waiting, "settings not opened yet")
        watch.openedSettings(at: testNow)
        #expect(watch.phase(for: .denied, now: testNow.addingTimeInterval(3)) == .waiting)
        #expect(watch.phase(for: .denied, now: testNow.addingTimeInterval(FullDiskAccessWatch.relaunchHintDelay)) == .mayNeedRelaunch)
        #expect(watch.phase(for: .unavailable(errno: 5), now: testNow.addingTimeInterval(60)) == .mayNeedRelaunch)
        #expect(watch.phase(for: .granted, now: testNow.addingTimeInterval(60)) == .granted)
    }

    @Test("Says so when there is no Messages database")
    func missing() {
        #expect(FullDiskAccessWatch().phase(for: .missing, now: testNow) == .noMessages)
    }
}

@Suite("Server step")
struct ServerConnectorTests {
    static let key = WitnessClientTests.token
    static let statusBody = #"{"saved":3,"maybe":1,"lastCapturedAt":1790200000000,"sources":[],"rhythm":{"enabled":false,"nextAt":null,"pausedUntil":null}}"#
    static let captureRejected = MockTransport.Reply.status(400, body: #"{"error":{"code":"bad_request","message":"Send text, an image, or both."}}"#)

    func connector(
        _ transport: MockTransport,
        tokens: InMemoryTokenStore = InMemoryTokenStore(),
        in temp: TemporaryDirectory,
        allowLocalHTTP: Bool = false
    ) -> ServerConnector {
        ServerConnector(
            paths: WitnessPaths(supportDirectory: temp.url, messagesDatabase: temp.file("chat.db")),
            tokenStore: tokens,
            transport: transport,
            retryPolicy: RetryPolicy(maxAttempts: 1, baseDelay: 0, maxDelay: 0, jitter: 0),
            allowLocalHTTP: allowLocalHTTP
        )
    }

    @Test("A key that can read status is checked with GET /api/v1/status, then saved")
    func statusOK() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let transport = MockTransport(replies: [.status(200, body: Self.statusBody)])
        let tokens = InMemoryTokenStore()
        let connector = connector(transport, tokens: tokens, in: temp)

        let state = await connector.connect(address: " https://witness.example.com/api/v1/capture ", key: " \(Self.key) ")
        #expect(state == .connected(host: "witness.example.com"))
        #expect(state.isConnected)

        let request = try #require(await transport.requests.first)
        #expect(request.httpMethod == "GET")
        #expect(request.url?.absoluteString == "https://witness.example.com/api/v1/status")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(Self.key)")
        #expect(await transport.requests.count == 1)

        #expect(try tokens.readToken() == Self.key)
        #expect(try tokens.readSavedKey()?.server == "https://witness.example.com", "the key is tied to the address it was checked with")
        #expect(connector.savedAddress() == "https://witness.example.com")
        #expect(connector.hasSavedKey())
        #expect(connector.hasKeyForSavedAddress())

        // If config.json later names another address, the saved key no longer counts as set up.
        try ConfigStore(fileURL: temp.file("config.json")).save(WitnessConfig(apiUrl: "https://listener.example.net"))
        #expect(connector.hasSavedKey())
        #expect(!connector.hasKeyForSavedAddress())
    }

    @Test("A capture-only key (403 on status) is checked with an empty capture instead")
    func captureOnlyKey() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let transport = MockTransport(replies: [.status(403, body: #"{"error":{"code":"forbidden","message":"x"}}"#), Self.captureRejected])
        let connector = connector(transport, in: temp)

        #expect(await connector.connect(address: "https://witness.example.com", key: Self.key) == .connected(host: "witness.example.com"))
        let methods = await transport.requests.map { "\($0.httpMethod ?? "") \($0.url?.path ?? "")" }
        #expect(methods == ["GET /api/v1/status", "POST /api/v1/capture"])
        #expect(connector.hasSavedKey())
    }

    @Test("A refused key is reported and nothing is saved", arguments: [
        [MockTransport.Reply.status(401, body: #"{"error":{"code":"unauthorized","message":"x"}}"#)],
        [MockTransport.Reply.status(403, body: "{}"), MockTransport.Reply.status(403, body: "{}")],
    ])
    func refused(replies: [MockTransport.Reply]) async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let connector = connector(MockTransport(replies: replies), in: temp)
        #expect(await connector.connect(address: "https://witness.example.com", key: Self.key) == .problem(.keyRefused))
        #expect(!connector.hasSavedKey())
        #expect(connector.savedAddress() == nil)
    }

    @Test("An address that is not a Witness is reported and nothing is saved")
    func notWitness() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let connector = connector(MockTransport(replies: [.status(404, body: "<html>")]), in: temp)
        let state = await connector.connect(address: "https://example.com", key: Self.key)
        #expect(state == .problem(.notWitness(status: 404)))
        #expect(state.message?.contains("404") == true)
        #expect(!connector.hasSavedKey())

        let html = self.connector(MockTransport(replies: [.status(200, body: "<html>")]), in: temp)
        #expect(await html.connect(address: "https://example.com", key: Self.key) == .problem(.notWitness(status: 200)))
    }

    @Test("When Witness cannot be reached, nothing is saved, and Check and save works again later")
    func unreachable() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let transport = MockTransport(replies: [.failure(.notConnectedToInternet)], fallback: .status(200, body: Self.statusBody))
        let connector = connector(transport, in: temp)
        let state = await connector.connect(address: "https://witness.example.com", key: Self.key)
        #expect(state == .unreachable(host: "witness.example.com"))
        #expect(!state.isConnected)
        #expect(state.message?.contains("nothing was saved") == true)
        #expect(!connector.hasSavedKey())
        #expect(connector.savedAddress() == nil)

        #expect(await connector.connect(address: "https://witness.example.com", key: Self.key) == .connected(host: "witness.example.com"))
        #expect(connector.hasKeyForSavedAddress())
    }

    @Test("A mistyped domain or an untrusted certificate is a problem with the address, and nothing is saved", arguments: [
        (URLError.Code.cannotFindHost, ServerProblem.hostNotFound),
        (URLError.Code.dnsLookupFailed, ServerProblem.hostNotFound),
        (URLError.Code.serverCertificateUntrusted, ServerProblem.untrustedCertificate),
        (URLError.Code.serverCertificateHasBadDate, ServerProblem.untrustedCertificate),
        (URLError.Code.secureConnectionFailed, ServerProblem.untrustedCertificate),
    ])
    func badAddress(code: URLError.Code, problem: ServerProblem) async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let connector = connector(MockTransport(replies: [.failure(code)]), in: temp)
        #expect(await connector.connect(address: "https://witness.musenexus.stuido", key: Self.key) == .problem(problem))
        #expect(!connector.hasSavedKey())
        #expect(connector.savedAddress() == nil)
    }

    @Test("http://localhost is accepted only when the build allows it")
    func localHTTP() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let release = connector(MockTransport(replies: [.status(200, body: Self.statusBody)]), in: temp)
        #expect(await release.connect(address: "http://127.0.0.1:8787", key: Self.key) == .problem(.insecureAddress))
        #expect(await release.connect(address: "http://localhost:8787", key: Self.key) == .problem(.insecureAddress))
        #expect(!release.hasSavedKey())

        let development = connector(MockTransport(replies: [.status(200, body: Self.statusBody)]), in: temp, allowLocalHTTP: true)
        #expect(await development.connect(address: "http://127.0.0.1:8787", key: Self.key) == .connected(host: "127.0.0.1"))
    }

    @Test("A mistyped address or key is caught before anything is sent")
    func validation() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let transport = MockTransport()
        let connector = connector(transport, in: temp)
        #expect(await connector.connect(address: "witness", key: Self.key) == .problem(.invalidAddress))
        #expect(await connector.connect(address: "http://witness.example.com", key: Self.key) == .problem(.insecureAddress))
        #expect(await connector.connect(address: "https://witness.example.com", key: "wit_agent_nope") == .problem(.invalidKey))
        #expect(await transport.requests.isEmpty)
    }

    @Test("Saving keeps the lookback the CLI saved, and the key can be removed")
    func keepsConfigAndRemoves() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        try ConfigStore(fileURL: temp.file("config.json")).save(WitnessConfig(apiUrl: "https://old.example.com", lookbackDays: 7))
        let connector = connector(MockTransport(replies: [.status(200, body: Self.statusBody)]), in: temp)
        _ = await connector.connect(address: "https://witness.example.com", key: Self.key)
        #expect(try ConfigStore(fileURL: temp.file("config.json")).load() == WitnessConfig(apiUrl: "https://witness.example.com", lookbackDays: 7))

        try connector.removeKey()
        #expect(!connector.hasSavedKey())
        #expect(connector.savedAddress() == "https://witness.example.com", "the address stays, so a new key is quick to add")
    }

    @Test("If the address cannot be saved, the key saved before is put back too", .enabled(if: getuid() != 0))
    func failedSaveRestoresBoth() async throws {
        let temp = try TemporaryDirectory()
        defer {
            chmod(temp.url.path, 0o755)
            temp.remove()
        }
        try ConfigStore(fileURL: temp.file("config.json")).save(WitnessConfig(apiUrl: "https://old.example.com", lookbackDays: 7))
        let tokens = InMemoryTokenStore(token: "wit_dev_" + String(repeating: "O", count: 43), server: "https://old.example.com")
        let keyBefore = try tokens.readSavedKey()
        let configBefore = try Data(contentsOf: temp.file("config.json"))
        let connector = connector(MockTransport(replies: [.status(200, body: Self.statusBody)]), tokens: tokens, in: temp)

        // config.json cannot be replaced now: the new key must not stay behind on its own.
        #expect(chmod(temp.url.path, 0o500) == 0)
        let state = await connector.connect(address: "https://witness.example.com", key: Self.key)
        guard case .problem(.couldNotSave) = state else {
            Issue.record("expected couldNotSave, got \(state)")
            return
        }
        #expect(try tokens.readSavedKey() == keyBefore, "the old key, still tied to the old address")
        #expect(try Data(contentsOf: temp.file("config.json")) == configBefore)
        #expect(connector.hasKeyForSavedAddress(), "key and address still belong together")
    }

    @Test("A first save that fails leaves no key behind", .enabled(if: getuid() != 0))
    func failedFirstSave() async throws {
        let temp = try TemporaryDirectory()
        defer {
            chmod(temp.url.path, 0o755)
            temp.remove()
        }
        let tokens = InMemoryTokenStore()
        let connector = connector(MockTransport(replies: [.status(200, body: Self.statusBody)]), tokens: tokens, in: temp)
        #expect(chmod(temp.url.path, 0o500) == 0)
        guard case .problem(.couldNotSave) = await connector.connect(address: "https://witness.example.com", key: Self.key) else {
            Issue.record("expected couldNotSave")
            return
        }
        #expect(try tokens.readSavedKey() == nil)
        #expect(connector.savedAddress() == nil)
    }

    @Test("If the key cannot be saved, config.json is not changed")
    func failedKeySave() async throws {
        final class FailingWrites: TokenStore, @unchecked Sendable {
            var restored: [SavedKey?] = []
            let saved = SavedKey(token: "wit_dev_" + String(repeating: "O", count: 43), server: "https://old.example.com")
            func readSavedKey() throws -> SavedKey? { saved }
            func writeToken(_ token: String, server: URL) throws { throw KeychainError.status(-25_293) }
            func deleteToken() throws {}
            func restore(_ saved: SavedKey?) throws { restored.append(saved) }
        }
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        try ConfigStore(fileURL: temp.file("config.json")).save(WitnessConfig(apiUrl: "https://old.example.com"))
        let configBefore = try Data(contentsOf: temp.file("config.json"))
        let tokens = FailingWrites()
        let store = SignInStore(paths: WitnessPaths(supportDirectory: temp.url, messagesDatabase: temp.file("chat.db")), tokenStore: tokens)
        #expect(throws: KeychainError.self) {
            try store.save(token: Self.key, server: URL(string: "https://witness.example.com")!)
        }
        #expect(try Data(contentsOf: temp.file("config.json")) == configBefore)
        #expect(tokens.restored == [tokens.saved], "the key read before was put back")
    }

    @Test("fetchStatus reads counts only")
    func fetchStatus() async throws {
        let client = WitnessClient(baseURL: URL(string: "https://witness.example.com")!, token: Self.key, transport: MockTransport(replies: [.status(200, body: Self.statusBody)]))
        #expect(await client.fetchStatus() == .ok(ServerStatus(saved: 3, maybe: 1, lastCapturedAt: 1_790_200_000_000)))
        let busy = WitnessClient(baseURL: URL(string: "https://witness.example.com")!, token: Self.key, transport: MockTransport(replies: [.status(503)]))
        #expect(await busy.fetchStatus() == .unreachable)
        let offline = WitnessClient(baseURL: URL(string: "https://witness.example.com")!, token: Self.key, transport: MockTransport(replies: [.failure(.timedOut)]))
        #expect(await offline.fetchStatus() == .unreachable)
        let typo = WitnessClient(baseURL: URL(string: "https://witness.example.com")!, token: Self.key, transport: MockTransport(replies: [.failure(.cannotFindHost)]))
        #expect(await typo.fetchStatus() == .badAddress(.hostNotFound))
    }
}

@Suite("Product voice")
struct ProductVoiceTests {
    static var sentences: [String] {
        let problems: [ServerProblem] = [
            .invalidAddress, .insecureAddress, .invalidKey, .keyRefused, .notWitness(status: 404), .notWitness(status: nil),
            .hostNotFound, .untrustedCertificate, .couldNotSave("x"),
        ]
        let states: [ServerCheckState] = [.checking, .connected(host: "h"), .unreachable(host: "h")]
        return StatusCopy.allFixedSentences + problems.map(\.message) + states.compactMap(\.message)
            + SetupStep.allCases.map(\.label) + [KeyBindingError.otherAddress.description]
    }

    @Test("No exclamation marks, and no telling anyone how to feel")
    func calm() {
        #expect(Self.sentences.count > 20)
        for sentence in Self.sentences {
            #expect(!sentence.contains("!"), "\(sentence)")
            for phrase in ["you've got this", "you’ve got this", "don't worry", "don’t worry", "you should feel", "cheer up", "great job"] {
                #expect(!sentence.lowercased().contains(phrase), "\(sentence)")
            }
        }
    }
}

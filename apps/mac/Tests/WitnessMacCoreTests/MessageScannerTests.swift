import Foundation
import Testing
@testable import WitnessMacCore

@Suite("MessageScanner")
struct MessageScannerTests {
    struct Harness {
        let temp: TemporaryDirectory
        let scenario: StandardScenario
        let transport: MockTransport
        let cursorStore: CursorStore

        init(transport: MockTransport = MockTransport()) throws {
            temp = try TemporaryDirectory()
            scenario = try StandardScenario(url: temp.file("chat.db"))
            self.transport = transport
            cursorStore = CursorStore(fileURL: temp.file("Witness/cursor.json"))
        }

        func scanner(sending: Bool = true, now: Date = testNow) throws -> MessageScanner {
            let client = WitnessClient(
                baseURL: URL(string: "https://witness.example.com")!,
                token: "wit_dev_" + String(repeating: "T", count: 43),
                transport: transport,
                retryPolicy: RetryPolicy(maxAttempts: 2, baseDelay: 0, maxDelay: 0, jitter: 0),
                sleep: { _ in }
            )
            return MessageScanner(
                databaseURL: scenario.database.url,
                prefilter: try Fixtures.prefilter(),
                cursorStore: cursorStore,
                sender: sending ? client : nil,
                now: { now }
            )
        }

        func sentGUIDs() async throws -> [String] {
            try await transport.bodies().compactMap { $0["sourceRef"] as? String }
        }

        func sentTexts() async throws -> [String] {
            try await transport.bodies().compactMap { $0["text"] as? String }
        }
    }

    @Test("First scan sends only candidates from the lookback window, in order")
    func firstScan() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }

        let summary = try await harness.scanner().scanOnce()

        var expected = ScanSummary()
        expected.scanned = 13 // everything after the 60-day-old message
        expected.skipped = 5 // from me, tapback, unsent, attachment only, group event
        expected.excluded = 3 // short code, no-reply sender, one-time code
        expected.noCue = 1
        expected.candidates = 4
        expected.sent = 4
        expected.cursor = harness.scenario.maxRowID
        #expect(summary == expected)

        #expect(try await harness.sentGUIDs() == StandardScenario.candidateGUIDs)
        let sentTexts = try await harness.sentTexts()
        #expect(sentTexts.contains(StandardScenario.Text.proud), "decoded from attributedBody")
        for text in StandardScenario.Text.neverSent {
            #expect(!sentTexts.contains(text))
        }

        let cursor = try #require(try harness.cursorStore.load())
        #expect(cursor.lastRowID == harness.scenario.maxRowID)
        #expect(cursor.notBefore == AppleTime.unixMilliseconds(testNow) - 30 * dayMilliseconds)
    }

    @Test("A second scan picks up only what is new")
    func incremental() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let scanner = try harness.scanner()
        _ = try await scanner.scanOnce()

        let idle = try await scanner.scanOnce()
        #expect(idle.scanned == 0)
        #expect(idle.sent == 0)

        let handle = try harness.scenario.database.addHandle("+12065550108")
        try harness.scenario.database.addMessage(.init(
            guid: "F0000000-0000-4000-8000-0000000000F1", text: "So grateful you were there",
            handleID: handle, date: SyntheticChatDatabase.appleNanoseconds(daysAgo: 0.01)))
        let next = try await scanner.scanOnce()
        #expect(next.scanned == 1)
        #expect(next.sent == 1)
        #expect(try await harness.sentGUIDs().last == "F0000000-0000-4000-8000-0000000000F1")
    }

    @Test("A dry run sends nothing and leaves no cursor behind")
    func dryRun() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }

        let summary = try await harness.scanner(sending: false).scanOnce(options: ScanOptions(dryRun: true))
        #expect(summary.candidates == 4)
        #expect(summary.sent == 0)
        #expect(await harness.transport.requests.isEmpty)
        #expect(try harness.cursorStore.load() == nil)
    }

    @Test("Without a sender, a real scan refuses to run rather than dropping candidates")
    func notSignedIn() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        await #expect(throws: ScanError.notSignedIn) {
            try await harness.scanner(sending: false).scanOnce()
        }
        #expect(try harness.cursorStore.load() == nil)
    }

    @Test("When the server is down, the scan stops and resumes at the unsent message")
    func resumesAfterOutage() async throws {
        // First candidate goes through, then the server is unavailable (two attempts each).
        let transport = MockTransport(replies: [.saved, .status(503), .status(503)])
        let harness = try Harness(transport: transport)
        defer { harness.temp.remove() }
        let scanner = try harness.scanner()

        let first = try await scanner.scanOnce()
        #expect(first.sent == 1)
        #expect(first.failed == 1)
        #expect(first.stoppedEarly == .http(status: 503, code: nil))
        let proudRow = try #require(harness.scenario.rows["proud"])
        #expect(first.cursor == proudRow - 1)
        #expect(try harness.cursorStore.load()?.lastRowID == proudRow - 1)

        let second = try await scanner.scanOnce()
        #expect(second.stoppedEarly == nil)
        #expect(second.sent == 3)
        #expect(try await harness.sentGUIDs().suffix(3) == Array(StandardScenario.candidateGUIDs.dropFirst()))
    }

    @Test("A rejected token stops the scan without moving past the message")
    func unauthorized() async throws {
        let transport = MockTransport(fallback: .status(401, body: #"{"error":{"code":"unauthorized","message":"no"}}"#))
        let harness = try Harness(transport: transport)
        defer { harness.temp.remove() }

        let summary = try await harness.scanner().scanOnce()
        #expect(summary.stoppedEarly?.isAuthorizationFailure == true)
        #expect(summary.sent == 0)
        #expect(await transport.requests.count == 1)
        #expect(summary.cursor == harness.scenario.rows["thanks"]! - 1)
    }

    @Test("A message the server rejects as invalid is skipped, not retried forever")
    func permanentRejection() async throws {
        let transport = MockTransport(replies: [.status(422)])
        let harness = try Harness(transport: transport)
        defer { harness.temp.remove() }

        let summary = try await harness.scanner().scanOnce()
        #expect(summary.failed == 1)
        #expect(summary.sent == 3)
        #expect(summary.stoppedEarly == nil)
        #expect(summary.cursor == harness.scenario.maxRowID)
    }

    @Test("A cursor saved for a different database is not reused")
    func cursorForAnotherDatabase() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        try harness.cursorStore.save(CursorState(lastRowID: 9_999, notBefore: 0, updatedAt: 0, databasePath: "/elsewhere/chat.db"))

        let summary = try await harness.scanner().scanOnce()
        #expect(summary.sent == 4)
        let cursor = try #require(try harness.cursorStore.load())
        #expect(cursor.databasePath == harness.scenario.database.url.standardizedFileURL.path)
        #expect(cursor.lastRowID == harness.scenario.maxRowID)
    }

    @Test("Old history that arrives late is never sent")
    func lateHistory() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let scanner = try harness.scanner()
        _ = try await scanner.scanOnce()

        // Messages in iCloud can add a years-old message with a brand-new ROWID.
        let handle = try harness.scenario.database.addHandle("+12065550109")
        try harness.scenario.database.addMessage(.init(
            guid: "F0000000-0000-4000-8000-0000000000F2", text: "Thank you so much, always",
            handleID: handle, date: SyntheticChatDatabase.appleNanoseconds(daysAgo: 400)))
        let summary = try await scanner.scanOnce()
        #expect(summary.scanned == 1)
        #expect(summary.skipped == 1)
        #expect(summary.sent == 0)
    }

    @Test("Very long messages are skipped")
    func longMessages() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let scanner = try harness.scanner()
        _ = try await scanner.scanOnce()

        let handle = try harness.scenario.database.addHandle("+12065550110")
        try harness.scenario.database.addMessage(.init(
            guid: "F0000000-0000-4000-8000-0000000000F3",
            text: "Thank you. " + String(repeating: "a", count: MessageScanner.maximumTextLength),
            handleID: handle, date: SyntheticChatDatabase.appleNanoseconds(daysAgo: 0.01)))
        let summary = try await scanner.scanOnce()
        #expect(summary.skipped == 1)
        #expect(summary.sent == 0)
    }

    @Test("Scans in small batches reach the same result")
    func smallBatches() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let summary = try await harness.scanner().scanOnce(options: ScanOptions(batchSize: 2))
        #expect(summary.scanned == 13)
        #expect(summary.sent == 4)
        #expect(try await harness.sentGUIDs() == StandardScenario.candidateGUIDs)
    }

    @Test("A wrong address (404) stops the scan and keeps every message for later")
    func wrongAddress() async throws {
        let transport = MockTransport(replies: [.status(404, body: #"{"error":{"code":"not_found","message":"No such endpoint."}}"#)])
        let harness = try Harness(transport: transport)
        defer { harness.temp.remove() }
        let scanner = try harness.scanner()

        let first = try await scanner.scanOnce()
        #expect(first.stoppedEarly == .http(status: 404, code: "not_found"))
        #expect(first.sent == 0)
        #expect(first.cursor == harness.scenario.rows["thanks"]! - 1)

        // Once the address is right, nothing was lost.
        let second = try await scanner.scanOnce()
        #expect(second.sent == 4)
        #expect(try await harness.sentGUIDs().suffix(4) == StandardScenario.candidateGUIDs)
    }

    @Test("An answer that is not Witness's (a login page) stops the scan instead of skipping")
    func notWitnessAnswer() async throws {
        let transport = MockTransport(replies: [.status(200, body: "<html>Sign in to the network</html>")])
        let harness = try Harness(transport: transport)
        defer { harness.temp.remove() }
        let scanner = try harness.scanner()
        let first = try await scanner.scanOnce()
        #expect(first.stoppedEarly == .invalidResponse)
        #expect(first.cursor == harness.scenario.rows["thanks"]! - 1)
        #expect(try await scanner.scanOnce().sent == 4)
    }

    @Test("A message too new to send waits, and one the sender unsent is never sent")
    func unsendWindow() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        _ = try await harness.scanner().scanOnce()
        let sentBefore = await harness.transport.requests.count

        let handle = try harness.scenario.database.addHandle("+12065550120")
        let fresh = try harness.scenario.database.addMessage(.init(
            guid: "F0000000-0000-4000-8000-0000000000F8", text: "So proud of you, I mean it",
            handleID: handle, date: SyntheticChatDatabase.appleNanoseconds(daysAgo: 0.0005)))
        let held = try await harness.scanner().scanOnce()
        #expect(held.held == 1)
        #expect(held.sent == 0)
        #expect(held.cursor == fresh - 1)
        #expect(held.retryAt != nil)
        #expect(held.countsLine.hasSuffix("waiting 1"))
        #expect(await harness.transport.requests.count == sentBefore)

        // The sender pressed Undo Send.
        try harness.scenario.database.execute("UPDATE message SET date_retracted = 1, text = NULL, attributedBody = NULL WHERE ROWID = \(fresh)")
        let later = try await harness.scanner(now: testNow.addingTimeInterval(10 * 60)).scanOnce()
        #expect(later.sent == 0)
        #expect(later.skipped == 1)
        #expect(later.cursor == fresh)
        #expect(await harness.transport.requests.count == sentBefore)
    }

    @Test("A message that stays sent goes once the unsend window has passed")
    func sentAfterWindow() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        _ = try await harness.scanner().scanOnce()
        let handle = try harness.scenario.database.addHandle("+12065550121")
        try harness.scenario.database.addMessage(.init(
            guid: "F0000000-0000-4000-8000-0000000000F9", text: "Thank you for everything, truly",
            handleID: handle, date: SyntheticChatDatabase.appleNanoseconds(daysAgo: 0.0005)))
        #expect(try await harness.scanner().scanOnce().held == 1)
        let later = try await harness.scanner(now: testNow.addingTimeInterval(10 * 60)).scanOnce()
        #expect(later.sent == 1)
        #expect(try await harness.sentGUIDs().last == "F0000000-0000-4000-8000-0000000000F9")
    }

    @Test("A cursor past the end of a rebuilt chat.db starts again instead of skipping everything")
    func rebuiltDatabase() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let path = harness.scenario.database.url.standardizedFileURL.path
        try harness.cursorStore.save(CursorState(lastRowID: 240_000, notBefore: 0, updatedAt: 0, databasePath: path))
        let summary = try await harness.scanner().scanOnce()
        #expect(summary.sent == 4)
        #expect(summary.cursor == harness.scenario.maxRowID)
        // notBefore comes from the lookback again, so old history still stays on the Mac.
        #expect(try harness.cursorStore.load()?.notBefore == AppleTime.unixMilliseconds(testNow) - 30 * dayMilliseconds)
    }

    @Test("The counts line holds numbers only")
    func countsLine() {
        var summary = ScanSummary()
        summary.scanned = 12
        summary.failed = 1
        #expect(summary.countsLine == "scanned 12 · skipped 0 · excluded 0 · no cue 0 · candidates 0 · sent 0 · failed 1")
    }
}

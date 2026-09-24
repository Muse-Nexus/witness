import Darwin
import Foundation
import os
import Testing
@testable import WitnessMacCore

/// A synthetic Mac for the engine: a support folder, a synthetic chat.db, a key in memory.
struct EngineFixture {
    static let host = "witness.example.com"

    let temp: TemporaryDirectory
    let scenario: StandardScenario
    let paths: WitnessPaths
    let tokens: InMemoryTokenStore
    let transport: MockTransport
    /// When set, overrides the real Full Disk Access check.
    let access = OSAllocatedUnfairLock<FullDiskAccessState?>(initialState: nil)
    /// Answers used once each, before `access` and the real check.
    let nextAccess = OSAllocatedUnfairLock<[FullDiskAccessState]>(initialState: [])

    init(signedIn: Bool = true, setupFinished: Bool = true, state: AppState? = nil, transport: MockTransport = MockTransport()) throws {
        temp = try TemporaryDirectory()
        scenario = try StandardScenario(url: temp.file("chat.db"))
        paths = WitnessPaths(supportDirectory: temp.file("Witness"), messagesDatabase: scenario.database.url)
        tokens = InMemoryTokenStore(token: signedIn ? WitnessClientTests.token : nil)
        self.transport = transport
        if signedIn {
            try ConfigStore(fileURL: paths.configFile).save(WitnessConfig(apiUrl: "https://\(Self.host)"))
        }
        var appState = state ?? AppState()
        if setupFinished, state == nil { appState.setup = SetupProgress(finishedAt: 1) }
        try AppStateStore(fileURL: paths.appStateFile).save(appState)
    }

    func engine(names: (any ContactsResolving)? = nil, transport override: (any HTTPTransport)? = nil) -> CollectorEngine {
        let access = self.access
        let nextAccess = self.nextAccess
        return CollectorEngine(environment: EngineEnvironment(
            paths: paths,
            tokenStore: tokens,
            transport: override ?? transport,
            retryPolicy: RetryPolicy(maxAttempts: 1, baseDelay: 0, maxDelay: 0, jitter: 0),
            lexiconURL: { Fixtures.lexiconURL },
            checkFullDiskAccess: { url in
                if let once = nextAccess.withLock({ $0.isEmpty ? nil : $0.removeFirst() }) { return once }
                return access.withLock { $0 } ?? FullDiskAccess.check(url: url)
            },
            names: { enabled in enabled ? names : nil },
            now: { testNow },
            calendar: ActivityLogTests.calendar
        ))
    }

    var savedState: AppState { AppStateStore(fileURL: paths.appStateFile).load() }

    func remove() { temp.remove() }
}

/// Accepts every capture, and presses Pause while the first one is on its way.
actor PausingTransport: HTTPTransport {
    private var engine: CollectorEngine?
    private(set) var count = 0

    func attach(_ engine: CollectorEngine) {
        self.engine = engine
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        count += 1
        if count == 1 { await engine?.pause() }
        let body = #"{"status":"saved","id":"itm_fixture","category":"gratitude"}"#
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }
}

@Suite("Background engine")
struct CollectorEngineTests {
    static let candidates = StandardScenario.candidateGUIDs.count
    static let unauthorized = MockTransport.Reply.status(401, body: #"{"error":{"code":"unauthorized","message":"x"}}"#)

    @Test("Check now sends the kind messages and counts them, never their words")
    func checkNow() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let engine = fixture.engine()

        let status = await engine.checkNow()
        #expect(status.connection == .connected(host: EngineFixture.host))
        #expect(status.activity == .watching)
        #expect(status.fullDiskAccess == .granted)
        #expect(status.sentToday == Self.candidates)
        #expect(status.sentThisWeek == Self.candidates)
        #expect(status.lastCheck == testNow)
        #expect(status.note == nil)
        #expect(await fixture.transport.requests.count == Self.candidates)

        // What is kept on disk is times and counts: no text, no senders.
        let activity = try String(contentsOf: fixture.paths.activityFile, encoding: .utf8)
        let state = try String(contentsOf: fixture.paths.appStateFile, encoding: .utf8)
        for words in StandardScenario.Text.all + ["+1206555", "example.com"] {
            #expect(!activity.contains(words) && !state.contains(words))
        }

        // A second check finds nothing new, and the counts stay.
        let again = await engine.checkNow()
        #expect(again.sentToday == Self.candidates)
        #expect(await fixture.transport.requests.count == Self.candidates)
    }

    @Test("Counts are kept across restarts")
    func countsPersist() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        await fixture.engine().checkNow()
        let restarted = await fixture.engine().status
        #expect(restarted.sentToday == Self.candidates)
        #expect(restarted.lastCheck == testNow)
        #expect(restarted.connection == .notCheckedYet(host: EngineFixture.host))
    }

    @Test("Names go with a message only when names are on")
    func names() async throws {
        let names = InMemoryContactsResolver(records: [ContactRecord(name: "Ana Example", phoneNumbers: ["206-555-0101"])])

        let off = try EngineFixture()
        defer { off.remove() }
        await off.engine(names: names).checkNow()
        #expect(try await off.transport.bodies().allSatisfy { $0["fromName"] == nil })

        var state = AppState(namesEnabled: true)
        state.setup = SetupProgress(finishedAt: 1)
        let on = try EngineFixture(state: state)
        defer { on.remove() }
        await on.engine(names: names).checkNow()
        let named = try await on.transport.bodies().filter { $0["fromName"] != nil }
        #expect(named.count == 1)
        #expect(named.first?["fromName"] as? String == "Ana Example")
    }

    @Test("Pause and resume are kept across restarts")
    func pauseResume() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let engine = fixture.engine()

        await engine.pause()
        #expect(await engine.status.activity == .paused(.byPerson))
        #expect(fixture.savedState.pause?.reason == .byPerson)

        // After a restart it is still paused, and a check reads and sends nothing.
        let restarted = fixture.engine()
        #expect(await restarted.status.activity == .paused(.byPerson))
        let paused = await restarted.checkNow()
        #expect(paused.activity == .paused(.byPerson))
        #expect(await fixture.transport.requests.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: fixture.paths.cursorFile.path), "Messages was not even read")

        await restarted.resume()
        #expect(await restarted.status.pauseReason == nil)
        #expect(await restarted.status.sentToday == Self.candidates)
        #expect(fixture.savedState.pause == nil)

        #expect(await fixture.engine().status.activity == .watching)
    }

    @Test("Pause takes effect in the middle of a check, and nothing is skipped")
    func pauseMidway() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let transport = PausingTransport()
        let engine = fixture.engine(transport: transport)
        await transport.attach(engine)

        let status = await engine.checkNow()
        #expect(status.activity == .paused(.byPerson))
        #expect(status.note == nil, "a pause is not a problem")
        #expect(status.connection == .notCheckedYet(host: EngineFixture.host))
        #expect(await transport.count == 1, "the person paused while the first message was being sent")
        #expect(status.sentToday == 1)

        await engine.resume()
        #expect(await transport.count == Self.candidates, "the rest are sent after resuming, none twice")
        #expect(await engine.status.sentToday == Self.candidates)
    }

    @Test("A revoked key (401) pauses with a plain message until a new key is saved")
    func keyRefused() async throws {
        let fixture = try EngineFixture(transport: MockTransport(replies: [Self.unauthorized]))
        defer { fixture.remove() }
        let engine = fixture.engine()

        let status = await engine.checkNow()
        #expect(status.activity == .paused(.keyRefused))
        #expect(status.connection == .keyRefused(host: EngineFixture.host))
        #expect(status.sentToday == 0)
        #expect(StatusCopy.activity(status.activity).contains("Add a new key in Settings"))
        #expect(fixture.savedState.pause?.reason == .keyRefused)
        #expect(await fixture.transport.requests.count == 1, "stops at the first refusal")

        // It stays paused across a restart, and checking sends nothing more.
        let restarted = fixture.engine()
        #expect(await restarted.status.activity == .paused(.keyRefused))
        #expect(await restarted.status.connection == .keyRefused(host: EngineFixture.host))
        await restarted.checkNow()
        #expect(await fixture.transport.requests.count == 1)

        // A new key clears the pause, and the next check resumes where it stopped.
        try fixture.tokens.writeToken("wit_dev_" + String(repeating: "N", count: 43))
        await restarted.connectionChanged()
        #expect(fixture.savedState.pause == nil)
        let resumed = await restarted.checkNow()
        #expect(resumed.activity == .watching)
        #expect(resumed.sentToday == Self.candidates, "the refused message was not skipped")
    }

    @Test("A 403 on capture pauses the same way")
    func forbidden() async throws {
        let fixture = try EngineFixture(transport: MockTransport(replies: [.status(403, body: "{}")]))
        defer { fixture.remove() }
        #expect(await fixture.engine().checkNow().activity == .paused(.keyRefused))
    }

    @Test("Losing Full Disk Access (EPERM) pauses, and it resumes once Messages can be read again")
    func fullDiskAccessLost() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let engine = fixture.engine()
        fixture.access.withLock { $0 = .denied }

        let status = await engine.checkNow()
        #expect(status.activity == .paused(.fullDiskAccess))
        #expect(status.fullDiskAccess == .denied)
        #expect(StatusCopy.activity(status.activity).contains("Full Disk Access"))
        #expect(fixture.savedState.pause?.reason == .fullDiskAccess)
        #expect(await fixture.transport.requests.isEmpty)

        // Still off: checking changes nothing.
        #expect(await engine.checkNow().activity == .paused(.fullDiskAccess))

        // Back on (for example after a relaunch): the next check resumes by itself.
        fixture.access.withLock { $0 = nil }
        let resumed = await engine.checkNow()
        #expect(resumed.pauseReason == nil)
        #expect(resumed.sentToday == Self.candidates)
        #expect(fixture.savedState.pause == nil)
    }

    @Test("A Messages file this process may not open pauses too (the real open(2) check)")
    func unreadableDatabase() async throws {
        let fixture = try EngineFixture()
        defer {
            chmod(fixture.scenario.database.url.path, 0o644)
            fixture.remove()
        }
        let engine = fixture.engine()
        // The real open(2) check: a file this process may not open reads as not granted,
        // just like EPERM from privacy protection.
        #expect(chmod(fixture.scenario.database.url.path, 0o000) == 0)
        #expect(FullDiskAccess.check(url: fixture.scenario.database.url) == .denied)

        let status = await engine.checkNow()
        #expect(status.activity == .paused(.fullDiskAccess))
        #expect(await fixture.transport.requests.isEmpty)
    }

    @Test("Access lost between the check and the read (open fails) pauses too")
    func accessLostMidway() async throws {
        let fixture = try EngineFixture()
        defer {
            chmod(fixture.scenario.database.url.path, 0o644)
            fixture.remove()
        }
        let engine = fixture.engine()
        #expect(chmod(fixture.scenario.database.url.path, 0o000) == 0)
        // The first check still says yes; opening chat.db then fails, and the second look says no.
        fixture.nextAccess.withLock { $0 = [.granted] }

        let status = await engine.checkNow()
        #expect(status.activity == .paused(.fullDiskAccess))
        #expect(status.note == nil)
        #expect(await fixture.transport.requests.isEmpty)
    }

    @Test("Opening the panel after access comes back resumes too")
    func refreshResumes() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let engine = fixture.engine()
        fixture.access.withLock { $0 = .denied }
        #expect(await engine.checkNow().activity == .paused(.fullDiskAccess))

        await engine.refreshFullDiskAccess()
        #expect(await engine.status.activity == .paused(.fullDiskAccess), "still off, still paused")

        fixture.access.withLock { $0 = nil }
        await engine.refreshFullDiskAccess()
        #expect(await engine.status.pauseReason == nil)
        #expect(await engine.status.sentToday == Self.candidates)
    }

    @Test("A restart with access back lifts the Full Disk Access pause")
    func startResumesAfterRelaunch() async throws {
        var state = AppState()
        state.setup = SetupProgress(finishedAt: 1)
        state.pause = PauseState(reason: .fullDiskAccess, since: 1)
        let fixture = try EngineFixture(state: state)
        defer { fixture.remove() }
        let engine = fixture.engine()
        #expect(await engine.status.activity == .paused(.fullDiskAccess))
        await engine.start()
        #expect(await engine.status.pauseReason == nil)
        #expect(fixture.savedState.pause == nil)
        await engine.stop()
    }

    @Test("Nothing is read before setup is finished, and the chosen lookback is used")
    func waitsForSetup() async throws {
        let fixture = try EngineFixture(setupFinished: false)
        defer { fixture.remove() }
        let engine = fixture.engine()

        #expect(await engine.checkNow().activity == .waitingForSetup)
        #expect(await fixture.transport.requests.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: fixture.paths.cursorFile.path))

        await engine.update { state in
            state.lookbackDays = 90
            state.setup.finishedAt = 1
        }
        let status = await engine.checkNow()
        // 90 days reaches the 60-day-old thank-you too.
        #expect(status.sentToday == Self.candidates + 1)
        let cursor = try #require(try CursorStore(fileURL: fixture.paths.cursorFile).load())
        #expect(cursor.notBefore == AppleTime.unixMilliseconds(testNow) - 90 * dayMilliseconds)
    }

    @Test("Without an address or key it waits quietly and sends nothing")
    func notSignedIn() async throws {
        let fixture = try EngineFixture(signedIn: false)
        defer { fixture.remove() }
        let status = await fixture.engine().checkNow()
        #expect(status.connection == .notSetUp)
        #expect(status.pauseReason == nil)
        #expect(await fixture.transport.requests.isEmpty)
    }

    @Test("When Witness cannot be reached nothing is skipped, and it says so plainly")
    func unreachable() async throws {
        let fixture = try EngineFixture(transport: MockTransport(replies: [.failure(.timedOut)]))
        defer { fixture.remove() }
        let engine = fixture.engine()
        let status = await engine.checkNow()
        #expect(status.connection == .unreachable(host: EngineFixture.host))
        #expect(status.note == EngineNote.unreachable.text)
        #expect(status.pauseReason == nil)
        #expect(status.sentToday == 0)

        let later = await engine.checkNow()
        #expect(later.connection == .connected(host: EngineFixture.host))
        #expect(later.sentToday == Self.candidates, "the first candidate was kept for the next check")
        #expect(later.note == nil)
    }

    @Test("Status updates arrive as a stream, starting with the current one")
    func updates() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let engine = fixture.engine()
        var iterator = await engine.updates().makeAsyncIterator()
        #expect(await iterator.next()?.activity == .watching)
        await engine.pause()
        #expect(await iterator.next()?.activity == .paused(.byPerson))
    }
}

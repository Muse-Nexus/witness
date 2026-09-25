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
    /// The engine's "now": `testNow` until a test moves it on.
    let time = OSAllocatedUnfairLock<Date>(initialState: testNow)

    func advance(by seconds: TimeInterval) {
        time.withLock { $0 = $0.addingTimeInterval(seconds) }
    }

    init(signedIn: Bool = true, setupFinished: Bool = true, state: AppState? = nil, transport: MockTransport = MockTransport()) throws {
        temp = try TemporaryDirectory()
        scenario = try StandardScenario(url: temp.file("chat.db"))
        paths = WitnessPaths(supportDirectory: temp.file("Witness"), messagesDatabase: scenario.database.url)
        tokens = InMemoryTokenStore(token: signedIn ? WitnessClientTests.token : nil, server: "https://\(Self.host)")
        self.transport = transport
        if signedIn {
            try ConfigStore(fileURL: paths.configFile).save(WitnessConfig(apiUrl: "https://\(Self.host)"))
        }
        // The standard scenario was built around 30 days; tests that care give their own state.
        var appState = state ?? AppState(lookback: .days(30))
        if setupFinished, state == nil { appState.setup = SetupProgress(finishedAt: 1) }
        try AppStateStore(fileURL: paths.appStateFile).save(appState)
    }

    func engine(
        names: (any ContactsResolving)? = nil,
        transport override: (any HTTPTransport)? = nil,
        retryPolicy: RetryPolicy = RetryPolicy(maxAttempts: 1, baseDelay: 0, maxDelay: 0, jitter: 0),
        clock: ManualClock = ManualClock(),
        sendLimit: Int = ScanOptions.defaultSendLimit
    ) -> CollectorEngine {
        let access = self.access
        let nextAccess = self.nextAccess
        let time = self.time
        return CollectorEngine(environment: EngineEnvironment(
            paths: paths,
            tokenStore: tokens,
            transport: override ?? transport,
            retryPolicy: retryPolicy,
            lexiconURL: { Fixtures.lexiconURL },
            checkFullDiskAccess: { url in
                if let once = nextAccess.withLock({ $0.isEmpty ? nil : $0.removeFirst() }) { return once }
                return access.withLock { $0 } ?? FullDiskAccess.check(url: url)
            },
            names: { names },
            now: { time.withLock { $0 } },
            sleep: clock.sleep,
            sendLimit: sendLimit
        ))
    }

    var savedState: AppState { AppStateStore(fileURL: paths.appStateFile).load() }

    func remove() { temp.remove() }
}

/// Answers each capture with `reply`, and runs `onFirst` with the engine while the first
/// one is on its way (to press Pause, or turn names off, in the middle of a check).
actor ScriptedEngineTransport: HTTPTransport {
    private var engine: CollectorEngine?
    private let onFirst: @Sendable (CollectorEngine) async -> Void
    private let firstStatus: Int
    private(set) var requests: [URLRequest] = []

    var count: Int { requests.count }

    init(firstStatus: Int = 200, onFirst: @escaping @Sendable (CollectorEngine) async -> Void) {
        self.firstStatus = firstStatus
        self.onFirst = onFirst
    }

    func attach(_ engine: CollectorEngine) {
        self.engine = engine
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        var status = 200
        if requests.count == 1, let engine {
            await onFirst(engine)
            status = firstStatus
        }
        let body = status == 200 ? #"{"status":"saved","id":"itm_fixture","category":"gratitude"}"# : #"{"error":{"code":"unavailable","message":"x"}}"#
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!)
    }

    /// One string field of every request body, in order (nil where it is absent).
    func field(_ key: String) throws -> [String?] {
        try requests.map { request in
            let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
            return body?[key] as? String
        }
    }
}

@Suite("Background engine")
struct CollectorEngineTests {
    static let candidates = StandardScenario.candidateGUIDs.count
    static let unauthorized = MockTransport.Reply.status(401, body: #"{"error":{"code":"unauthorized","message":"x"}}"#)

    @Test("Check now sends the kind messages, and keeps only the time of the check")
    func checkNow() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let engine = fixture.engine()

        let status = await engine.checkNow()
        #expect(status.connection == .connected(host: EngineFixture.host))
        #expect(status.activity == .watching)
        #expect(status.fullDiskAccess == .granted)
        #expect(status.lastCheck == testNow)
        #expect(status.note == nil)
        #expect(await fixture.transport.requests.count == Self.candidates)

        // What is kept on disk is the time of the check: no text, no senders, no tally.
        let activity = try String(contentsOf: fixture.paths.activityFile, encoding: .utf8)
        let state = try String(contentsOf: fixture.paths.appStateFile, encoding: .utf8)
        for words in StandardScenario.Text.all + ["+1206555", "example.com"] {
            #expect(!activity.contains(words) && !state.contains(words))
        }
        let keys = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: fixture.paths.activityFile)) as? [String: Any]).keys
        #expect(Set(keys) == ["version", "lastCheckAt"])

        // A second check finds nothing new.
        _ = await engine.checkNow()
        #expect(await fixture.transport.requests.count == Self.candidates)
    }

    @Test("The time of the last check is kept across restarts")
    func lastCheckPersists() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        await fixture.engine().checkNow()
        let restarted = await fixture.engine().status
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

        var state = AppState(namesEnabled: true, lookback: .days(30))
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
        #expect(await fixture.transport.requests.count == Self.candidates)
        #expect(fixture.savedState.pause == nil)

        #expect(await fixture.engine().status.activity == .watching)
    }

    @Test("Pause takes effect in the middle of a check, and nothing is skipped")
    func pauseMidway() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let transport = ScriptedEngineTransport { await $0.pause() }
        let engine = fixture.engine(transport: transport)
        await transport.attach(engine)

        let status = await engine.checkNow()
        #expect(status.activity == .paused(.byPerson))
        #expect(status.note == nil, "a pause is not a problem")
        #expect(status.connection == .notCheckedYet(host: EngineFixture.host))
        #expect(await transport.count == 1, "the person paused while the first message was being sent")

        await engine.resume()
        #expect(await transport.count == Self.candidates, "the rest are sent after resuming, none twice")
    }

    @Test("Pause also stops a send that is waiting to retry")
    func pauseDuringRetry() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        // The first attempt meets a 503, and the person pauses while it waits to retry.
        let transport = ScriptedEngineTransport(firstStatus: 503) { await $0.pause() }
        let engine = fixture.engine(transport: transport, retryPolicy: RetryPolicy(maxAttempts: 4, baseDelay: 0, maxDelay: 0, jitter: 0))
        await transport.attach(engine)

        let status = await engine.checkNow()
        #expect(status.activity == .paused(.byPerson))
        #expect(status.note == nil)
        #expect(await transport.count == 1, "no second attempt after Pause")

        // Nothing was skipped: after Resume the same message goes first.
        await engine.resume()
        let guids = try await transport.field("sourceRef").compactMap { $0 }
        #expect(guids.first == guids.dropFirst().first, "the message that met the 503 is sent again first")
        #expect(Array(guids.dropFirst()) == StandardScenario.candidateGUIDs)
    }

    @Test("A revoked key (401) pauses with a plain message until a new key is saved")
    func keyRefused() async throws {
        let fixture = try EngineFixture(transport: MockTransport(replies: [Self.unauthorized]))
        defer { fixture.remove() }
        let engine = fixture.engine()

        let status = await engine.checkNow()
        #expect(status.activity == .paused(.keyRefused))
        #expect(status.connection == .keyRefused(host: EngineFixture.host))
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
        try fixture.tokens.writeToken("wit_dev_" + String(repeating: "N", count: 43), server: URL(string: "https://\(EngineFixture.host)")!)
        await restarted.connectionChanged()
        #expect(fixture.savedState.pause == nil)
        let resumed = await restarted.checkNow()
        #expect(resumed.activity == .watching)
        #expect(await fixture.transport.requests.count == 1 + Self.candidates, "the refused message was not skipped")
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
        #expect(await fixture.transport.requests.count == Self.candidates)
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
        #expect(await fixture.transport.requests.count == Self.candidates)
    }

    @Test("While paused for Full Disk Access it keeps looking, and resumes by itself once access is back")
    func accessRecoveryPoll() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let clock = ManualClock()
        let engine = fixture.engine(clock: clock)
        fixture.access.withLock { $0 = .denied }

        // Running, with nothing else to wake it: the watcher stops when it pauses.
        await engine.start()
        #expect(await eventually { await engine.status.pauseReason == .fullDiskAccess })
        #expect(await eventually { clock.requests.count == 1 }, "a look for access is waiting")
        #expect(clock.requests == [60], "once a minute")

        // Still off: a look changes nothing, and it keeps looking.
        clock.tick()
        #expect(await eventually { clock.requests.count == 2 })
        #expect(await engine.status.pauseReason == .fullDiskAccess)
        #expect(await fixture.transport.requests.isEmpty)

        // Turned back on in System Settings, with the panel never opened: the next look resumes and checks.
        fixture.access.withLock { $0 = nil }
        clock.tick()
        #expect(await eventually { await fixture.transport.requests.count == Self.candidates })
        #expect(await engine.status.pauseReason == nil)
        #expect(fixture.savedState.pause == nil)
        #expect(clock.requests.count == 2, "it stopped looking once resumed")
        await engine.stop()
    }

    @Test("Only a Full Disk Access pause looks for access, and only while running")
    func accessRecoveryOnlyWhenNeeded() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let clock = ManualClock()
        let engine = fixture.engine(clock: clock)
        await engine.start()
        #expect(await eventually { await fixture.transport.requests.count == Self.candidates })
        await engine.pause()
        #expect(await engine.status.pauseReason == .byPerson)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(clock.requests.isEmpty, "the person's own Pause lasts until they resume")
        await engine.stop()

        // Stopped while paused for access: nothing keeps looking.
        let stopped = try EngineFixture()
        defer { stopped.remove() }
        let stoppedClock = ManualClock()
        let quiet = stopped.engine(clock: stoppedClock)
        stopped.access.withLock { $0 = .denied }
        #expect(await quiet.checkNow().pauseReason == .fullDiskAccess)
        try await Task.sleep(nanoseconds: 50_000_000)
        #expect(stoppedClock.requests.isEmpty, "not running, so no background look")
    }

    @Test("Choosing a longer time in Settings looks through the older messages, a few at a time, and says so")
    func widenFromSettings() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let handle = try fixture.scenario.database.addHandle("+12065550160")
        for (index, days) in [100.0, 200].enumerated() {
            try fixture.scenario.database.addMessage(.init(
                guid: "E2000000-0000-4000-8000-00000000000\(index)", text: "Thank you so much for everything",
                handleID: handle, date: SyntheticChatDatabase.appleNanoseconds(daysAgo: days)))
        }
        let engine = fixture.engine(sendLimit: 2)
        await engine.checkNow()
        fixture.advance(by: ScanOptions.defaultPause + 1)
        await engine.checkNow()
        #expect(await fixture.transport.requests.count == Self.candidates)
        #expect(await !engine.status.lookingBack)

        await engine.update { $0.lookback = .lastYear }
        #expect(fixture.savedState.lookback == .lastYear)
        let chosenAt = AppleTime.unixMilliseconds(fixture.time.withLock { $0 })
        let first = await engine.checkNow()
        #expect(first.lookingBack)
        #expect(StatusCopy.lookingBack == "Also looking through older messages, a few at a time.")
        #expect(await fixture.transport.requests.count == Self.candidates + 2)

        fixture.advance(by: ScanOptions.defaultPause + 1)
        let second = await engine.checkNow()
        #expect(!second.lookingBack)
        #expect(await fixture.transport.requests.count == Self.candidates + 3)
        let guids = try await fixture.transport.bodies().compactMap { $0["sourceRef"] as? String }
        #expect(Set(guids).count == guids.count, "nothing was sent twice")
        let cursor = try #require(try CursorStore(fileURL: fixture.paths.cursorFile).load())
        #expect(cursor.coveredSince == chosenAt - 365 * dayMilliseconds)
    }

    @Test("After a full batch, or a 429, no check sends before the wait is over, whatever starts it")
    func pacedChecks() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let engine = fixture.engine(sendLimit: 2)
        await engine.checkNow()
        #expect(await fixture.transport.requests.count == 2)
        #expect(await engine.status.lookingBack)

        // Check now (as a new text or the safety timer would) before the 30 seconds are up: nothing goes.
        let early = await engine.checkNow()
        #expect(await fixture.transport.requests.count == 2)
        #expect(early.lookingBack)

        // The next few, and the server asks to slow down.
        fixture.advance(by: ScanOptions.defaultPause + 1)
        await fixture.transport.setReplies([.status(429)])
        await engine.checkNow()
        #expect(await fixture.transport.requests.count == 3)

        // Five minutes, not thirty seconds.
        fixture.advance(by: ScanOptions.defaultPause + 1)
        await engine.checkNow()
        #expect(await fixture.transport.requests.count == 3)
        fixture.advance(by: ScanOptions.defaultSlowDownPause)
        await engine.checkNow()
        #expect(await fixture.transport.requests.count == 5, "the one turned away goes first, then the last")
        let guids = try await fixture.transport.bodies().compactMap { $0["sourceRef"] as? String }
        let kind = StandardScenario.candidateGUIDs
        #expect(guids == [kind[0], kind[1], kind[2], kind[2], kind[3]])
    }

    @Test("A 429 whose retries end in server trouble or no network still waits the long pause")
    func slowDownThenTrouble() async throws {
        for trouble: MockTransport.Reply in [.status(503), .failure(.timedOut)] {
            let fixture = try EngineFixture(transport: MockTransport(replies: [.status(429), trouble, trouble, trouble]))
            defer { fixture.remove() }
            let engine = fixture.engine(retryPolicy: RetryPolicy(maxAttempts: 4, baseDelay: 0, maxDelay: 0, jitter: 0))
            await engine.checkNow()
            #expect(await fixture.transport.requests.count == 4)

            // A new text or Check now soon after: nothing goes to a server that asked to slow down.
            fixture.advance(by: 10)
            await engine.checkNow()
            #expect(await fixture.transport.requests.count == 4)
            fixture.advance(by: ScanOptions.defaultSlowDownPause)
            await engine.checkNow()
            #expect(await fixture.transport.requests.count == 4 + Self.candidates, "the one turned away goes first, then the rest")
        }
    }

    @Test("A clock put back after a full batch holds sending for no longer than the longest pause")
    func clockPutBack() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let engine = fixture.engine(sendLimit: 2)
        await engine.checkNow()
        #expect(await fixture.transport.requests.count == 2)

        // The clock is put back an hour (changed by hand, or a clock that ran ahead corrected).
        fixture.advance(by: -3_600)
        await engine.checkNow()
        #expect(await fixture.transport.requests.count == 2, "the wait after a full batch still holds")
        fixture.advance(by: ScanOptions.defaultSlowDownPause + 1)
        await engine.checkNow()
        #expect(await fixture.transport.requests.count == 4, "not an hour later: the rest go")
    }

    @Test("A shorter time chosen in the middle of a check sends nothing older from then on")
    func narrowMidCheck() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let handle = try fixture.scenario.database.addHandle("+12065550161")
        var older: [String] = []
        for (index, days) in [100.0, 150, 200, 300, 400].enumerated() {
            let guid = "E3000000-0000-4000-8000-00000000000\(index)"
            try fixture.scenario.database.addMessage(.init(
                guid: guid, text: "Thank you so much for everything",
                handleID: handle, date: SyntheticChatDatabase.appleNanoseconds(daysAgo: days)))
            older.append(guid)
        }
        await fixture.engine().checkNow()
        #expect(await fixture.transport.requests.count == Self.candidates)

        // Everything, then back to the last 30 days while the first older message is on its way.
        let transport = ScriptedEngineTransport { await $0.update { $0.lookback = .days(30) } }
        let engine = fixture.engine(transport: transport)
        await transport.attach(engine)
        await engine.update { $0.lookback = .everything }
        await engine.checkNow()
        #expect(await transport.count == 1, "nothing more once the shorter time was chosen")
        #expect(fixture.savedState.lookback == .days(30))
        await engine.checkNow()
        #expect(await transport.count == 1)

        // Nothing was lost: everything again carries on from there, and sends nothing twice.
        await engine.update { $0.lookback = .everything }
        await engine.checkNow()
        let sent = try await transport.field("sourceRef").compactMap { $0 }
        #expect(sent == ["F0000000-0000-4000-8000-000000000001"] + older)
    }

    @Test("A check that fails after the person paused keeps their Pause, even with Messages unreadable then", .enabled(if: getuid() != 0))
    func pauseKeptThroughError() async throws {
        let fixture = try EngineFixture()
        let support = fixture.paths.supportDirectory.path
        defer {
            chmod(support, 0o700)
            fixture.remove()
        }
        let access = fixture.access
        let transport = ScriptedEngineTransport { engine in
            await engine.pause()
            // Then the check fails (its place cannot be saved), and a look at Messages says no.
            access.withLock { $0 = .denied }
            chmod(support, 0o500)
        }
        let engine = fixture.engine(transport: transport)
        await transport.attach(engine)

        #expect(await engine.checkNow().pauseReason == .byPerson)
        #expect(fixture.savedState.pause?.reason == .byPerson)

        // Access is back: only Resume lifts the person's own Pause.
        chmod(support, 0o700)
        access.withLock { $0 = nil }
        await engine.refreshFullDiskAccess()
        #expect(await engine.status.pauseReason == .byPerson)
        #expect(await transport.count == 1)
    }

    @Test("Settings says how far back it has looked, and that it is still looking while the rest is sent")
    func lookedBackCopy() {
        let everything = CursorState(lastRowID: 1, notBefore: 0, updatedAt: 0, lookback: .everything)
        #expect(StatusCopy.lookedBack(everything, lookingBack: true).hasPrefix("Witness is still looking through older messages, a few at a time. "))
        #expect(StatusCopy.lookedBack(everything, lookingBack: false).hasPrefix("Witness has already looked at every message on this Mac. "))
        let year = CursorState(lastRowID: 1, notBefore: AppleTime.unixMilliseconds(testNow) - 365 * dayMilliseconds, updatedAt: 0)
        #expect(StatusCopy.lookedBack(year, lookingBack: false).hasPrefix("Witness has already looked at messages back to "))
        #expect(StatusCopy.lookedBack(year, lookingBack: false).hasSuffix(
            "A shorter time sends nothing older than it from now on, and changes nothing already sent."
        ))
    }

    @Test("A restart with access back lifts the Full Disk Access pause")
    func startResumesAfterRelaunch() async throws {
        var state = AppState(lookback: .days(30))
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
            state.lookback = .lastYear
            state.setup.finishedAt = 1
        }
        await engine.checkNow()
        // A year reaches the 60-day-old thank-you too.
        #expect(await fixture.transport.requests.count == Self.candidates + 1)
        let cursor = try #require(try CursorStore(fileURL: fixture.paths.cursorFile).load())
        #expect(cursor.notBefore == AppleTime.unixMilliseconds(testNow) - 365 * dayMilliseconds)
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
        #expect(await fixture.transport.requests.count == 1)

        let later = await engine.checkNow()
        #expect(later.connection == .connected(host: EngineFixture.host))
        #expect(await fixture.transport.requests.count == 1 + Self.candidates, "the first candidate was kept for the next check")
        #expect(later.note == nil)
    }

    @Test("A changed address in config.json stops sending: the key goes only where it was saved for")
    func changedAddressStopsSending() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        // Something edits config.json to point at another server.
        try ConfigStore(fileURL: fixture.paths.configFile).save(WitnessConfig(apiUrl: "https://listener.example.net"))
        let engine = fixture.engine()
        #expect(await engine.status.connection == .keyForOtherAddress(host: "listener.example.net"))

        let status = await engine.checkNow()
        #expect(await fixture.transport.requests.isEmpty, "no key and no message went to the new address")
        #expect(status.connection == .keyForOtherAddress(host: "listener.example.net"))
        #expect(status.note == EngineNote.keyForOtherAddress.text)
        #expect(!FileManager.default.fileExists(atPath: fixture.paths.cursorFile.path), "Messages was not even read")

        // Saving a key for the new address (setup step 1) is what makes it send there.
        try fixture.tokens.writeToken(WitnessClientTests.token, server: URL(string: "https://listener.example.net")!)
        await engine.connectionChanged()
        #expect(await engine.status.connection == .notCheckedYet(host: "listener.example.net"))
        #expect(await engine.checkNow().connection == .connected(host: "listener.example.net"))
        #expect(await fixture.transport.requests.allSatisfy { $0.url?.host == "listener.example.net" })
    }

    @Test("The same address written differently still sends")
    func sameAddressDifferentSpelling() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        try ConfigStore(fileURL: fixture.paths.configFile).save(WitnessConfig(apiUrl: "HTTPS://Witness.Example.com:443/api/v1/capture"))
        let status = await fixture.engine().checkNow()
        #expect(status.note == nil)
        #expect(await fixture.transport.requests.count == Self.candidates)
    }

    @Test("A key saved without its address (before 0.2.0) is not sent anywhere")
    func keyWithoutAddress() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        let unbound = InMemoryTokenStore(token: WitnessClientTests.token)
        let engine = CollectorEngine(environment: EngineEnvironment(
            paths: fixture.paths,
            tokenStore: unbound,
            transport: fixture.transport,
            lexiconURL: { Fixtures.lexiconURL },
            checkFullDiskAccess: { _ in .granted },
            now: { testNow }
        ))
        #expect(await engine.checkNow().connection == .keyForOtherAddress(host: EngineFixture.host))
        #expect(await fixture.transport.requests.isEmpty)
    }

    @Test("http://localhost is refused unless the build allows it")
    func localHTTP() async throws {
        let fixture = try EngineFixture()
        defer { fixture.remove() }
        try ConfigStore(fileURL: fixture.paths.configFile).save(WitnessConfig(apiUrl: "http://127.0.0.1:8787"))
        try fixture.tokens.writeToken(WitnessClientTests.token, server: URL(string: "http://127.0.0.1:8787")!)
        func engine(allowLocalHTTP: Bool) -> CollectorEngine {
            CollectorEngine(environment: EngineEnvironment(
                paths: fixture.paths,
                tokenStore: fixture.tokens,
                transport: fixture.transport,
                lexiconURL: { Fixtures.lexiconURL },
                checkFullDiskAccess: { _ in .granted },
                allowLocalHTTP: allowLocalHTTP,
                now: { testNow }
            ))
        }
        #expect(await engine(allowLocalHTTP: false).checkNow().connection == .notSetUp)
        #expect(await fixture.transport.requests.isEmpty)
        #expect(await engine(allowLocalHTTP: true).checkNow().connection == .connected(host: "127.0.0.1"))
    }

    @Test("Turning names off in the middle of a check stops names at the next message, without reading Contacts again")
    func namesOffMidway() async throws {
        var state = AppState(namesEnabled: true, lookback: .days(30))
        state.setup = SetupProgress(finishedAt: 1)
        let fixture = try EngineFixture(state: state)
        defer { fixture.remove() }
        let contacts = CachedContactsResolver(notificationCenter: NotificationCenter(), isAllowed: { true }) {
            [
                ContactRecord(name: "Ana Example", phoneNumbers: ["206-555-0101"], emailAddresses: ["friend@example.com"]),
                ContactRecord(name: "Kai Example", phoneNumbers: ["206-555-0102"]),
                ContactRecord(name: "Rae Example", phoneNumbers: ["206-555-0103"]),
            ]
        }
        let transport = ScriptedEngineTransport { engine in
            // What AppModel.setNames(false) does: the engine's switch, then drop the copy.
            await engine.update { $0.namesEnabled = false }
            contacts.invalidate()
        }
        let engine = fixture.engine(names: contacts, transport: transport)
        await transport.attach(engine)

        await engine.checkNow()
        let names = try await transport.field("fromName")
        #expect(names.count == Self.candidates)
        #expect(names.first == "Ana Example", "the first message went before names were turned off")
        #expect(names.dropFirst().allSatisfy { $0 == nil }, "no name after names were turned off")
        #expect(contacts.loadCount == 1, "Contacts was not read again")
        #expect(fixture.savedState.namesEnabled == false)
    }

    @Test("An impossible lookback is refused, and the one before stays")
    func lookbackClamped() async throws {
        let fixture = try EngineFixture(setupFinished: false)
        defer { fixture.remove() }
        let engine = fixture.engine()
        await engine.update { state in
            state.lookback = .days(99_999)
            state.setup.finishedAt = 1
        }
        #expect(await engine.state.lookback == .days(30))
        #expect(fixture.savedState.lookback == .days(30))
        await engine.checkNow()
        let cursor = try #require(try CursorStore(fileURL: fixture.paths.cursorFile).load())
        #expect(cursor.notBefore == AppleTime.unixMilliseconds(testNow) - 30 * dayMilliseconds)
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

import Foundation
import Testing
@testable import WitnessMacCore

// Every message here is fictional, and every handle a 555-01xx number.

private let now = AppleTime.unixMilliseconds(testNow)
private let oldGUID = "F0000000-0000-4000-8000-000000000001"

@Suite("How far back to look")
struct LookbackChoiceTests {
    @Test("Setup offers the last 30 days, the last year and everything; a year for a new setup")
    func choices() {
        #expect(Lookback.choices == [.days(30), .days(365), .everything])
        #expect(Lookback.choices.map(\.label) == ["The last 30 days", "The last year", "Everything"])
        #expect(Lookback.default == .lastYear)
        #expect(Lookback.everything.phrase == "everything")
        #expect(Lookback.lastYear.phrase == "the last year")
    }

    @Test("Where each choice starts")
    func floors() {
        #expect(Lookback.days(30).floor(atUnixMilliseconds: now) == now - 30 * dayMilliseconds)
        #expect(Lookback.lastYear.floor(atUnixMilliseconds: now) == now - 365 * dayMilliseconds)
        #expect(Lookback.everything.floor(atUnixMilliseconds: now) == 0)
        #expect(Lookback.days(3650).isValid && Lookback.days(0).isValid)
        #expect(!Lookback.days(3651).isValid && !Lookback.days(-1).isValid)
    }
}

@Suite("Older messages: planning")
struct OlderWindowPlanningTests {
    /// A cursor after a 30-day first scan, 10 days ago, of a database whose newest row is 100.
    func firstScan(lookback: Lookback = .days(30)) -> CursorState {
        let then = now - 10 * dayMilliseconds
        return CursorState(lastRowID: 100, notBefore: lookback.floor(atUnixMilliseconds: then), updatedAt: then, lookback: lookback)
    }

    @Test("The same choice, days later, adds nothing and splits nothing")
    func noChange() {
        var state = firstScan()
        state.planOlderWindows(for: .days(30), newestRowID: 140, now: now)
        #expect(state.olderWindows.isEmpty)
        #expect(state.coveredSince == nil)
        #expect(state.lastRowID == 100)
    }

    @Test("A longer choice adds one window for the older stretch only, up to the newest message now")
    func widen() {
        var state = firstScan()
        let notBefore = state.notBefore
        state.planOlderWindows(for: .lastYear, newestRowID: 140, now: now)
        #expect(state.olderWindows == [
            OlderWindow(since: now - 365 * dayMilliseconds, before: notBefore, throughRowID: 140, lastRowID: 0, openedAt: now),
        ])
        #expect(state.lastRowID == 100 && state.notBefore == notBefore, "the live cursor is untouched")
        #expect(state.lookback == .lastYear)

        // A day later the same choice adds nothing: the window counts back from when it opened.
        state.planOlderWindows(for: .lastYear, newestRowID: 150, now: now + dayMilliseconds)
        #expect(state.olderWindows.count == 1)
        #expect(state.olderWindowToCheck(for: .lastYear) != nil)
    }

    @Test("Everything while a year is still being looked through goes on below it, in order")
    func widenFurther() {
        var state = firstScan()
        state.planOlderWindows(for: .lastYear, newestRowID: 140, now: now)
        state.olderWindows[0].lastRowID = 60
        state.planOlderWindows(for: .everything, newestRowID: 150, now: now + dayMilliseconds)
        #expect(state.olderWindows.count == 2)
        #expect(state.olderWindows[0].lastRowID == 60, "the year carries on where it was")
        #expect(state.olderWindows[1] == OlderWindow(
            since: 0, before: now - 365 * dayMilliseconds, throughRowID: 150, lastRowID: 0, openedAt: now + dayMilliseconds
        ))

        state.finishNewestOlderWindow()
        #expect(state.coveredSince == now - 365 * dayMilliseconds)
        #expect(state.olderWindowToCheck(for: .everything)?.since == 0)
        state.finishNewestOlderWindow()
        #expect(state.coveredSince == 0)
        #expect(state.olderWindows.isEmpty)
    }

    @Test("A shorter choice sets a window aside with its progress; a longer one joins it back")
    func narrowThenWiden() {
        var state = firstScan()
        state.planOlderWindows(for: .everything, newestRowID: 140, now: now)
        state.olderWindows[0].lastRowID = 42

        // The last year, a day later: the window is split where the year starts, counted back
        // from this choice; the older part waits.
        state.planOlderWindows(for: .lastYear, newestRowID: 150, now: now + dayMilliseconds)
        #expect(state.olderWindows.count == 2)
        let yearStart = now + dayMilliseconds - 365 * dayMilliseconds
        #expect(state.olderWindows[0].since == yearStart && state.olderWindows[0].lastRowID == 42)
        #expect(state.olderWindows[1].since == 0 && state.olderWindows[1].before == yearStart && state.olderWindows[1].lastRowID == 42)
        #expect(state.olderWindowToCheck(for: .lastYear) == state.olderWindows[0])

        // The last 30 days: nothing older is wanted, nothing is lost. The live scan now sends
        // nothing older than 30 days either; what it has not read below that waits, from its place.
        let firstNotBefore = state.notBefore
        state.planOlderWindows(for: .days(30), newestRowID: 150, now: now + 2 * dayMilliseconds)
        #expect(state.olderWindowToCheck(for: .days(30)) == nil)
        let thirtyDaysStart = now + 2 * dayMilliseconds - 30 * dayMilliseconds
        #expect(state.notBefore == thirtyDaysStart && state.lastRowID == 100)
        #expect(state.olderWindows.count == 3)
        #expect(state.olderWindows[0] == OlderWindow(
            since: firstNotBefore, before: thirtyDaysStart, throughRowID: 150, lastRowID: 100, openedAt: now + 2 * dayMilliseconds
        ))

        // Everything again: the year and what came before it are one window again, still at
        // row 42, and the live scan's stretch carries on from row 100. Nothing is read or sent twice.
        state.planOlderWindows(for: .everything, newestRowID: 160, now: now + 3 * dayMilliseconds)
        #expect(state.olderWindows.count == 2)
        #expect(state.olderWindowToCheck(for: .everything)?.lastRowID == 100)
        #expect(state.olderWindows[1].since == 0 && state.olderWindows[1].before == firstNotBefore)
        #expect(state.olderWindows[1].lastRowID == 42 && state.olderWindows[1].throughRowID == 140)
    }

    @Test("A shorter choice while the first scan is still being sent stops it at the new choice, and keeps its place")
    func narrowDuringFirstScan() {
        // Everything, chosen at setup: the live scan has reached row 20 of 140.
        var state = CursorState(lastRowID: 20, notBefore: 0, updatedAt: now, lookback: .everything)
        let chosenAt = now + dayMilliseconds
        state.planOlderWindows(for: .days(30), newestRowID: 140, now: chosenAt)
        let floor = chosenAt - 30 * dayMilliseconds
        #expect(state.notBefore == floor, "the live scan sends nothing older than 30 days now")
        #expect(state.lastRowID == 20)
        #expect(state.olderWindows == [OlderWindow(since: 0, before: floor, throughRowID: 140, lastRowID: 20, openedAt: chosenAt)])
        #expect(state.olderWindowToCheck(for: .days(30)) == nil)

        // The same choice days later moves nothing.
        state.planOlderWindows(for: .days(30), newestRowID: 150, now: chosenAt + 5 * dayMilliseconds)
        #expect(state.notBefore == floor && state.olderWindows.count == 1)

        // Everything again carries on from row 20, in the older stretch only.
        state.planOlderWindows(for: .everything, newestRowID: 160, now: chosenAt + 6 * dayMilliseconds)
        #expect(state.olderWindowToCheck(for: .everything) == OlderWindow(
            since: 0, before: floor, throughRowID: 140, lastRowID: 20, openedAt: chosenAt + 6 * dayMilliseconds
        ))
        #expect(state.notBefore == floor)

        // A longer time is not a shorter one: the live scan is left alone.
        var year = CursorState(lastRowID: 20, notBefore: now - 30 * dayMilliseconds, updatedAt: now, lookback: .days(30))
        year.planOlderWindows(for: .lastYear, newestRowID: 140, now: now)
        #expect(year.notBefore == now - 30 * dayMilliseconds)
    }

    @Test("A window set aside counts back from the new choice when it is wanted again, not from when it opened")
    func setAsideCountsFromNewChoice() {
        // 30 days first; a year a day later; 30 days again an hour after that.
        var state = CursorState(lastRowID: 100, notBefore: now - 30 * dayMilliseconds, updatedAt: now, lookback: .days(30))
        let widenedAt = now + dayMilliseconds
        state.planOlderWindows(for: .lastYear, newestRowID: 140, now: widenedAt)
        state.planOlderWindows(for: .days(30), newestRowID: 140, now: widenedAt + 3_600_000)
        #expect(state.olderWindowToCheck(for: .days(30)) == nil)

        // 400 days on, the last year again: all that was set aside is older than that year, and
        // the live scan already covers the year.
        var late = state
        let lateChoice = widenedAt + 400 * dayMilliseconds
        late.planOlderWindows(for: .lastYear, newestRowID: 900, now: lateChoice)
        #expect(late.olderWindowToCheck(for: .lastYear) == nil)
        #expect(late.notBefore <= lateChoice - 365 * dayMilliseconds)

        // 100 days on instead: only what is inside the year counted back from then is wanted.
        var sooner = state
        let soonerChoice = widenedAt + 100 * dayMilliseconds
        sooner.planOlderWindows(for: .lastYear, newestRowID: 900, now: soonerChoice)
        let wanted = sooner.olderWindows.filter { $0.isWanted(by: .lastYear) }
        #expect(wanted.map(\.since).min() == soonerChoice - 365 * dayMilliseconds)
        #expect(sooner.olderWindows.last?.since == widenedAt - 365 * dayMilliseconds, "the older part waits, not lost")
    }

    @Test("A cursor from version 1 still loads, with nothing older planned")
    func versionOne() throws {
        let json = #"{"version":1,"lastRowID":812,"notBefore":1787659200000,"updatedAt":1790251200000,"databasePath":"/tmp/chat.db"}"#
        let state = try JSONDecoder().decode(CursorState.self, from: Data(json.utf8))
        #expect(state == CursorState(lastRowID: 812, notBefore: 1_787_659_200_000, updatedAt: 1_790_251_200_000, databasePath: "/tmp/chat.db"))
        #expect(state.lookback == nil && state.coveredSince == nil && state.olderWindows.isEmpty)
        #expect(state.version == CursorState.currentVersion)
    }

    @Test("The covered range and older windows are saved in cursor.json, times and row numbers only")
    func roundTrip() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        var state = firstScan()
        state.planOlderWindows(for: .everything, newestRowID: 140, now: now)
        let store = CursorStore(fileURL: temp.file("cursor.json"))
        try store.save(state)
        #expect(try store.load() == state)
        let json = try String(contentsOf: store.fileURL, encoding: .utf8)
        #expect(json.contains("\"lookback\" : \"everything\""))
        #expect(json.contains("\"olderWindows\""))
    }
}

@Suite("Older messages: reading")
struct OlderRowsTests {
    @Test("Only rows inside the dates and the row range are read")
    func datedRows() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let scenario = try StandardScenario(url: temp.file("chat.db"))
        let database = try MessagesDatabase(url: scenario.database.url)
        let old = try #require(scenario.rows["old"])

        let window = try database.rows(after: 0, through: scenario.maxRowID, datedFrom: now - 90 * dayMilliseconds, before: now - 30 * dayMilliseconds, limit: 50)
        #expect(window.map(\.rowID) == [old], "only the 60-day-old message")
        #expect(try database.rows(after: old, through: scenario.maxRowID, datedFrom: 0, before: now - 30 * dayMilliseconds, limit: 50).isEmpty)
        #expect(try database.rows(after: 0, through: 0, datedFrom: 0, before: now, limit: 50).isEmpty, "nothing past the last row")
        let all = try database.rows(after: 0, through: scenario.maxRowID, datedFrom: 0, before: now, limit: 50)
        #expect(all.count == Int(scenario.maxRowID))
    }

    @Test("Dates in seconds, from older Macs, are read too")
    func legacySeconds() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let db = try SyntheticChatDatabase(url: temp.file("chat.db"), schema: .legacy)
        let handle = try db.addHandle("+12065550130")
        try db.addMessage(.init(guid: "legacy-old", text: "Thank you for everything", handleID: handle, date: 600_000_000))
        let occurred: Int64 = (978_307_200 + 600_000_000) * 1_000
        let database = try MessagesDatabase(url: db.url)
        #expect(try database.rows(after: 0, through: 1, datedFrom: occurred, before: occurred + 1, limit: 5).count == 1)
        #expect(try database.rows(after: 0, through: 1, datedFrom: occurred + 1, before: now, limit: 5).isEmpty)
    }
}

@Suite("Older messages: scanning")
struct OlderMessageScanTests {
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

        var scanner: MessageScanner {
            MessageScanner(
                databaseURL: scenario.database.url,
                prefilter: try! Fixtures.prefilter(),
                cursorStore: cursorStore,
                sender: WitnessClient(
                    baseURL: URL(string: "https://witness.example.com")!,
                    token: WitnessClientTests.token,
                    transport: transport,
                    retryPolicy: RetryPolicy(maxAttempts: 2, baseDelay: 0, maxDelay: 0, jitter: 0),
                    sleep: { _ in }
                ),
                now: { testNow }
            )
        }

        /// Kind messages dated `daysAgo` days back, added after the first scenario rows.
        @discardableResult
        func addOld(_ daysAgo: [Double]) throws -> [String] {
            let handle = try scenario.database.addHandle("+12065550140")
            return try daysAgo.enumerated().map { index, days in
                let guid = String(format: "E0000000-0000-4000-8000-%012d", index + 1)
                try scenario.database.addMessage(.init(
                    guid: guid, text: "Thank you so much for being there, always",
                    handleID: handle, date: SyntheticChatDatabase.appleNanoseconds(daysAgo: days)))
                return guid
            }
        }

        func sentGUIDs() async throws -> [String] {
            try await transport.bodies().compactMap { $0["sourceRef"] as? String }
        }
    }

    @Test("A longer time after the first scan looks through only the older messages, and sends nothing twice")
    func widenOnce() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let first = try await harness.scanner.scanOnce(options: .thirtyDays)
        #expect(first.sent == 4)
        let live = try #require(try harness.cursorStore.load())

        let year = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .lastYear))
        #expect(year.sent == 1)
        #expect(year.scanned == 1, "only the older stretch was read")
        #expect(!year.lookingBack)
        #expect(try await harness.sentGUIDs().last == oldGUID)

        let cursor = try #require(try harness.cursorStore.load())
        #expect(cursor.lastRowID == live.lastRowID && cursor.notBefore == live.notBefore, "the live cursor is untouched")
        #expect(cursor.coveredSince == now - 365 * dayMilliseconds)
        #expect(cursor.olderWindows.isEmpty)

        #expect(try await harness.scanner.scanOnce(options: ScanOptions(lookback: .lastYear)).scanned == 0)

        // Everything reaches a two-year-old message, and only that one.
        let twoYears = try harness.addOld([730])
        let everything = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .everything))
        #expect(everything.sent == 1)
        #expect(try await harness.sentGUIDs().last == twoYears.first)
        #expect(try harness.cursorStore.load()?.coveredSince == 0)

        let guids = try await harness.sentGUIDs()
        #expect(guids.count == 6)
        #expect(Set(guids).count == guids.count, "nothing was sent twice")
    }

    @Test("Older messages go a few at a time, and never past one the server did not take")
    func pacing() async throws {
        let transport = MockTransport()
        let harness = try Harness(transport: transport)
        defer { harness.temp.remove() }
        let added = try harness.addOld([100, 110, 120, 130, 140])
        _ = try await harness.scanner.scanOnce(options: .thirtyDays)
        let paced = ScanOptions(lookback: .lastYear, sendLimit: 2)

        let one = try await harness.scanner.scanOnce(options: paced)
        #expect(one.sent == 2)
        #expect(one.continueAt == testNow.addingTimeInterval(ScanOptions.defaultPause))
        #expect(one.lookingBack)
        #expect(try await harness.scanner.scanOnce(options: paced).sent == 2)

        // The server is down: the scan stops at that message and keeps it.
        await transport.setReplies([.status(503), .status(503)])
        let down = try await harness.scanner.scanOnce(options: paced)
        #expect(down.stoppedEarly == .http(status: 503, code: nil))
        #expect(down.sent == 0 && down.lookingBack)
        #expect(down.continueAt == nil)

        let last = try await harness.scanner.scanOnce(options: paced)
        #expect(last.sent == 2)
        #expect(!last.lookingBack)
        #expect(last.continueAt == nil)

        // In order, each once, except the one the server refused (twice, with its retry),
        // which went first again rather than being skipped.
        let guids = try await harness.sentGUIDs()
        #expect(guids == StandardScenario.candidateGUIDs + [oldGUID] + added.prefix(3) + [added[3], added[3]] + added.suffix(2))
    }

    @Test("When the server asks to slow down, the rest wait longer")
    func slowDown() async throws {
        let transport = MockTransport()
        let harness = try Harness(transport: transport)
        defer { harness.temp.remove() }
        let added = try harness.addOld([100, 110])
        _ = try await harness.scanner.scanOnce(options: .thirtyDays)

        // 429, then taken on the retry: that one counts, and the next wait is the long one.
        await transport.setReplies([.status(429, headers: ["Retry-After": "1"]), .saved])
        let slowed = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .lastYear))
        #expect(slowed.sent == 1)
        #expect(slowed.stoppedEarly == nil)
        #expect(slowed.continueAt == testNow.addingTimeInterval(ScanOptions.defaultSlowDownPause))

        // Still 429 after the retry: nothing is skipped, and it waits the long pause too.
        await transport.setReplies([.status(429), .status(429)])
        let refused = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .lastYear))
        #expect(refused.stoppedEarly == .http(status: 429, code: nil))
        #expect(refused.continueAt == testNow.addingTimeInterval(ScanOptions.defaultSlowDownPause))
        #expect(refused.sent == 0)

        let rest = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .lastYear))
        #expect(rest.sent == 2)
        let guids = try await harness.sentGUIDs().filter { $0 != oldGUID && !StandardScenario.candidateGUIDs.contains($0) }
        #expect(Set(guids) == Set(added))
        #expect(guids.last == added[1])
    }

    @Test("A shorter time sets the older messages aside; a longer one carries on where it stopped")
    func narrowThenWiden() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        try harness.addOld([100, 400, 500])
        _ = try await harness.scanner.scanOnce(options: .thirtyDays)

        let started = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .everything, sendLimit: 2))
        #expect(started.sent == 2)
        let back = try await harness.scanner.scanOnce(options: .thirtyDays)
        #expect(back.sent == 0 && back.scanned == 0)
        #expect(!back.lookingBack)

        let again = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .everything, sendLimit: 2))
        #expect(again.sent == 2)
        #expect(!again.lookingBack)
        let guids = try await harness.sentGUIDs()
        #expect(guids.count == 4 + 4)
        #expect(Set(guids).count == guids.count, "nothing was sent twice")
    }

    @Test("A shorter time while the first scan is still being sent sends nothing older from then on; a longer one carries on")
    func narrowDuringFirstScan() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let added = try harness.addOld([100, 200, 900])
        // Everything at setup: the first kind message in row order (60 days old) goes, then it waits.
        let first = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .everything, sendLimit: 1))
        #expect(first.sent == 1 && first.lookingBack)

        let narrowed = try await harness.scanner.scanOnce(options: .thirtyDays)
        #expect(narrowed.sent == 4, "the four from the last 30 days, none older")
        #expect(!narrowed.lookingBack)
        #expect(try await harness.sentGUIDs() == [oldGUID] + StandardScenario.candidateGUIDs)

        let everything = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .everything))
        #expect(everything.sent == 3)
        let guids = try await harness.sentGUIDs()
        #expect(Array(guids.suffix(3)) == added)
        #expect(Set(guids).count == guids.count, "nothing was sent twice")
    }

    @Test("Before the pause is over, a scan started for another reason sends nothing, and gives the same time")
    func pausedUntil() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let first = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .lastYear, sendLimit: 3))
        #expect(first.sent == 3)
        let continueAt = try #require(first.continueAt)
        let place = try harness.cursorStore.load()?.lastRowID

        let early = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .lastYear, sendLimit: 3, pausedUntil: continueAt))
        #expect(early.sent == 0 && early.candidates == 0)
        #expect(early.continueAt == continueAt, "the wait is not made longer")
        #expect(early.lookingBack)
        #expect(try harness.cursorStore.load()?.lastRowID == place)
        #expect(await harness.transport.requests.count == 3)

        let due = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .lastYear, sendLimit: 3, pausedUntil: testNow))
        #expect(due.sent == 2)
        #expect(try await harness.sentGUIDs() == [oldGUID] + StandardScenario.candidateGUIDs)
    }

    @Test("Without a chosen time, a scan carries on with the one chosen before; an older cursor looks no further back")
    func unchosenLookback() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        try harness.addOld([100, 200, 300])
        _ = try await harness.scanner.scanOnce(options: .thirtyDays)
        _ = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .everything, sendLimit: 2))
        let unchosen = ScanOptions(lookback: .default, lookbackChosen: false)
        let carried = try await harness.scanner.scanOnce(options: unchosen)
        #expect(carried.sent == 2, "everything, as chosen before")
        #expect(try harness.cursorStore.load()?.coveredSince == 0)

        // A cursor from version 1 has no choice saved: the default does not reach back.
        let legacy = try Harness()
        defer { legacy.temp.remove() }
        _ = try await legacy.scanner.scanOnce(options: .thirtyDays)
        var cursor = try #require(try legacy.cursorStore.load())
        cursor.lookback = nil
        try legacy.cursorStore.save(cursor)
        let summary = try await legacy.scanner.scanOnce(options: unchosen)
        #expect(summary.sent == 0 && summary.scanned == 0)
        #expect(try legacy.cursorStore.load()?.olderWindows.isEmpty == true)
    }

    @Test("A dry run counts the older messages, and sends and saves nothing")
    func dryRun() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        _ = try await harness.scanner.scanOnce(options: .thirtyDays)
        let saved = try Data(contentsOf: harness.cursorStore.fileURL)
        let summary = try await harness.scanner.scanOnce(options: ScanOptions(dryRun: true, lookback: .lastYear))
        #expect(summary.candidates == 1 && summary.sent == 0)
        #expect(try Data(contentsOf: harness.cursorStore.fileURL) == saved)
        #expect(await harness.transport.requests.count == 4)
    }

    @Test("A first scan of a year also goes a few at a time")
    func pacedFirstScan() async throws {
        let harness = try Harness()
        defer { harness.temp.remove() }
        let first = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .lastYear, sendLimit: 3))
        #expect(first.sent == 3)
        #expect(first.continueAt != nil)
        #expect(first.lookingBack, "the panel says it is still looking through the year")
        let cursor = try #require(try harness.cursorStore.load())
        #expect(cursor.lastRowID < harness.scenario.maxRowID, "stopped before the next kind message")
        let second = try await harness.scanner.scanOnce(options: ScanOptions(lookback: .lastYear, sendLimit: 3))
        #expect(second.sent == 2)
        #expect(second.continueAt == nil)
        #expect(!second.lookingBack)
        #expect(try await harness.sentGUIDs() == [oldGUID] + StandardScenario.candidateGUIDs)
    }
}

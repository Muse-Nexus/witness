import Foundation
import Testing
@testable import WitnessMacCore

@Suite("App state")
struct AppStateTests {
    @Test("Defaults when nothing is saved or the file cannot be read")
    func defaults() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let store = AppStateStore(fileURL: temp.file("Witness/app-state.json"))
        #expect(store.load() == AppState())
        #expect(AppState().lookbackDays == 30)
        #expect(!AppState().namesEnabled, "names are off until the person turns them on")
        #expect(!AppState().isPaused)

        try FileManager.default.createDirectory(at: temp.file("Witness"), withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: store.fileURL)
        #expect(store.load() == AppState())
    }

    @Test("Pause is saved privately and survives a restart")
    func pausePersists() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let store = AppStateStore(fileURL: temp.file("Witness/app-state.json"))
        var state = AppState(namesEnabled: true, lookbackDays: 90)
        state.pause = PauseState(reason: .byPerson, since: 1_790_251_200_000)
        try store.save(state)

        #expect(AppStateStore(fileURL: store.fileURL).load() == state)
        let mode = try FileManager.default.attributesOfItem(atPath: store.fileURL.path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
        let json = try String(contentsOf: store.fileURL, encoding: .utf8)
        #expect(json.contains("\"byPerson\""))

        state.pause = nil
        try store.save(state)
        #expect(!store.load().isPaused)
    }

    @Test("A partial or newer file still loads, with defaults for what is missing")
    func tolerantDecoding() throws {
        let partial = #"{"pause":{"reason":"keyRefused","since":5},"lookbackDays":99999,"futureSetting":true}"#
        let state = try JSONDecoder().decode(AppState.self, from: Data(partial.utf8))
        #expect(state.pause == PauseState(reason: .keyRefused, since: 5))
        #expect(state.lookbackDays == 30, "an impossible lookback falls back to the default")
        #expect(state.setup == SetupProgress())
        #expect(!state.namesEnabled)

        let unknownReason = #"{"pause":{"reason":"somethingNew","since":5}}"#
        #expect(try JSONDecoder().decode(AppState.self, from: Data(unknownReason.utf8)).pause == nil)
    }
}

@Suite("Activity counts")
struct ActivityLogTests {
    /// Sunday-first weeks in UTC, so the test does not depend on the machine's settings.
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        calendar.firstWeekday = 1
        return calendar
    }

    // testNow is Thursday 2026-09-24 12:00 UTC; that week began Sunday 2026-09-20.
    func at(daysAgo days: Double, hours: Double = 0) -> Date {
        testNow.addingTimeInterval(-(days * 86_400 + hours * 3_600))
    }

    @Test("Counts what was sent today and this week")
    func counts() {
        var log = ActivityLog()
        log.recordCheck(sent: 2, at: at(daysAgo: 0, hours: 1)) // today 11:00
        log.recordCheck(sent: 1, at: at(daysAgo: 0, hours: 11.5)) // today 00:30
        log.recordCheck(sent: 3, at: at(daysAgo: 3)) // Monday
        log.recordCheck(sent: 5, at: at(daysAgo: 5)) // last Saturday, previous week
        log.recordCheck(sent: 0, at: testNow)

        #expect(log.sentToday(now: testNow, calendar: Self.calendar) == 3)
        #expect(log.sentThisWeek(now: testNow, calendar: Self.calendar) == 6)
        #expect(log.lastCheck == testNow)
    }

    @Test("Keeps only a week and a day of times")
    func prunes() {
        var log = ActivityLog()
        log.recordCheck(sent: 4, at: at(daysAgo: 9))
        log.recordCheck(sent: 1, at: at(daysAgo: 1))
        log.recordCheck(sent: 1, at: testNow)
        #expect(log.sentAt.count == 2)
    }

    @Test("Saved as times and counts only")
    func store() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let store = ActivityStore(fileURL: temp.file("activity.json"))
        #expect(store.load() == ActivityLog())
        var log = ActivityLog()
        log.recordCheck(sent: 2, at: testNow)
        try store.save(log)
        #expect(store.load() == log)
        let keys = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: store.fileURL)) as? [String: Any]).keys
        #expect(Set(keys) == ["version", "lastCheckAt", "sentAt"])
    }
}

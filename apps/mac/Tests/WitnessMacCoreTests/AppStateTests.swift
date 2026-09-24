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

    @Test("The lookback is one of the choices setup offers, whatever the file says", arguments: [
        (7, 7), (30, 30), (90, 90), (0, 30), (3650, 30), (365, 30), (-1, 30),
    ])
    func lookbackChoices(saved: Int, loaded: Int) throws {
        let json = #"{"lookbackDays":\#(saved),"setup":{"outcomes":{},"finishedAt":1},"namesEnabled":true}"#
        #expect(try JSONDecoder().decode(AppState.self, from: Data(json.utf8)).lookbackDays == loaded)
    }
}

@Suite("Last check")
struct ActivityLogTests {
    @Test("Keeps the time of the last check, and nothing else")
    func lastCheck() {
        var log = ActivityLog()
        #expect(log.lastCheck == nil)
        log.recordCheck(at: testNow.addingTimeInterval(-60))
        log.recordCheck(at: testNow)
        #expect(log.lastCheck == testNow)
    }

    @Test("Saved as a time only; an older file with send times still loads, without them")
    func store() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let store = ActivityStore(fileURL: temp.file("activity.json"))
        #expect(store.load() == ActivityLog())
        var log = ActivityLog()
        log.recordCheck(at: testNow)
        try store.save(log)
        #expect(store.load() == log)
        let keys = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: store.fileURL)) as? [String: Any]).keys
        #expect(Set(keys) == ["version", "lastCheckAt"])

        let older = #"{"version":1,"lastCheckAt":1790251200000,"sentAt":[1790251200000,1790251200000]}"#
        try Data(older.utf8).write(to: store.fileURL)
        #expect(store.load() == ActivityLog(lastCheckAt: 1_790_251_200_000))
    }
}

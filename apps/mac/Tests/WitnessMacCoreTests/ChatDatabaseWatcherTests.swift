import Foundation
import os
import Testing
@testable import WitnessMacCore

@Suite("ChatDatabaseWatcher")
struct ChatDatabaseWatcherTests {
    /// Collects triggers from a watcher in the background.
    actor Collector {
        private(set) var triggers: [ChatDatabaseWatcher.Trigger] = []

        func append(_ trigger: ChatDatabaseWatcher.Trigger) {
            triggers.append(trigger)
        }

        func count(of trigger: ChatDatabaseWatcher.Trigger) -> Int {
            triggers.filter { $0 == trigger }.count
        }
    }

    private func collect(_ watcher: ChatDatabaseWatcher) -> (Collector, Task<Void, Never>) {
        let collector = Collector()
        let stream = watcher.triggers()
        let task = Task {
            for await trigger in stream {
                await collector.append(trigger)
            }
        }
        return (collector, task)
    }

    private func waitUntil(timeout: TimeInterval = 5, _ condition: () async -> Bool) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    @Test("Starts with a startup trigger and debounces a burst of changes into one")
    func debounce() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let watcher = ChatDatabaseWatcher(databaseURL: temp.file("chat.db"), debounce: 0.3, safetyInterval: 0)
        let (collector, task) = collect(watcher)

        await waitUntil { await collector.count(of: .startup) == 1 }
        for _ in 0..<10 {
            watcher.noteChange()
        }
        await waitUntil { await collector.count(of: .change) >= 1 }
        try await Task.sleep(nanoseconds: 600_000_000)

        #expect(await collector.triggers == [.startup, .change])
        watcher.stop()
        await task.value
    }

    @Test("Rescans asked for while one is waiting make one rescan, at the soonest time")
    func oneRescan() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let watcher = ChatDatabaseWatcher(databaseURL: temp.file("chat.db"), debounce: 10, safetyInterval: 0)
        let (collector, task) = collect(watcher)
        await waitUntil { await collector.count(of: .startup) == 1 }

        let soon = Date().addingTimeInterval(0.1)
        watcher.scheduleRescan(at: soon.addingTimeInterval(0.3))
        watcher.scheduleRescan(at: soon)
        watcher.scheduleRescan(at: soon.addingTimeInterval(0.6))
        await waitUntil { await collector.count(of: .periodic) >= 1 }
        // Each rescan waits a second past its time; the later ones would have come by now.
        try await Task.sleep(nanoseconds: 1_500_000_000)
        #expect(await collector.count(of: .periodic) == 1)

        // Once it has run, the next one asked for is kept again.
        watcher.scheduleRescan(at: Date())
        await waitUntil { await collector.count(of: .periodic) >= 2 }
        #expect(await collector.count(of: .periodic) == 2)
        watcher.stop()
        await task.value
    }

    @Test("A rescan whose time passed while the Mac slept never holds back a sooner one")
    func staleRescan() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        // The wall clock the checks' times come from. The watcher's own waits count only while
        // the Mac is awake, so a sleep moves this clock and not them.
        let clock = OSAllocatedUnfairLock(initialState: Date())
        let watcher = ChatDatabaseWatcher(databaseURL: temp.file("chat.db"), debounce: 10, safetyInterval: 0, now: { clock.withLock { $0 } })
        let (collector, task) = collect(watcher)
        await waitUntil { await collector.count(of: .startup) == 1 }

        // Just before the lid closes, a 429 asks for a rescan in five minutes.
        watcher.scheduleRescan(at: clock.withLock { $0 }.addingTimeInterval(300))
        // Hours later, a check on waking asks for the next few now.
        let woke = clock.withLock { now in
            now.addTimeInterval(3 * 3_600)
            return now
        }
        watcher.scheduleRescan(at: woke)
        await waitUntil { await collector.count(of: .periodic) >= 1 }
        #expect(await collector.count(of: .periodic) == 1, "the new one ran a second later, not after the old one's five minutes")
        watcher.stop()
        await task.value
    }

    @Test("Writing to chat.db-wal triggers a scan")
    func walWrite() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let database = temp.file("chat.db")
        let wal = temp.file("chat.db-wal")
        try Data("db".utf8).write(to: database)
        try Data("wal".utf8).write(to: wal)

        let watcher = ChatDatabaseWatcher(databaseURL: database, debounce: 0.1, safetyInterval: 0)
        #expect(watcher.watchedURL.lastPathComponent == "chat.db-wal")
        let (collector, task) = collect(watcher)
        await waitUntil { await collector.count(of: .startup) == 1 }
        // Give the file source a moment to be installed on the watcher's queue.
        try await Task.sleep(nanoseconds: 100_000_000)

        let handle = try FileHandle(forWritingTo: wal)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("new rows".utf8))
        try handle.close()

        await waitUntil { await collector.count(of: .change) >= 1 }
        #expect(await collector.count(of: .change) >= 1)
        watcher.stop()
        await task.value
    }

    @Test("Without a WAL file the database itself is watched")
    func fallsBackToDatabase() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let database = temp.file("chat.db")
        try Data("db".utf8).write(to: database)
        #expect(ChatDatabaseWatcher(databaseURL: database).watchedURL == database)
    }

    @Test("The periodic safety trigger fires")
    func periodic() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let watcher = ChatDatabaseWatcher(databaseURL: temp.file("chat.db"), debounce: 5, safetyInterval: 0.2)
        let (collector, task) = collect(watcher)
        await waitUntil { await collector.count(of: .periodic) >= 1 }
        #expect(await collector.count(of: .periodic) >= 1)
        watcher.stop()
        await task.value
    }

    @Test("stop() ends the stream")
    func stopEnds() async throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let watcher = ChatDatabaseWatcher(databaseURL: temp.file("chat.db"), debounce: 5, safetyInterval: 0)
        let (_, task) = collect(watcher)
        watcher.stop()
        await task.value
    }
}

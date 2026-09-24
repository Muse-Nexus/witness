import Foundation
import Testing
@testable import WitnessMacCore

@Suite("MessagesDatabase")
struct MessagesDatabaseTests {
    @Test("Classifies every row of the synthetic conversation")
    func classifiesRows() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let scenario = try StandardScenario(url: temp.file("chat.db"))

        let database = try MessagesDatabase(url: scenario.database.url)
        let rows = try database.rows(after: 0, limit: 100)
        #expect(rows.map(\.rowID) == scenario.rows.values.sorted())

        func row(_ name: String) throws -> MessageRow {
            let id = try #require(scenario.rows[name])
            return try #require(rows.first { $0.rowID == id })
        }

        #expect(try row("reply") == .skipped(rowID: scenario.rows["reply"]!, reason: .fromMe))
        #expect(try row("tapback") == .skipped(rowID: scenario.rows["tapback"]!, reason: .tapback))
        #expect(try row("retracted") == .skipped(rowID: scenario.rows["retracted"]!, reason: .retracted))
        #expect(try row("attachmentOnly") == .skipped(rowID: scenario.rows["attachmentOnly"]!, reason: .empty))
        #expect(try row("groupEvent") == .skipped(rowID: scenario.rows["groupEvent"]!, reason: .notAMessage))

        guard case .incoming(let thanks) = try row("thanks") else { Issue.record("thanks not incoming"); return }
        #expect(thanks.text == StandardScenario.Text.thanks)
        #expect(thanks.handle == "+12065550101")
        #expect(thanks.service == .iMessage)
        #expect(thanks.threadKind == .direct)
        #expect(thanks.guid == "F0000000-0000-4000-8000-000000000002")
        #expect(thanks.editedAt == nil)

        guard case .incoming(let proud) = try row("proud") else { Issue.record("proud not incoming"); return }
        #expect(proud.text == StandardScenario.Text.proud, "text NULL, body only in attributedBody")
        #expect(proud.handle == "friend@example.com")

        guard case .incoming(let congrats) = try row("congrats") else { Issue.record("congrats not incoming"); return }
        #expect(congrats.threadKind == .group)
        #expect(congrats.service == .sms)

        guard case .incoming(let madeMyDay) = try row("madeMyDay") else { Issue.record("madeMyDay not incoming"); return }
        #expect(madeMyDay.service == .rcs)
        #expect(madeMyDay.service.sourceLabel == "RCS")
        #expect(madeMyDay.editedAt != nil)

        guard case .incoming(let otp) = try row("otp") else { Issue.record("otp not incoming"); return }
        #expect(otp.threadKind == nil, "no chat join means the thread kind is unknown")
    }

    @Test("Converts Apple-epoch nanoseconds to Unix milliseconds")
    func dates() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let db = try SyntheticChatDatabase(url: temp.file("chat.db"))
        let handle = try db.addHandle("+12065550105")
        let unixMilliseconds: Int64 = 1_790_000_000_123
        try db.addMessage(.init(
            guid: "ns", text: "Thank you",
            handleID: handle, date: AppleTime.messagesNanoseconds(fromUnixMilliseconds: unixMilliseconds)))
        try db.addMessage(.init(
            guid: "seconds", text: "Thank you",
            handleID: handle, date: AppleTime.messagesSeconds(fromUnixMilliseconds: unixMilliseconds)))
        try db.addMessage(.init(guid: "unknown", text: "Thank you", handleID: handle, date: 0))

        let rows = try MessagesDatabase(url: db.url).rows(after: 0, limit: 10)
        let dates = rows.compactMap { row -> Int64?? in
            if case .incoming(let message) = row { return message.occurredAt }
            return nil
        }
        #expect(dates == [unixMilliseconds, 1_790_000_000_000, nil])
    }

    @Test("Resumes after a cursor and respects the batch limit")
    func cursorAndLimit() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let scenario = try StandardScenario(url: temp.file("chat.db"))
        let database = try MessagesDatabase(url: scenario.database.url)

        let first = try database.rows(after: 0, limit: 3)
        #expect(first.map(\.rowID) == [1, 2, 3])
        let next = try database.rows(after: 3, limit: 3)
        #expect(next.map(\.rowID) == [4, 5, 6])
        #expect(try database.rows(after: scenario.maxRowID, limit: 10).isEmpty)
        #expect(try database.maxRowID() == scenario.maxRowID)
    }

    @Test("Finds the first message inside a lookback window")
    func firstRowInWindow() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let scenario = try StandardScenario(url: temp.file("chat.db"))
        let database = try MessagesDatabase(url: scenario.database.url)
        let now = AppleTime.unixMilliseconds(testNow)

        #expect(try database.firstRowID(onOrAfter: now - 30 * dayMilliseconds) == scenario.rows["thanks"])
        #expect(try database.firstRowID(onOrAfter: now - 90 * dayMilliseconds) == scenario.rows["old"])
        #expect(try database.firstRowID(onOrAfter: now + dayMilliseconds) == nil)
    }

    @Test("Reads older databases without the optional columns")
    func legacySchema() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let db = try SyntheticChatDatabase(url: temp.file("chat.db"), schema: .legacy)
        let handle = try db.addHandle("+12065550106")
        let chat = try db.addChat(style: 45, identifier: "+12065550106")
        try db.addMessage(.init(
            guid: "legacy-1", text: "So grateful for you", handleID: handle,
            date: 600_000_000, chatID: chat))

        let rows = try MessagesDatabase(url: db.url).rows(after: 0, limit: 10)
        guard case .incoming(let message) = rows.first else { Issue.record("expected an incoming row"); return }
        #expect(message.text == "So grateful for you")
        let expected: Int64 = (978_307_200 + 600_000_000) * 1_000
        #expect(message.occurredAt == expected)
        #expect(message.threadKind == .direct)
    }

    @Test("Reads a database in WAL mode")
    func walMode() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let db = try SyntheticChatDatabase(url: temp.file("chat.db"), journalMode: "WAL")
        let handle = try db.addHandle("+12065550107")
        try db.addMessage(.init(guid: "wal-1", text: "Here for you", handleID: handle, date: 800_000_000_000_000_000))
        #expect(FileManager.default.fileExists(atPath: temp.file("chat.db-wal").path))

        let rows = try MessagesDatabase(url: db.url).rows(after: 0, limit: 10)
        #expect(rows.count == 1)
    }

    @Test("Opens paths that need URI escaping")
    func escapedPath() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let directory = temp.url.appendingPathComponent("Library Copy #2 ?")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let scenario = try StandardScenario(url: directory.appendingPathComponent("chat.db"))
        #expect(try MessagesDatabase(url: scenario.database.url).maxRowID() == scenario.maxRowID)
    }

    @Test("The connection is read-only")
    func readOnly() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let scenario = try StandardScenario(url: temp.file("chat.db"))
        let connection = try ReadOnlySQLite(path: scenario.database.url.path)
        #expect(throws: SQLiteError.self) {
            try connection.forEachRow("DELETE FROM message") { _ in }
        }
        #expect(throws: SQLiteError.self) {
            try connection.forEachRow("CREATE TABLE witness_was_here (id INTEGER)") { _ in }
        }
        #expect(try MessagesDatabase(url: scenario.database.url).maxRowID() == scenario.maxRowID)
    }

    @Test("A missing database is an error and is not created")
    func missingDatabase() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let path = temp.file("nothing-here.db")
        #expect(throws: SQLiteError.self) { try MessagesDatabase(url: path) }
        #expect(!FileManager.default.fileExists(atPath: path.path))
    }

    @Test("A database without the Messages tables is refused")
    func unsupportedSchema() throws {
        let temp = try TemporaryDirectory()
        defer { temp.remove() }
        let db = try SyntheticChatDatabase(url: temp.file("chat.db"))
        try db.execute("DROP TABLE chat_message_join")
        #expect(throws: MessagesDatabaseError.unsupportedSchema(missing: "chat_message_join.chat_id")) {
            try MessagesDatabase(url: db.url)
        }
    }

    @Test("Text resolution prefers the text column and strips attachment placeholders")
    func textResolution() {
        let body = TypedStreamArchiver.attributedBody("from the body")
        #expect(MessagesDatabase.resolveText(column: "from the column", attributedBody: body) == "from the column")
        #expect(MessagesDatabase.resolveText(column: "  \u{FFFC} ", attributedBody: body) == "from the body")
        #expect(MessagesDatabase.resolveText(column: nil, attributedBody: body) == "from the body")
        #expect(MessagesDatabase.resolveText(column: nil, attributedBody: Data([1, 2, 3])) == nil)
        #expect(MessagesDatabase.resolveText(column: "\u{FFFC}Look at this", attributedBody: nil) == "Look at this")
    }

    @Test("Service labels", arguments: [
        ("iMessage", "iMessage"), ("SMS", "SMS"), ("RCS", "RCS"), ("iMessageLite", "iMessage"), (nil, "Messages"),
    ] as [(String?, String)])
    func serviceLabels(column: String?, label: String) {
        #expect(MessageService(column: column).sourceLabel == label)
    }
}

@Suite("AppleTime")
struct AppleTimeTests {
    @Test("Nanoseconds and seconds both convert, and round-trip")
    func conversions() {
        let unix: Int64 = 1_790_251_200_000
        #expect(AppleTime.unixMilliseconds(fromMessagesDate: AppleTime.messagesNanoseconds(fromUnixMilliseconds: unix)) == unix)
        #expect(AppleTime.unixMilliseconds(fromMessagesDate: AppleTime.messagesSeconds(fromUnixMilliseconds: unix)) == unix)
        #expect(AppleTime.unixMilliseconds(fromMessagesDate: 0) == nil)
        #expect(AppleTime.unixMilliseconds(fromMessagesDate: -5) == nil)
        #expect(AppleTime.unixMilliseconds(fromMessagesDate: 1) == 978_307_201_000)
        #expect(AppleTime.unixMilliseconds(fromMessagesDate: Int64.max) != nil)
    }
}

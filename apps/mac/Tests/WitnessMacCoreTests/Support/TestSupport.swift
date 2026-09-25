import CSQLite
import Foundation
import os
@testable import WitnessMacCore

// All names, handles and messages in these tests are fictional.

/// A fixed "now" for tests: 2026-09-24 12:00:00 UTC.
let testNow = Date(timeIntervalSince1970: 1_790_251_200)
let dayMilliseconds: Int64 = 86_400_000

enum Fixtures {
    static var directory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // Support
            .deletingLastPathComponent() // WitnessMacCoreTests
            .appendingPathComponent("Fixtures")
    }

    static var lexiconURL: URL { directory.appendingPathComponent("lexicon.test.json") }

    static func prefilter() throws -> Prefilter {
        try Prefilter.load(from: lexiconURL)
    }
}

extension ScanOptions {
    /// The standard scenario was built around a 30-day first scan: its 60-day-old thank-you
    /// stays out.
    static let thirtyDays = ScanOptions(lookback: .days(30))
}

/// Waits until `condition` holds, or `timeout` seconds pass. Returns whether it held.
@discardableResult
func eventually(timeout: TimeInterval = 10, _ condition: () async -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    return await condition()
}

/// A clock the test moves by hand: each `sleep` waits for the next `tick()`, and records
/// how long it was asked to wait.
final class ManualClock: Sendable {
    private let ticks: AsyncStream<Void>
    private let continuation: AsyncStream<Void>.Continuation
    private let asked = OSAllocatedUnfairLock<[TimeInterval]>(initialState: [])

    init() {
        (ticks, continuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .unbounded)
    }

    /// How long each `sleep` asked to wait, in order.
    var requests: [TimeInterval] { asked.withLock { $0 } }

    func tick() { continuation.yield() }

    @Sendable func sleep(_ seconds: TimeInterval) async throws {
        asked.withLock { $0.append(seconds) }
        var iterator = ticks.makeAsyncIterator()
        guard await iterator.next() != nil, !Task.isCancelled else { throw CancellationError() }
    }
}

/// A unique directory under the system temporary directory, removed by `remove()`.
struct TemporaryDirectory {
    let url: URL

    init() throws {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent("witness-mac-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    func file(_ name: String) -> URL { url.appendingPathComponent(name) }

    func remove() {
        try? FileManager.default.removeItem(at: url)
    }
}

/// Produces typedstream blobs the way Messages does, with `NSArchiver`.
///
/// `NSArchiver` is deprecated, so it is looked up at runtime. That keeps the
/// test build free of deprecation warnings while exercising the real encoder.
enum TypedStreamArchiver {
    static func archive(_ object: Any) -> Data {
        guard let archiverClass = NSClassFromString("NSArchiver") as AnyObject?,
              let result = archiverClass.perform(NSSelectorFromString("archivedDataWithRootObject:"), with: object),
              let data = result.takeUnretainedValue() as? Data
        else { fatalError("NSArchiver is not available") }
        return data
    }

    static func attributedBody(_ text: String, mutable: Bool = true) -> Data {
        let string: NSAttributedString = mutable
            ? NSMutableAttributedString(string: text)
            : NSAttributedString(string: text)
        return archive(string)
    }
}

/// A deterministic random number generator so fuzz failures can be reproduced.
struct SplitMix64: RandomNumberGenerator {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

/// Collects output lines from the CLI runner.
final class LineBuffer: Sendable {
    private let storage = OSAllocatedUnfairLock<[String]>(initialState: [])

    var lines: [String] { storage.withLock { $0 } }
    var text: String { lines.joined(separator: "\n") }

    @Sendable func append(_ line: String) {
        storage.withLock { $0.append(line) }
    }
}

/// Records requested sleep durations instead of sleeping.
actor SleepRecorder {
    private(set) var delays: [TimeInterval] = []

    func record(_ delay: TimeInterval) {
        delays.append(delay)
    }
}

/// An `HTTPTransport` that replays scripted replies and records requests.
actor MockTransport: HTTPTransport {
    enum Reply: Sendable {
        case status(Int, body: String = "{}", headers: [String: String] = [:])
        case failure(URLError.Code)

        static let saved = Reply.status(200, body: #"{"status":"saved","id":"itm_fixture","category":"gratitude","quote":"x"}"#)
    }

    private var replies: [Reply]
    private let fallback: Reply
    private(set) var requests: [URLRequest] = []

    init(replies: [Reply] = [], fallback: Reply = .saved) {
        self.replies = replies
        self.fallback = fallback
    }

    func setReplies(_ replies: [Reply]) {
        self.replies = replies
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let reply = replies.isEmpty ? fallback : replies.removeFirst()
        switch reply {
        case .status(let code, let body, let headers):
            let response = HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: "HTTP/1.1", headerFields: headers)!
            return (Data(body.utf8), response)
        case .failure(let code):
            throw URLError(code)
        }
    }

    /// Request bodies decoded as JSON objects.
    func bodies() throws -> [[String: any Sendable]] {
        try requests.map { request in
            let object = try JSONSerialization.jsonObject(with: request.httpBody ?? Data())
            guard let dictionary = object as? [String: Any] else { return [:] }
            return dictionary.mapValues { value -> any Sendable in
                switch value {
                case let string as String: return string
                case let number as NSNumber: return number.int64Value
                default: return String(describing: value)
                }
            }
        }
    }
}

// MARK: - Synthetic chat.db

/// Builds a small `chat.db` with the same shape as the real Messages schema
/// (the `message`, `handle`, `chat` and `chat_message_join` tables and the columns
/// Witness reads). Every row is fictional. Tests never open a real chat.db.
final class SyntheticChatDatabase {
    enum Schema {
        /// Current macOS: has `date_retracted`, `date_edited`, `item_type`.
        case modern
        /// Older macOS: none of the optional columns.
        case legacy
    }

    struct Message {
        var guid: String
        var text: String?
        var attributedBody: Data?
        var handleID: Int64 = 0
        var isFromMe = false
        /// Raw `message.date`: Apple-epoch nanoseconds (or seconds for legacy rows).
        var date: Int64
        var service: String? = "iMessage"
        var associatedMessageType: Int64 = 0
        var dateRetracted: Int64 = 0
        var dateEdited: Int64 = 0
        var itemType: Int64 = 0
        var chatID: Int64?
    }

    let url: URL
    let schema: Schema
    private var handle: OpaquePointer?

    init(url: URL, schema: Schema = .modern, journalMode: String = "DELETE") throws {
        self.url = url
        self.schema = schema
        guard sqlite3_open_v2(url.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else {
            throw FixtureError.sqlite(String(cString: sqlite3_errmsg(handle)))
        }
        try execute("PRAGMA journal_mode = \(journalMode)")
        try execute("""
            CREATE TABLE handle (
                ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT,
                service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT,
                UNIQUE (id, service));
            CREATE TABLE chat (
                ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
                state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT,
                service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0,
                last_addressed_handle TEXT, display_name TEXT, group_id TEXT);
            CREATE TABLE chat_message_join (
                chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
                message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE,
                message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
            """)
        let optionalColumns = schema == .modern
            ? ", item_type INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0"
            : ""
        try execute("""
            CREATE TABLE message (
                ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT,
                replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0,
                subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0,
                type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT,
                error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER, date_delivered INTEGER,
                is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0,
                is_read INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0,
                associated_message_guid TEXT, associated_message_type INTEGER DEFAULT 0,
                balloon_bundle_id TEXT, thread_originator_guid TEXT\(optionalColumns));
            """)
    }

    deinit {
        sqlite3_close(handle)
    }

    @discardableResult
    func addHandle(_ id: String, service: String = "iMessage") throws -> Int64 {
        try insert("INSERT INTO handle (id, service, country) VALUES (?, ?, 'us')", [.text(id), .text(service)])
    }

    @discardableResult
    func addChat(style: Int64, identifier: String, service: String = "iMessage") throws -> Int64 {
        try insert(
            "INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?, ?, ?, ?)",
            [.text("\(service);\(style == 43 ? "+" : "-");\(identifier)"), .integer(style), .text(identifier), .text(service)]
        )
    }

    @discardableResult
    func addMessage(_ message: Message) throws -> Int64 {
        var columns = ["guid", "text", "attributedBody", "handle_id", "is_from_me", "date", "service", "associated_message_type"]
        var values: [Value] = [
            .text(message.guid), message.text.map(Value.text) ?? .null,
            message.attributedBody.map(Value.blob) ?? .null, .integer(message.handleID),
            .integer(message.isFromMe ? 1 : 0), .integer(message.date),
            message.service.map(Value.text) ?? .null, .integer(message.associatedMessageType),
        ]
        if schema == .modern {
            columns += ["date_retracted", "date_edited", "item_type"]
            values += [.integer(message.dateRetracted), .integer(message.dateEdited), .integer(message.itemType)]
        }
        let placeholders = Array(repeating: "?", count: columns.count).joined(separator: ", ")
        let rowID = try insert("INSERT INTO message (\(columns.joined(separator: ", "))) VALUES (\(placeholders))", values)
        if let chatID = message.chatID {
            try insert(
                "INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)",
                [.integer(chatID), .integer(rowID), .integer(message.date)]
            )
        }
        return rowID
    }

    /// `message.date` in nanoseconds for a moment `days` before `now`.
    static func appleNanoseconds(daysAgo days: Double, from now: Date = testNow) -> Int64 {
        let milliseconds = AppleTime.unixMilliseconds(now) - Int64(days * Double(dayMilliseconds))
        return AppleTime.messagesNanoseconds(fromUnixMilliseconds: milliseconds)
    }

    // MARK: - SQLite plumbing

    enum Value {
        case text(String)
        case blob(Data)
        case integer(Int64)
        case null
    }

    enum FixtureError: Error {
        case sqlite(String)
    }

    func execute(_ sql: String) throws {
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else {
            throw FixtureError.sqlite(String(cString: sqlite3_errmsg(handle)))
        }
    }

    @discardableResult
    private func insert(_ sql: String, _ values: [Value]) throws -> Int64 {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
            throw FixtureError.sqlite(String(cString: sqlite3_errmsg(handle)))
        }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            switch value {
            case .text(let text): sqlite3_bind_text(statement, index, text, -1, transient)
            case .blob(let data):
                _ = data.withUnsafeBytes { sqlite3_bind_blob(statement, index, $0.baseAddress, Int32(data.count), transient) }
            case .integer(let number): sqlite3_bind_int64(statement, index, number)
            case .null: sqlite3_bind_null(statement, index)
            }
        }
        guard sqlite3_step(statement) == SQLITE_DONE else {
            throw FixtureError.sqlite(String(cString: sqlite3_errmsg(handle)))
        }
        return sqlite3_last_insert_rowid(handle)
    }
}

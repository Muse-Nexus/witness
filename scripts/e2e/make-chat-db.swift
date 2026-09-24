// Builds a small synthetic Messages database (chat.db) for the end-to-end test.
//
//   swift scripts/e2e/make-chat-db.swift <out.db> <rows.json>
//
// rows.json: [{ "guid", "text", "handle", "fromMe"?, "tapback"?, "minutesAgo" }]
// Every message is stored the way current macOS often stores it: `text` NULL and
// the words only in `attributedBody`, an NSAttributedString archived with
// NSArchiver (a typedstream). All rows are fictional. This never touches a real
// chat.db: it only creates the file it is given, and refuses to overwrite one.
import Foundation
import SQLite3

struct Row: Decodable {
    var guid: String
    var text: String
    var handle: String
    var fromMe: Bool?
    var tapback: Bool?
    var minutesAgo: Double
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("make-chat-db: \(message)\n".utf8))
    exit(1)
}

let arguments = CommandLine.arguments
guard arguments.count == 3 else { fail("usage: make-chat-db.swift <out.db> <rows.json>") }
let outURL = URL(fileURLWithPath: arguments[1])
guard !FileManager.default.fileExists(atPath: outURL.path) else { fail("\(outURL.path) already exists") }
guard !outURL.path.contains("/Library/Messages/") else { fail("refusing to write inside a Messages folder") }
let rows: [Row]
do {
    rows = try JSONDecoder().decode([Row].self, from: Data(contentsOf: URL(fileURLWithPath: arguments[2])))
} catch {
    fail("could not read rows: \(error)")
}

/// NSArchiver is deprecated, so it is looked up at runtime (as the Swift tests do).
func attributedBody(_ text: String) -> Data {
    guard let archiver = NSClassFromString("NSArchiver") as AnyObject?,
          let result = archiver.perform(NSSelectorFromString("archivedDataWithRootObject:"), with: NSMutableAttributedString(string: text)),
          let data = result.takeUnretainedValue() as? Data
    else { fail("NSArchiver is not available") }
    return data
}

var db: OpaquePointer?
guard sqlite3_open_v2(outURL.path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else { fail("cannot create database") }
defer { sqlite3_close(db) }

func exec(_ sql: String) {
    guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { fail(String(cString: sqlite3_errmsg(db))) }
}

// The columns Witness for Mac reads, in the shape of the current macOS schema.
exec("""
    PRAGMA journal_mode = DELETE;
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT,
        service TEXT NOT NULL, uncanonicalized_id TEXT, person_centric_id TEXT, UNIQUE (id, service));
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER,
        state INTEGER, account_id TEXT, properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT,
        account_login TEXT, is_archived INTEGER DEFAULT 0, last_addressed_handle TEXT, display_name TEXT, group_id TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE,
        message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0,
        PRIMARY KEY (chat_id, message_id));
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, text TEXT,
        replace INTEGER DEFAULT 0, service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT,
        attributedBody BLOB, version INTEGER DEFAULT 0, type INTEGER DEFAULT 0, service TEXT, account TEXT,
        account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER, date_read INTEGER, date_delivered INTEGER,
        is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0,
        is_read INTEGER DEFAULT 0, cache_has_attachments INTEGER DEFAULT 0, associated_message_guid TEXT,
        associated_message_type INTEGER DEFAULT 0, balloon_bundle_id TEXT, thread_originator_guid TEXT,
        item_type INTEGER DEFAULT 0, date_retracted INTEGER DEFAULT 0, date_edited INTEGER DEFAULT 0);
    """)

let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

@discardableResult
func insert(_ sql: String, _ bind: (OpaquePointer?) -> Void) -> Int64 {
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { fail(String(cString: sqlite3_errmsg(db))) }
    defer { sqlite3_finalize(statement) }
    bind(statement)
    guard sqlite3_step(statement) == SQLITE_DONE else { fail(String(cString: sqlite3_errmsg(db))) }
    return sqlite3_last_insert_rowid(db)
}

var handles: [String: Int64] = [:]
var chats: [String: Int64] = [:]
func handleID(_ id: String) -> Int64 {
    if let existing = handles[id] { return existing }
    let rowID = insert("INSERT INTO handle (id, service, country) VALUES (?, 'iMessage', 'us')") { sqlite3_bind_text($0, 1, id, -1, transient) }
    handles[id] = rowID
    return rowID
}
func chatID(_ id: String) -> Int64 {
    if let existing = chats[id] { return existing }
    let rowID = insert("INSERT INTO chat (guid, style, chat_identifier, service_name) VALUES (?, 45, ?, 'iMessage')") {
        sqlite3_bind_text($0, 1, "iMessage;-;\(id)", -1, transient)
        sqlite3_bind_text($0, 2, id, -1, transient)
    }
    chats[id] = rowID
    return rowID
}

// Messages dates: nanoseconds since 2001-01-01 UTC.
let appleEpoch = Date(timeIntervalSinceReferenceDate: 0).timeIntervalSince1970
for row in rows {
    let seconds = Date().timeIntervalSince1970 - row.minutesAgo * 60 - appleEpoch
    let date = Int64(seconds * 1_000_000_000)
    let handle = handleID(row.handle)
    let body = attributedBody(row.text)
    let messageID = insert("""
        INSERT INTO message (guid, text, attributedBody, handle_id, is_from_me, date, service, associated_message_type)
        VALUES (?, NULL, ?, ?, ?, ?, 'iMessage', ?)
        """) { statement in
        sqlite3_bind_text(statement, 1, row.guid, -1, transient)
        _ = body.withUnsafeBytes { sqlite3_bind_blob(statement, 2, $0.baseAddress, Int32(body.count), transient) }
        sqlite3_bind_int64(statement, 3, handle)
        sqlite3_bind_int64(statement, 4, row.fromMe == true ? 1 : 0)
        sqlite3_bind_int64(statement, 5, date)
        sqlite3_bind_int64(statement, 6, row.tapback == true ? 2000 : 0)
    }
    let chat = chatID(row.handle)
    insert("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)") {
        sqlite3_bind_int64($0, 1, chat)
        sqlite3_bind_int64($0, 2, messageID)
        sqlite3_bind_int64($0, 3, date)
    }
}
print("make-chat-db: wrote \(rows.count) synthetic messages to \(outURL.lastPathComponent)")

import Foundation

public enum ThreadKind: String, Codable, Sendable {
    case direct
    case group
}

/// The service a message arrived over, used as the capture `sourceLabel`.
public enum MessageService: Equatable, Sendable {
    case iMessage
    case sms
    case rcs
    case other

    init(column value: String?) {
        let normalized = value?.lowercased() ?? ""
        if normalized.hasPrefix("imessage") {
            self = .iMessage
        } else if normalized.hasPrefix("sms") {
            self = .sms
        } else if normalized.hasPrefix("rcs") {
            self = .rcs
        } else {
            self = .other
        }
    }

    public var sourceLabel: String {
        switch self {
        case .iMessage: "iMessage"
        case .sms: "SMS"
        case .rcs: "RCS"
        case .other: "Messages"
        }
    }
}

/// A message someone else sent, with its body already resolved to plain text.
public struct IncomingMessage: Equatable, Sendable {
    public var rowID: Int64
    public var guid: String
    public var text: String
    /// Phone number or email address of the sender, as Messages stores it.
    public var handle: String?
    public var service: MessageService
    /// Unix milliseconds, or `nil` when Messages has no date.
    public var occurredAt: Int64?
    public var threadKind: ThreadKind?
    /// Unix milliseconds of the last edit, when the message was edited.
    public var editedAt: Int64?
}

/// Why a row was passed over without being considered at all.
public enum MessageSkipReason: String, CaseIterable, Sendable {
    case fromMe
    case tapback
    case retracted
    case notAMessage
    case empty
}

public enum MessageRow: Equatable, Sendable {
    case incoming(IncomingMessage)
    case skipped(rowID: Int64, reason: MessageSkipReason)

    public var rowID: Int64 {
        switch self {
        case .incoming(let message): message.rowID
        case .skipped(let rowID, _): rowID
        }
    }
}

public enum MessagesDatabaseError: Error, Equatable, CustomStringConvertible {
    case unsupportedSchema(missing: String)

    public var description: String {
        switch self {
        case .unsupportedSchema(let missing):
            "This Messages database does not look like one Witness can read (missing \(missing))."
        }
    }
}

/// Reads incoming messages from the Messages database (`~/Library/Messages/chat.db`).
///
/// The database belongs to Messages, so it is opened strictly read-only. Rows are
/// returned in `ROWID` order after a cursor so a caller can resume where it left off.
/// Optional columns that only exist on some macOS versions are detected with
/// `PRAGMA table_info` and read only when present.
public final class MessagesDatabase {
    public static var defaultURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Messages/chat.db")
    }

    /// Tapback reactions ("Loved", "Liked", ...) and their removals, including emoji tapbacks.
    static let tapbackTypes: ClosedRange<Int64> = 2000...3006
    /// Messages leaves U+FFFC in the body where an attachment sits.
    static let attachmentPlaceholder: Character = "\u{FFFC}"

    /// Standardized file path of the open database.
    public let path: String
    private let sqlite: ReadOnlySQLite
    private let messageColumns: Set<String>

    public init(url: URL = MessagesDatabase.defaultURL) throws {
        path = url.standardizedFileURL.path
        sqlite = try ReadOnlySQLite(path: path)
        messageColumns = try sqlite.columnNames(ofTable: "message")

        for column in ["guid", "text", "is_from_me", "date", "handle_id"] where !messageColumns.contains(column) {
            throw MessagesDatabaseError.unsupportedSchema(missing: "message.\(column)")
        }
        let requiredElsewhere: [(table: String, columns: [String])] = [
            ("handle", ["id"]), ("chat", ["style"]), ("chat_message_join", ["chat_id", "message_id"]),
        ]
        for (table, columns) in requiredElsewhere {
            let present = try sqlite.columnNames(ofTable: table)
            if let missing = columns.first(where: { !present.contains($0) }) {
                throw MessagesDatabaseError.unsupportedSchema(missing: "\(table).\(missing)")
            }
        }
    }

    /// The highest `ROWID` in `message`, or 0 for an empty database.
    public func maxRowID() throws -> Int64 {
        var value: Int64 = 0
        try sqlite.forEachRow("SELECT IFNULL(MAX(ROWID), 0) FROM message") { row in
            value = row.int64(0)
        }
        return value
    }

    /// The lowest `ROWID` of a message dated at or after `unixMilliseconds`, if any.
    /// Handles both nanosecond and legacy seconds `date` values.
    public func firstRowID(onOrAfter unixMilliseconds: Int64) throws -> Int64? {
        var value: Int64?
        let sql = """
            SELECT MIN(ROWID) FROM message
            WHERE (date > ?1 AND date >= ?2)
               OR (date > 0 AND date <= ?1 AND date >= ?3)
            """
        try sqlite.forEachRow(sql, bind: [
            AppleTime.nanosecondThreshold,
            AppleTime.messagesNanoseconds(fromUnixMilliseconds: unixMilliseconds),
            AppleTime.messagesSeconds(fromUnixMilliseconds: unixMilliseconds),
        ]) { row in
            value = row.optionalInt64(0)
        }
        return value
    }

    /// Up to `limit` rows with `ROWID > cursor`, in `ROWID` order. Every row is
    /// returned, either as an incoming message or with the reason it was skipped, so
    /// the caller can advance its cursor past all of them.
    public func rows(after cursor: Int64, limit: Int) throws -> [MessageRow] {
        var result: [MessageRow] = []
        try sqlite.forEachRow(batchQuery, bind: [cursor, Int64(max(limit, 1))]) { row in
            result.append(Self.classify(row))
        }
        return result
    }

    // Column positions in `batchQuery`.
    private enum Column {
        static let rowID: Int32 = 0
        static let guid: Int32 = 1
        static let text: Int32 = 2
        static let attributedBody: Int32 = 3
        static let isFromMe: Int32 = 4
        static let date: Int32 = 5
        static let associatedType: Int32 = 6
        static let service: Int32 = 7
        static let dateRetracted: Int32 = 8
        static let dateEdited: Int32 = 9
        static let itemType: Int32 = 10
        static let handle: Int32 = 11
        static let chatStyle: Int32 = 12
    }

    private var batchQuery: String {
        // Column names come from the fixed list below, never from input; a missing
        // optional column is replaced by a constant so positions stay stable.
        func optional(_ column: String, fallback: String) -> String {
            messageColumns.contains(column) ? "m.\(column)" : fallback
        }
        return """
            SELECT m.ROWID, m.guid, m.text,
                   \(optional("attributedBody", fallback: "NULL")),
                   m.is_from_me, m.date,
                   \(optional("associated_message_type", fallback: "0")),
                   \(optional("service", fallback: "NULL")),
                   \(optional("date_retracted", fallback: "0")),
                   \(optional("date_edited", fallback: "0")),
                   \(optional("item_type", fallback: "0")),
                   h.id,
                   (SELECT c.style FROM chat_message_join AS j
                      JOIN chat AS c ON c.ROWID = j.chat_id
                     WHERE j.message_id = m.ROWID
                     ORDER BY j.chat_id LIMIT 1)
            FROM message AS m
            LEFT JOIN handle AS h ON h.ROWID = m.handle_id
            WHERE m.ROWID > ?1
            ORDER BY m.ROWID
            LIMIT ?2
            """
    }

    private static func classify(_ row: SQLiteRow) -> MessageRow {
        let rowID = row.int64(Column.rowID)

        if row.int64(Column.isFromMe) != 0 {
            return .skipped(rowID: rowID, reason: .fromMe)
        }
        if tapbackTypes.contains(row.int64(Column.associatedType)) {
            return .skipped(rowID: rowID, reason: .tapback)
        }
        if row.int64(Column.dateRetracted) > 0 {
            return .skipped(rowID: rowID, reason: .retracted)
        }
        // Non-zero item types are group events (renames, members joining), not messages.
        if row.int64(Column.itemType) != 0 {
            return .skipped(rowID: rowID, reason: .notAMessage)
        }

        let text = resolveText(column: row.string(Column.text), attributedBody: row.data(Column.attributedBody))
        guard let text, let guid = row.string(Column.guid) else {
            return .skipped(rowID: rowID, reason: .empty)
        }

        let threadKind: ThreadKind? = switch row.optionalInt64(Column.chatStyle) {
        case 43: .group
        case 45: .direct
        default: nil
        }

        return .incoming(IncomingMessage(
            rowID: rowID,
            guid: guid,
            text: text,
            handle: row.string(Column.handle).flatMap { $0.isEmpty ? nil : $0 },
            service: MessageService(column: row.string(Column.service)),
            occurredAt: AppleTime.unixMilliseconds(fromMessagesDate: row.int64(Column.date)),
            threadKind: threadKind,
            editedAt: AppleTime.unixMilliseconds(fromMessagesDate: row.int64(Column.dateEdited))
        ))
    }

    /// Prefers the `text` column; falls back to decoding `attributedBody`.
    /// Returns `nil` when neither holds any words.
    static func resolveText(column: String?, attributedBody: Data?) -> String? {
        if let text = cleaned(column) { return text }
        guard let attributedBody else { return nil }
        return cleaned(TypedStreamText.decode(attributedBody))
    }

    /// Removes attachment placeholders and surrounding whitespace, never the words themselves.
    static func cleaned(_ text: String?) -> String? {
        guard let text else { return nil }
        let trimmed = text
            .filter { $0 != attachmentPlaceholder }
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

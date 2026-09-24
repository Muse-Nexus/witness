import CSQLite
import Foundation

public enum SQLiteError: Error, Equatable, CustomStringConvertible {
    case open(code: Int32, message: String)
    case prepare(code: Int32, message: String)
    case step(code: Int32, message: String)

    public var description: String {
        switch self {
        case .open(let code, let message): "SQLite could not open the database (\(code)): \(message)"
        case .prepare(let code, let message): "SQLite could not prepare a query (\(code)): \(message)"
        case .step(let code, let message): "SQLite could not read a row (\(code)): \(message)"
        }
    }
}

/// A read-only SQLite connection.
///
/// Witness never writes to another app's database. The connection is opened with
/// a `mode=ro` URI and `SQLITE_OPEN_READONLY`, and `query_only` is switched on, so
/// even a mistaken statement cannot modify `chat.db`. Only integer parameters can
/// be bound, which is all the Messages queries need.
final class ReadOnlySQLite {
    private let handle: OpaquePointer

    init(path: String, busyTimeoutMilliseconds: Int32 = 2_000) throws {
        var connection: OpaquePointer?
        let flags = SQLITE_OPEN_READONLY | SQLITE_OPEN_URI | SQLITE_OPEN_NOMUTEX
        let code = sqlite3_open_v2(Self.readOnlyURI(forPath: path), &connection, flags, nil)
        guard code == SQLITE_OK, let connection else {
            let message = connection.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown error"
            sqlite3_close(connection)
            throw SQLiteError.open(code: code, message: message)
        }
        handle = connection
        sqlite3_busy_timeout(connection, busyTimeoutMilliseconds)
        do {
            try forEachRow("PRAGMA query_only = 1") { _ in }
        } catch {
            sqlite3_close(connection)
            throw error
        }
    }

    deinit {
        sqlite3_close(handle)
    }

    /// `file:` URI with `mode=ro`. `URL` percent-encodes spaces, `?` and `#` in the
    /// path so they cannot be mistaken for URI syntax.
    static func readOnlyURI(forPath path: String) -> String {
        URL(fileURLWithPath: path).absoluteString + "?mode=ro"
    }

    func forEachRow(_ sql: String, bind parameters: [Int64] = [], _ body: (SQLiteRow) throws -> Void) throws {
        var statement: OpaquePointer?
        let prepared = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard prepared == SQLITE_OK, let statement else {
            throw SQLiteError.prepare(code: prepared, message: lastErrorMessage)
        }
        defer { sqlite3_finalize(statement) }

        for (index, value) in parameters.enumerated() {
            let bound = sqlite3_bind_int64(statement, Int32(index + 1), value)
            guard bound == SQLITE_OK else { throw SQLiteError.prepare(code: bound, message: lastErrorMessage) }
        }

        while true {
            let result = sqlite3_step(statement)
            switch result {
            case SQLITE_ROW:
                try body(SQLiteRow(statement: statement))
            case SQLITE_DONE:
                return
            default:
                throw SQLiteError.step(code: result, message: lastErrorMessage)
            }
        }
    }

    func columnNames(ofTable table: String) throws -> Set<String> {
        // `table` only ever comes from fixed names in this module, never from input.
        var names: Set<String> = []
        try forEachRow("PRAGMA table_info(\(table))") { row in
            if let name = row.string(1) { names.insert(name) }
        }
        return names
    }

    private var lastErrorMessage: String {
        String(cString: sqlite3_errmsg(handle))
    }
}

/// A view of the current row. Only valid inside the `forEachRow` callback.
struct SQLiteRow {
    fileprivate let statement: OpaquePointer

    func isNull(_ column: Int32) -> Bool {
        sqlite3_column_type(statement, column) == SQLITE_NULL
    }

    func int64(_ column: Int32) -> Int64 {
        sqlite3_column_int64(statement, column)
    }

    func optionalInt64(_ column: Int32) -> Int64? {
        isNull(column) ? nil : int64(column)
    }

    func string(_ column: Int32) -> String? {
        // sqlite3_column_text must run before sqlite3_column_bytes for the count to be correct.
        guard let text = sqlite3_column_text(statement, column) else { return nil }
        let count = Int(sqlite3_column_bytes(statement, column))
        return String(decoding: UnsafeBufferPointer(start: text, count: count), as: UTF8.self)
    }

    func data(_ column: Int32) -> Data? {
        guard let blob = sqlite3_column_blob(statement, column) else { return nil }
        let count = Int(sqlite3_column_bytes(statement, column))
        return Data(bytes: blob, count: count)
    }
}

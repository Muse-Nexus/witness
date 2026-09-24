import Foundation

/// Where scanning resumes. Contains row numbers and times only, never message content.
public struct CursorState: Codable, Equatable, Sendable {
    public static let currentVersion = 1

    public var version: Int
    /// The highest `message.ROWID` already considered.
    public var lastRowID: Int64
    /// Unix milliseconds. Messages dated earlier are never sent, even if they
    /// appear later with a higher `ROWID` (for example when Messages in iCloud
    /// downloads old history).
    public var notBefore: Int64
    /// Unix milliseconds of the last save.
    public var updatedAt: Int64
    /// The database this cursor belongs to. Row numbers mean nothing in another one.
    public var databasePath: String?

    public init(lastRowID: Int64, notBefore: Int64, updatedAt: Int64, databasePath: String? = nil) {
        version = Self.currentVersion
        self.lastRowID = lastRowID
        self.notBefore = notBefore
        self.updatedAt = updatedAt
        self.databasePath = databasePath
    }
}

/// Persists the cursor as JSON, written atomically.
public struct CursorStore: Sendable {
    public static let defaultLookbackDays = 30

    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    /// The saved cursor, or `nil` before the first scan.
    public func load() throws -> CursorState? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        return try JSONDecoder().decode(CursorState.self, from: Data(contentsOf: fileURL))
    }

    public func save(_ state: CursorState) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try AtomicFile.write(encoder.encode(state), to: fileURL)
    }

    /// The cursor for a first run: just before the first message inside the
    /// lookback window, so recent messages are considered but a lifetime of
    /// history is not uploaded. If nothing is that recent, start at the newest row.
    public static func initialState(
        database: MessagesDatabase,
        now: Date,
        lookbackDays: Int = defaultLookbackDays
    ) throws -> CursorState {
        let nowMilliseconds = AppleTime.unixMilliseconds(now)
        let notBefore = nowMilliseconds - Int64(max(lookbackDays, 0)) * 86_400_000
        let lastRowID: Int64
        if let first = try database.firstRowID(onOrAfter: notBefore) {
            lastRowID = first - 1
        } else {
            lastRowID = try database.maxRowID()
        }
        return CursorState(
            lastRowID: lastRowID,
            notBefore: notBefore,
            updatedAt: nowMilliseconds,
            databasePath: database.path
        )
    }
}

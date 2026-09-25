import Foundation

/// Where scanning resumes. Contains row numbers and times only, never message content.
///
/// Two kinds of progress live here:
/// - The live cursor (`lastRowID`, `notBefore`): every new message, in `ROWID` order. It is
///   set on the first scan and only ever moves forward. `notBefore` moves forward too when
///   the person chooses a shorter time than before, so the rest of a first scan still being
///   sent a few at a time stops at the new choice.
/// - Older messages (`coveredSince`, `olderWindows`): when the person later chooses to look
///   further back than the first scan did, only the older stretch not yet looked at is read,
///   a few messages at a time, with its own cursor. The live cursor's place is not touched,
///   so nothing already read is read or sent again.
public struct CursorState: Codable, Equatable, Sendable {
    public static let currentVersion = 2

    public var version: Int
    /// The highest `message.ROWID` already considered by the live scan.
    public var lastRowID: Int64
    /// Unix milliseconds. The live scan never sends a message dated earlier, even if it
    /// appears later with a higher `ROWID` (for example when Messages in iCloud downloads
    /// old history).
    public var notBefore: Int64
    /// Unix milliseconds of the last save.
    public var updatedAt: Int64
    /// The database this cursor belongs to. Row numbers mean nothing in another one.
    public var databasePath: String?
    /// How far back the person last chose to look, so a scan that is not given a choice (the
    /// CLI without `--lookback`) goes on with it. Nil for a cursor from before 0.2.0.
    public var lookback: Lookback?
    /// Unix milliseconds. Every message dated from here up to `notBefore` that was on this Mac
    /// when it was looked through has been looked at. Nil until the range is first widened.
    public var coveredSince: Int64?
    /// Older stretches still to look through, newest first. The first one ends where
    /// `coveredSince` (or `notBefore`) begins, and each one ends where the next begins.
    public var olderWindows: [OlderWindow]

    public init(
        lastRowID: Int64,
        notBefore: Int64,
        updatedAt: Int64,
        databasePath: String? = nil,
        lookback: Lookback? = nil,
        coveredSince: Int64? = nil,
        olderWindows: [OlderWindow] = []
    ) {
        version = Self.currentVersion
        self.lastRowID = lastRowID
        self.notBefore = notBefore
        self.updatedAt = updatedAt
        self.databasePath = databasePath
        self.lookback = lookback
        self.coveredSince = coveredSince
        self.olderWindows = olderWindows
    }

    /// A version 1 file (no lookback, no older windows) still loads.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = Self.currentVersion
        lastRowID = try container.decode(Int64.self, forKey: .lastRowID)
        notBefore = try container.decode(Int64.self, forKey: .notBefore)
        updatedAt = try container.decodeIfPresent(Int64.self, forKey: .updatedAt) ?? 0
        databasePath = try container.decodeIfPresent(String.self, forKey: .databasePath)
        lookback = try? container.decodeIfPresent(Lookback.self, forKey: .lookback)
        coveredSince = try container.decodeIfPresent(Int64.self, forKey: .coveredSince)
        olderWindows = try container.decodeIfPresent([OlderWindow].self, forKey: .olderWindows) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case version, lastRowID, notBefore, updatedAt, databasePath, lookback, coveredSince, olderWindows
    }

    /// The oldest time looked at, or planned to be: where a newly widened range would start.
    var reach: Int64 {
        olderWindows.last?.since ?? coveredSince ?? notBefore
    }

    /// Brings the older windows in line with `lookback`, chosen at `now` (Unix milliseconds).
    ///
    /// - Looking further back than before adds a window for the older stretch only, up to the
    ///   newest message now on this Mac (`newestRowID`). Newer messages stay with the live scan.
    /// - A shorter choice sets windows aside without losing their progress, splitting one it
    ///   cuts through, so choosing a longer time again carries on where it stopped.
    /// - A shorter choice than before also moves `notBefore` up to it, so the live scan sends
    ///   nothing older from then on. What the live scan has not read yet in the stretch below
    ///   is set aside as a window of its own, from the live scan's place.
    /// - A new choice counts back from `now`, for every window. The same choice made again
    ///   keeps counting from when each window was opened, so time passing splits nothing.
    public mutating func planOlderWindows(for lookback: Lookback, newestRowID: Int64, now: Int64) {
        let previous = self.lookback
        self.lookback = lookback
        let floor = lookback.floor(atUnixMilliseconds: now)

        if previous != lookback {
            for index in olderWindows.indices { olderWindows[index].openedAt = now }
        }
        if let previous, lookback.isShorter(than: previous), floor > notBefore {
            // Rows after `lastRowID`, up to the newest now, dated below the new choice: the rest
            // of a first scan not sent yet, and any older ones that arrived late (Messages in
            // iCloud brings history down with new row numbers). This can read again a row an
            // older window already sent while the live scan waited on a new text; the server
            // keeps one item per message id, so that costs a request, never a second item, and
            // is better than marking a stretch done that holds rows nobody has read.
            let setAside = OlderWindow(
                since: coveredSince ?? notBefore, before: floor,
                throughRowID: newestRowID, lastRowID: lastRowID, openedAt: now
            )
            olderWindows.insert(setAside, at: 0)
            coveredSince = nil
            notBefore = floor
        }

        var windows: [OlderWindow] = []
        for window in olderWindows {
            let cut = window.floor(for: lookback)
            if cut > window.since, cut < window.before {
                var wanted = window
                wanted.since = cut
                var setAside = window
                setAside.before = cut
                windows += [wanted, setAside]
            } else {
                windows.append(window)
            }
        }

        // Join neighbours that were split earlier and are both wanted again.
        var joined: [OlderWindow] = []
        for window in windows {
            if let last = joined.last, last.since == window.before, last.hasSameProgress(as: window),
               last.isWanted(by: lookback), window.isWanted(by: lookback) {
                joined[joined.count - 1].since = window.since
            } else {
                joined.append(window)
            }
        }
        olderWindows = joined

        if floor < reach {
            olderWindows.append(OlderWindow(since: floor, before: reach, throughRowID: newestRowID, lastRowID: 0, openedAt: now))
        }
    }

    /// The newest older window, when `lookback` wants it looked through now.
    func olderWindowToCheck(for lookback: Lookback?) -> OlderWindow? {
        guard let lookback, let window = olderWindows.first, window.isWanted(by: lookback) else { return nil }
        return window
    }

    /// The newest older window has been looked through to its end.
    mutating func finishNewestOlderWindow() {
        guard !olderWindows.isEmpty else { return }
        coveredSince = olderWindows.removeFirst().since
    }
}

/// An older stretch of Messages to look through once, after the range was widened.
public struct OlderWindow: Codable, Equatable, Sendable {
    /// Unix milliseconds: messages dated from here (0 for everything)...
    public var since: Int64
    /// ...up to, and not including, this time.
    public var before: Int64
    /// The newest message on this Mac when the window was opened. Messages that arrive later
    /// belong to the live scan, which never sends one dated before `notBefore`.
    public var throughRowID: Int64
    /// The highest `ROWID` already looked at in this window.
    public var lastRowID: Int64
    /// Unix milliseconds. "The last year" is counted back from here, so a window being looked
    /// through does not shrink a little every day. Moved to the time of each new choice, so a
    /// window set aside and wanted again later counts back from then, not from when it opened.
    public var openedAt: Int64

    public init(since: Int64, before: Int64, throughRowID: Int64, lastRowID: Int64, openedAt: Int64) {
        self.since = since
        self.before = before
        self.throughRowID = throughRowID
        self.lastRowID = lastRowID
        self.openedAt = openedAt
    }

    /// Where `lookback` starts, counted back from when this window was opened.
    func floor(for lookback: Lookback) -> Int64 {
        lookback.floor(atUnixMilliseconds: openedAt)
    }

    /// The whole window is inside `lookback`.
    func isWanted(by lookback: Lookback) -> Bool {
        floor(for: lookback) <= since
    }

    func hasSameProgress(as other: OlderWindow) -> Bool {
        throughRowID == other.throughRowID && lastRowID == other.lastRowID && openedAt == other.openedAt
    }
}

/// Persists the cursor as JSON, written atomically.
public struct CursorStore: Sendable {
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

    /// The cursor for a first run: just before the first message inside the lookback, so
    /// the messages in it are considered and older ones are not. If nothing is that recent,
    /// start at the newest row.
    public static func initialState(
        database: MessagesDatabase,
        now: Date,
        lookback: Lookback = .default
    ) throws -> CursorState {
        let nowMilliseconds = AppleTime.unixMilliseconds(now)
        let notBefore = lookback.floor(atUnixMilliseconds: nowMilliseconds)
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
            databasePath: database.path,
            lookback: lookback
        )
    }
}

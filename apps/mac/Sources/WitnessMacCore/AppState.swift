import Foundation

/// Why Witness for Mac stopped checking.
public enum PauseReason: String, Codable, Equatable, Sendable {
    /// The person chose Pause.
    case byPerson
    /// Witness did not accept the key (401 or 403), for example because it was revoked.
    case keyRefused
    /// macOS no longer lets Witness read Messages (Full Disk Access was turned off).
    case fullDiskAccess
}

public struct PauseState: Codable, Equatable, Sendable {
    public var reason: PauseReason
    /// Unix milliseconds.
    public var since: Int64

    public init(reason: PauseReason, since: Int64) {
        self.reason = reason
        self.since = since
    }
}

/// The menu-bar app's own settings, in `app-state.json` next to `config.json`. Holds no
/// message content, no names and no key: the server address stays in `config.json` and
/// the key in the Keychain, shared with `witness-mac`.
public struct AppState: Codable, Equatable, Sendable {
    public static let currentVersion = 1
    /// Choices offered for the first check. 30 days is the default.
    public static let lookbackChoices = [7, 30, 90]

    public var version: Int
    /// `nil` while Witness is checking.
    public var pause: PauseState?
    public var setup: SetupProgress
    /// Look up senders' names in Contacts. Only takes effect while Contacts access is allowed.
    public var namesEnabled: Bool
    /// How far back the first check looks.
    public var lookbackDays: Int

    public init(
        pause: PauseState? = nil,
        setup: SetupProgress = SetupProgress(),
        namesEnabled: Bool = false,
        lookbackDays: Int = CursorStore.defaultLookbackDays
    ) {
        version = Self.currentVersion
        self.pause = pause
        self.setup = setup
        self.namesEnabled = namesEnabled
        self.lookbackDays = lookbackDays
    }

    public var isPaused: Bool { pause != nil }

    /// Every field is optional on disk, so a file from an older or newer version still loads.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? Self.currentVersion
        pause = try? container.decodeIfPresent(PauseState.self, forKey: .pause)
        setup = (try? container.decodeIfPresent(SetupProgress.self, forKey: .setup)) ?? SetupProgress()
        namesEnabled = (try? container.decodeIfPresent(Bool.self, forKey: .namesEnabled)) ?? false
        let days = (try? container.decodeIfPresent(Int.self, forKey: .lookbackDays)) ?? CursorStore.defaultLookbackDays
        lookbackDays = (0...3650).contains(days) ? days : CursorStore.defaultLookbackDays
    }

    private enum CodingKeys: String, CodingKey {
        case version, pause, setup, namesEnabled, lookbackDays
    }
}

/// Reads and writes `app-state.json` atomically, with private permissions.
public struct AppStateStore: Sendable {
    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    /// The saved state, or the defaults when there is none yet or it cannot be read.
    public func load() -> AppState {
        guard let data = try? Data(contentsOf: fileURL),
              let state = try? JSONDecoder().decode(AppState.self, from: data)
        else { return AppState() }
        return state
    }

    public func save(_ state: AppState) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try AtomicFile.write(encoder.encode(state), to: fileURL)
    }
}

/// When checks happened and how many messages Witness accepted, in `activity.json`.
/// Times and counts only: never message text, senders or names.
public struct ActivityLog: Codable, Equatable, Sendable {
    public static let currentVersion = 1
    /// Long enough for "this week" in any calendar.
    static let keepMilliseconds: Int64 = 8 * 86_400_000
    static let maximumEntries = 10_000

    public var version: Int
    /// Unix milliseconds of the last check that reached Messages.
    public var lastCheckAt: Int64?
    /// Unix milliseconds, one entry per message Witness accepted.
    public var sentAt: [Int64]

    public init(lastCheckAt: Int64? = nil, sentAt: [Int64] = []) {
        version = Self.currentVersion
        self.lastCheckAt = lastCheckAt
        self.sentAt = sentAt
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decodeIfPresent(Int.self, forKey: .version) ?? Self.currentVersion
        lastCheckAt = try? container.decodeIfPresent(Int64.self, forKey: .lastCheckAt)
        sentAt = (try? container.decodeIfPresent([Int64].self, forKey: .sentAt)) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case version, lastCheckAt, sentAt
    }

    public var lastCheck: Date? {
        lastCheckAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1_000) }
    }

    /// Records a check, and `sent` messages accepted in it, and forgets anything older than a week and a day.
    public mutating func recordCheck(sent: Int, at date: Date) {
        let now = AppleTime.unixMilliseconds(date)
        lastCheckAt = now
        if sent > 0 { sentAt.append(contentsOf: repeatElement(now, count: sent)) }
        sentAt.removeAll { $0 < now - Self.keepMilliseconds }
        if sentAt.count > Self.maximumEntries { sentAt.removeFirst(sentAt.count - Self.maximumEntries) }
    }

    /// Messages accepted since the start of today.
    public func sentToday(now: Date, calendar: Calendar) -> Int {
        count(since: calendar.startOfDay(for: now), now: now)
    }

    /// Messages accepted since the start of this week, as the calendar counts weeks.
    public func sentThisWeek(now: Date, calendar: Calendar) -> Int {
        let start = calendar.dateInterval(of: .weekOfYear, for: now)?.start ?? calendar.startOfDay(for: now)
        return count(since: start, now: now)
    }

    private func count(since start: Date, now: Date) -> Int {
        let from = AppleTime.unixMilliseconds(start)
        let to = AppleTime.unixMilliseconds(now)
        return sentAt.lazy.filter { $0 >= from && $0 <= to }.count
    }
}

public struct ActivityStore: Sendable {
    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public func load() -> ActivityLog {
        guard let data = try? Data(contentsOf: fileURL),
              let log = try? JSONDecoder().decode(ActivityLog.self, from: data)
        else { return ActivityLog() }
        return log
    }

    public func save(_ log: ActivityLog) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try AtomicFile.write(encoder.encode(log), to: fileURL)
    }
}

extension WitnessPaths {
    public var appStateFile: URL { supportDirectory.appendingPathComponent("app-state.json") }
    public var activityFile: URL { supportDirectory.appendingPathComponent("activity.json") }
}

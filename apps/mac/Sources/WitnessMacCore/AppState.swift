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
        // Only the choices setup offers: an edited file cannot reach years into the past.
        lookbackDays = Self.lookbackChoices.contains(days) ? days : CursorStore.defaultLookbackDays
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

/// When Witness last checked Messages, in `activity.json`. A time only: never message
/// text, senders or names, and no tally of what was sent, so the app never shows a
/// number that could read as a verdict on a week.
public struct ActivityLog: Codable, Equatable, Sendable {
    public static let currentVersion = 2

    public var version: Int
    /// Unix milliseconds of the last check that reached Messages.
    public var lastCheckAt: Int64?

    public init(lastCheckAt: Int64? = nil) {
        version = Self.currentVersion
        self.lastCheckAt = lastCheckAt
    }

    /// Fields from an older file (version 1 also kept the times of sends) are ignored.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = Self.currentVersion
        lastCheckAt = try? container.decodeIfPresent(Int64.self, forKey: .lastCheckAt)
    }

    private enum CodingKeys: String, CodingKey {
        case version, lastCheckAt
    }

    public var lastCheck: Date? {
        lastCheckAt.map { Date(timeIntervalSince1970: TimeInterval($0) / 1_000) }
    }

    public mutating func recordCheck(at date: Date) {
        lastCheckAt = AppleTime.unixMilliseconds(date)
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

import Foundation
import os

/// What the menu-bar app shows. Counts and states only: never message text, senders or names.
public struct EngineStatus: Equatable, Sendable {
    public enum Connection: Equatable, Sendable {
        /// No address or no key yet.
        case notSetUp
        /// Set up, not checked since the app started.
        case notCheckedYet(host: String)
        case connected(host: String)
        case keyRefused(host: String)
        case unreachable(host: String)
        /// The address answered, but not like a Witness.
        case notWitness(host: String)
    }

    public enum Activity: Equatable, Sendable {
        /// Setup has not been finished or closed yet.
        case waitingForSetup
        case watching
        case checking
        case paused(PauseReason)
    }

    public var connection: Connection
    public var fullDiskAccess: FullDiskAccessState
    public var activity: Activity
    public var lastCheck: Date?
    public var sentToday: Int
    public var sentThisWeek: Int
    /// A plain sentence about the last problem, if the last check hit one.
    public var note: String?

    public init(
        connection: Connection = .notSetUp,
        fullDiskAccess: FullDiskAccessState = .denied,
        activity: Activity = .waitingForSetup,
        lastCheck: Date? = nil,
        sentToday: Int = 0,
        sentThisWeek: Int = 0,
        note: String? = nil
    ) {
        self.connection = connection
        self.fullDiskAccess = fullDiskAccess
        self.activity = activity
        self.lastCheck = lastCheck
        self.sentToday = sentToday
        self.sentThisWeek = sentThisWeek
        self.note = note
    }

    public var pauseReason: PauseReason? {
        if case .paused(let reason) = activity { return reason }
        return nil
    }
}

/// The words the menu-bar app uses for an `EngineStatus`. Calm and plain, no exclamation marks.
public enum StatusCopy {
    public static func connection(_ connection: EngineStatus.Connection) -> String {
        switch connection {
        case .notSetUp: "Not connected yet"
        case .notCheckedYet(let host): host
        case .connected(let host): "Connected to \(host)"
        case .keyRefused: "The key was not accepted"
        case .unreachable(let host): "\(host) can’t be reached right now"
        case .notWitness(let host): "No Witness at \(host)"
        }
    }

    public static func fullDiskAccess(_ state: FullDiskAccessState) -> String {
        switch state {
        case .granted: "Allowed"
        case .denied: "Not allowed yet"
        case .missing: "No Messages on this Mac"
        case .unavailable: "Could not check"
        }
    }

    public static func activity(_ activity: EngineStatus.Activity) -> String {
        switch activity {
        case .waitingForSetup: "Finish setup to start."
        case .watching: "Watching for new messages."
        case .checking: "Checking Messages…"
        case .paused(let reason): pause(reason)
        }
    }

    public static func pause(_ reason: PauseReason) -> String {
        switch reason {
        case .byPerson:
            "Paused. Nothing is read or sent until you resume."
        case .keyRefused:
            "Paused. Witness did not accept this Mac’s key, so nothing is sent. Add a new key in Settings."
        case .fullDiskAccess:
            "Paused until Witness can read Messages. Turn on Full Disk Access in Settings."
        }
    }

    public static func lastCheck(_ date: Date?, now: Date, calendar: Calendar = .current) -> String {
        guard let date else { return "Not yet" }
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDate(date, inSameDayAs: now) { return "Today at \(time)" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "Yesterday at \(time)"
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    /// Every fixed sentence, for the copy check in the tests.
    public static var allFixedSentences: [String] {
        let connections: [EngineStatus.Connection] = [
            .notSetUp, .notCheckedYet(host: "h"), .connected(host: "h"), .keyRefused(host: "h"),
            .unreachable(host: "h"), .notWitness(host: "h"),
        ]
        let access: [FullDiskAccessState] = [.granted, .denied, .missing, .unavailable(errno: 5)]
        let activities: [EngineStatus.Activity] = [
            .waitingForSetup, .watching, .checking, .paused(.byPerson), .paused(.keyRefused), .paused(.fullDiskAccess),
        ]
        return connections.map(connection) + access.map(fullDiskAccess) + activities.map(activity)
            + EngineNote.allCases.map(\.text)
    }
}

/// Plain sentences for problems a check can run into.
public enum EngineNote: CaseIterable, Sendable {
    case noMessagesDatabase
    case noLexicon
    case unreachable
    case notWitness
    case couldNotRead

    public var text: String {
        switch self {
        case .noMessagesDatabase:
            "There is no Messages database on this Mac yet. Open Messages and sign in, and Witness will look again."
        case .noLexicon:
            "Witness is missing its word list. Download Witness for Mac again to fix it."
        case .unreachable:
            "Witness could not be reached. Nothing was skipped; it will try again."
        case .notWitness:
            "The saved address did not answer like Witness. Nothing was skipped. Check the address in Settings."
        case .couldNotRead:
            "Messages could not be read just now. Witness will try again."
        }
    }
}

/// Everything the engine touches outside itself, injectable for tests.
public struct EngineEnvironment: Sendable {
    public var paths: WitnessPaths
    public var tokenStore: any TokenStore
    public var transport: any HTTPTransport
    public var retryPolicy: RetryPolicy
    /// `lexicon.json` to use: the copy inside the app, or the source tree for a development build.
    public var lexiconURL: @Sendable () -> URL?
    public var checkFullDiskAccess: @Sendable (URL) -> FullDiskAccessState
    /// A name lookup, or nil when names are off or Contacts access is not allowed.
    public var names: @Sendable (_ enabled: Bool) -> (any ContactsResolving)?
    public var now: @Sendable () -> Date
    public var calendar: Calendar
    public var watchDebounce: TimeInterval
    public var watchSafetyInterval: TimeInterval

    public init(
        paths: WitnessPaths,
        tokenStore: any TokenStore,
        transport: any HTTPTransport,
        retryPolicy: RetryPolicy = .standard,
        lexiconURL: @escaping @Sendable () -> URL?,
        checkFullDiskAccess: @escaping @Sendable (URL) -> FullDiskAccessState = { FullDiskAccess.check(url: $0) },
        names: @escaping @Sendable (Bool) -> (any ContactsResolving)? = { _ in nil },
        now: @escaping @Sendable () -> Date = Date.init,
        calendar: Calendar = .current,
        watchDebounce: TimeInterval = 5,
        watchSafetyInterval: TimeInterval = 600
    ) {
        self.paths = paths
        self.tokenStore = tokenStore
        self.transport = transport
        self.retryPolicy = retryPolicy
        self.lexiconURL = lexiconURL
        self.checkFullDiskAccess = checkFullDiskAccess
        self.names = names
        self.now = now
        self.calendar = calendar
        self.watchDebounce = watchDebounce
        self.watchSafetyInterval = watchSafetyInterval
    }
}

/// Runs Witness for Mac in the background: watches Messages, scans with `MessageScanner`,
/// sends through `WitnessClient`, and keeps the pause state and the counts.
///
/// - A refused key (401 or 403) pauses it with `.keyRefused` until a new key is saved.
/// - Losing Full Disk Access pauses it with `.fullDiskAccess`; it resumes by itself once
///   Messages can be read again.
/// - The person's own Pause lasts until they resume, across restarts.
///
/// It never logs or publishes message text, senders or names: only counts and states.
public actor CollectorEngine {
    private static let log = Logger(subsystem: "studio.musenexus.witness.mac", category: "engine")

    private let environment: EngineEnvironment
    private let appStateStore: AppStateStore
    private let activityStore: ActivityStore
    private var appState: AppState
    private var activity: ActivityLog
    private var current: EngineStatus
    private var continuations: [UUID: AsyncStream<EngineStatus>.Continuation] = [:]

    private var started = false
    private var watcher: ChatDatabaseWatcher?
    private var loop: Task<Void, Never>?
    private var scanning = false
    private var rescanRequested = false
    private var cachedPrefilter: (url: URL, prefilter: Prefilter)?
    /// The saved server's host when an address and a key are both saved, else nil. Read on
    /// start, after a key change and at each check, so the Keychain is not read on every update.
    private var configuredHost: String?
    /// Open while not paused. Checked before every send, so Pause takes effect in the
    /// middle of a check too, not only at the next one.
    private let gate: OSAllocatedUnfairLock<Bool>

    public init(environment: EngineEnvironment) {
        self.environment = environment
        appStateStore = AppStateStore(fileURL: environment.paths.appStateFile)
        activityStore = ActivityStore(fileURL: environment.paths.activityFile)
        appState = appStateStore.load()
        activity = activityStore.load()
        gate = OSAllocatedUnfairLock(initialState: appState.pause == nil)
        configuredHost = Self.readConfiguredHost(environment)

        let now = environment.now()
        var status = EngineStatus()
        status.fullDiskAccess = environment.checkFullDiskAccess(environment.paths.messagesDatabase)
        if let host = configuredHost {
            status.connection = appState.pause?.reason == .keyRefused ? .keyRefused(host: host) : .notCheckedYet(host: host)
        }
        if let pause = appState.pause {
            status.activity = .paused(pause.reason)
        } else {
            status.activity = appState.setup.isFinished ? .watching : .waitingForSetup
        }
        status.lastCheck = activity.lastCheck
        status.sentToday = activity.sentToday(now: now, calendar: environment.calendar)
        status.sentThisWeek = activity.sentThisWeek(now: now, calendar: environment.calendar)
        current = status
    }

    // MARK: - Reading state

    public var status: EngineStatus { current }
    public var state: AppState { appState }

    /// The current status first, then every change.
    public func updates() -> AsyncStream<EngineStatus> {
        let (stream, continuation) = AsyncStream.makeStream(of: EngineStatus.self, bufferingPolicy: .bufferingNewest(1))
        let id = UUID()
        continuations[id] = continuation
        continuation.yield(current)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeContinuation(id) }
        }
        return stream
    }

    private func removeContinuation(_ id: UUID) {
        continuations[id] = nil
    }

    // MARK: - Running

    /// Starts watching Messages once setup is finished and nothing pauses it. Safe to call again.
    public func start() {
        started = true
        clearPauseIfResolved()
        refreshStatus()
        guard appState.setup.isFinished, appState.pause == nil else { return }
        startWatching()
    }

    /// Stops watching. The state on disk is kept.
    public func stop() {
        started = false
        stopWatching()
    }

    /// Checks Messages now. When paused for a reason that may have cleared (Full Disk
    /// Access back on), it looks first and resumes if it can.
    @discardableResult
    public func checkNow() async -> EngineStatus {
        clearPauseIfResolved()
        if appState.pause == nil, appState.setup.isFinished, started { startWatching() }
        await scan()
        return current
    }

    public func pause() {
        setPause(.byPerson)
    }

    /// Resumes whatever the reason, and checks right away. If the reason is still there
    /// (the key is still refused, access is still off) it pauses again with that reason.
    public func resume() async {
        guard appState.pause != nil else { return }
        applyPause(nil)
        refreshStatus()
        if started { startWatching() }
        await scan()
    }

    /// Updates the app's saved settings (setup progress, names, lookback) and applies them.
    /// Pause and resume have their own methods; a change to `pause` here is ignored.
    public func update(_ change: @Sendable (inout AppState) -> Void) async {
        let wasFinished = appState.setup.isFinished
        let pause = appState.pause
        change(&appState)
        appState.pause = pause
        saveAppState()
        refreshStatus()
        if !wasFinished, appState.setup.isFinished, started, appState.pause == nil {
            startWatching()
            await scan()
        }
    }

    /// A new address or key was saved. Clears a pause for a refused key and checks again.
    public func connectionChanged() async {
        if appState.pause?.reason == .keyRefused { applyPause(nil) }
        configuredHost = Self.readConfiguredHost(environment)
        current.connection = configuredHost.map { .notCheckedYet(host: $0) } ?? .notSetUp
        current.note = nil
        refreshStatus()
        if started, appState.setup.isFinished, appState.pause == nil {
            startWatching()
            await scan()
        }
    }

    /// Re-reads Full Disk Access for the status (cheap: one `open`). If Witness was paused
    /// because it could not read Messages and now it can, it resumes and checks.
    public func refreshFullDiskAccess() async {
        let wasPausedForAccess = appState.pause?.reason == .fullDiskAccess
        clearPauseIfResolved()
        current.fullDiskAccess = environment.checkFullDiskAccess(environment.paths.messagesDatabase)
        guard wasPausedForAccess, appState.pause == nil else {
            publish()
            return
        }
        refreshStatus()
        if started, appState.setup.isFinished { startWatching() }
        await scan()
    }

    // MARK: - Scanning

    private func scan() async {
        if let pause = appState.pause {
            current.activity = .paused(pause.reason)
            publish()
            return
        }
        guard appState.setup.isFinished else {
            current.activity = .waitingForSetup
            publish()
            return
        }
        if scanning {
            rescanRequested = true
            return
        }
        scanning = true
        current.activity = .checking
        publish()

        repeat {
            rescanRequested = false
            await scanOnce()
        } while rescanRequested && appState.pause == nil

        scanning = false
        refreshStatus()
    }

    private func scanOnce() async {
        let databaseURL = environment.paths.messagesDatabase
        let access = environment.checkFullDiskAccess(databaseURL)
        current.fullDiskAccess = access
        switch access {
        case .granted:
            break
        case .denied:
            Self.log.notice("Messages cannot be read: pausing until Full Disk Access is back")
            setPause(.fullDiskAccess)
            return
        case .missing:
            current.note = EngineNote.noMessagesDatabase.text
            return
        case .unavailable:
            current.note = EngineNote.couldNotRead.text
            return
        }

        guard let config = try? ConfigStore(fileURL: environment.paths.configFile).load(),
              let url = try? ConfigValidation.normalizedAPIURL(config.apiUrl),
              let token = (try? environment.tokenStore.readToken()) ?? nil
        else {
            configuredHost = nil
            current.connection = .notSetUp
            current.note = nil
            return
        }
        let host = url.host ?? url.absoluteString
        configuredHost = host

        guard let prefilter = loadPrefilter() else {
            current.note = EngineNote.noLexicon.text
            return
        }

        let scanner = MessageScanner(
            databaseURL: databaseURL,
            prefilter: prefilter,
            cursorStore: CursorStore(fileURL: environment.paths.cursorFile),
            sender: GatedSender(
                inner: WitnessClient(baseURL: url, token: token, transport: environment.transport, retryPolicy: environment.retryPolicy),
                gate: gate
            ),
            names: environment.names(appState.namesEnabled),
            now: environment.now
        )

        let summary: ScanSummary
        do {
            summary = try await scanner.scanOnce(options: ScanOptions(lookbackDays: appState.lookbackDays))
        } catch {
            // Access can go away between the check above and the open (EPERM).
            let recheck = environment.checkFullDiskAccess(databaseURL)
            current.fullDiskAccess = recheck
            if recheck == .denied {
                Self.log.notice("Messages cannot be read: pausing until Full Disk Access is back")
                setPause(.fullDiskAccess)
            } else {
                Self.log.error("Could not scan Messages: \(String(describing: type(of: error)), privacy: .public)")
                current.note = EngineNote.couldNotRead.text
            }
            return
        }

        activity.recordCheck(sent: summary.sent, at: environment.now())
        saveActivity()
        Self.log.info("Checked: \(summary.countsLine, privacy: .public)")
        // Paused during the check: it stopped at the next message, which is kept for later.
        guard appState.pause == nil else { return }

        if let stopped = summary.stoppedEarly {
            if stopped.isAuthorizationFailure {
                Self.log.notice("The key was refused: pausing until a new key is saved")
                current.connection = .keyRefused(host: host)
                setPause(.keyRefused)
                return
            }
            if stopped.isTransient {
                current.connection = .unreachable(host: host)
                current.note = EngineNote.unreachable.text
            } else {
                current.connection = .notWitness(host: host)
                current.note = EngineNote.notWitness.text
            }
        } else {
            current.connection = .connected(host: host)
            current.note = nil
        }

        if let retryAt = summary.retryAt { watcher?.scheduleRescan(at: retryAt) }
    }

    private func loadPrefilter() -> Prefilter? {
        guard let url = environment.lexiconURL() else { return nil }
        if let cachedPrefilter, cachedPrefilter.url == url { return cachedPrefilter.prefilter }
        guard let prefilter = try? Prefilter.load(from: url) else { return nil }
        cachedPrefilter = (url, prefilter)
        return prefilter
    }

    // MARK: - Watching

    private func startWatching() {
        guard loop == nil else { return }
        let watcher = ChatDatabaseWatcher(
            databaseURL: environment.paths.messagesDatabase,
            debounce: environment.watchDebounce,
            safetyInterval: environment.watchSafetyInterval
        )
        self.watcher = watcher
        let triggers = watcher.triggers()
        loop = Task { [weak self] in
            for await _ in triggers {
                guard let self, !Task.isCancelled else { return }
                await self.scan()
            }
        }
    }

    private func stopWatching() {
        watcher?.stop()
        watcher = nil
        loop?.cancel()
        loop = nil
    }

    // MARK: - Pause

    private func setPause(_ reason: PauseReason) {
        if appState.pause?.reason != reason {
            applyPause(PauseState(reason: reason, since: AppleTime.unixMilliseconds(environment.now())))
        }
        stopWatching()
        current.activity = .paused(reason)
        if reason != .keyRefused { current.note = nil }
        publish()
    }

    /// Lifts a pause whose cause is gone: Full Disk Access is back.
    private func clearPauseIfResolved() {
        guard let pause = appState.pause, pause.reason == .fullDiskAccess else { return }
        let access = environment.checkFullDiskAccess(environment.paths.messagesDatabase)
        current.fullDiskAccess = access
        guard access == .granted else { return }
        Self.log.notice("Messages can be read again: resuming")
        applyPause(nil)
    }

    private func applyPause(_ pause: PauseState?) {
        appState.pause = pause
        gate.withLock { $0 = pause == nil }
        saveAppState()
    }

    // MARK: - Status

    private static func readConfiguredHost(_ environment: EngineEnvironment) -> String? {
        guard let config = try? ConfigStore(fileURL: environment.paths.configFile).load(),
              let url = try? ConfigValidation.normalizedAPIURL(config.apiUrl),
              ((try? environment.tokenStore.readToken()) ?? nil) != nil
        else { return nil }
        return url.host ?? url.absoluteString
    }

    /// Recomputes the parts of the status that come from saved state, then publishes.
    private func refreshStatus() {
        let now = environment.now()
        current.lastCheck = activity.lastCheck
        current.sentToday = activity.sentToday(now: now, calendar: environment.calendar)
        current.sentThisWeek = activity.sentThisWeek(now: now, calendar: environment.calendar)
        if let pause = appState.pause {
            current.activity = .paused(pause.reason)
        } else if scanning {
            current.activity = .checking
        } else {
            current.activity = appState.setup.isFinished ? .watching : .waitingForSetup
        }
        if let host = configuredHost {
            if current.connection == .notSetUp { current.connection = .notCheckedYet(host: host) }
        } else {
            current.connection = .notSetUp
        }
        publish()
    }

    private func publish() {
        for continuation in continuations.values {
            continuation.yield(current)
        }
    }

    private func saveAppState() {
        do {
            try appStateStore.save(appState)
        } catch {
            Self.log.error("Could not save the app state: \(String(describing: error), privacy: .public)")
        }
    }

    private func saveActivity() {
        do {
            try activityStore.save(activity)
        } catch {
            Self.log.error("Could not save the activity counts: \(String(describing: error), privacy: .public)")
        }
    }
}

/// Sends only while the gate is open. A closed gate stops the scan at the next message,
/// without moving past it, so nothing is lost by pausing.
struct GatedSender: CaptureSending {
    let inner: any CaptureSending
    let gate: OSAllocatedUnfairLock<Bool>

    func capture(_ request: CaptureRequest) async throws -> CaptureResponse {
        guard gate.withLock({ $0 }) else { throw WitnessClientError.transport("Paused") }
        return try await inner.capture(request)
    }
}

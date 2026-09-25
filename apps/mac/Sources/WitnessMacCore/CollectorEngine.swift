import Foundation
import os

/// What the menu-bar app shows. States only: never message text, senders or names, and no
/// tally of what was sent (a "0 this week" would read as a verdict on the week).
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
        /// The saved key was saved for a different address than the one in `config.json`,
        /// so nothing is sent until the key is added again for this address.
        case keyForOtherAddress(host: String)
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
    /// A plain sentence about the last problem, if the last check hit one.
    public var note: String?
    /// Older messages (after the person chose to look further back) are being looked
    /// through, a few at a time. A state only: no count of what is left.
    public var lookingBack: Bool

    public init(
        connection: Connection = .notSetUp,
        fullDiskAccess: FullDiskAccessState = .denied,
        activity: Activity = .waitingForSetup,
        lastCheck: Date? = nil,
        note: String? = nil,
        lookingBack: Bool = false
    ) {
        self.connection = connection
        self.fullDiskAccess = fullDiskAccess
        self.activity = activity
        self.lastCheck = lastCheck
        self.note = note
        self.lookingBack = lookingBack
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
        case .keyForOtherAddress: "The key is for a different address"
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

    /// Shown under the activity while older messages are being looked through.
    public static let lookingBack = "Also looking through older messages, a few at a time."

    /// Settings' sentence on how far back the checks so far reached, from cursor.json (times
    /// only). While older messages are still being sent a few at a time (`lookingBack`), the
    /// rest of a first check included, it says so rather than that they were all looked at.
    public static func lookedBack(_ cursor: CursorState, lookingBack: Bool) -> String {
        let since = cursor.coveredSince ?? cursor.notBefore
        let reached = if lookingBack {
            "Witness is still looking through older messages, a few at a time."
        } else if since <= 0 {
            "Witness has already looked at every message on this Mac."
        } else {
            "Witness has already looked at messages back to \(Date(timeIntervalSince1970: TimeInterval(since) / 1_000).formatted(date: .long, time: .omitted))."
        }
        return reached + " " + lookbackChange
    }

    /// What changing the time does.
    public static let lookbackChange = "A longer time looks through the older ones once, a few at a time, and sends nothing twice. A shorter time sends nothing older than it from now on, and changes nothing already sent."

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
            .unreachable(host: "h"), .notWitness(host: "h"), .keyForOtherAddress(host: "h"),
        ]
        let access: [FullDiskAccessState] = [.granted, .denied, .missing, .unavailable(errno: 5)]
        let activities: [EngineStatus.Activity] = [
            .waitingForSetup, .watching, .checking, .paused(.byPerson), .paused(.keyRefused), .paused(.fullDiskAccess),
        ]
        return connections.map(connection) + access.map(fullDiskAccess) + activities.map(activity)
            + EngineNote.allCases.map(\.text) + [lookingBack, lookbackChange] + Lookback.choices.map(\.label)
    }
}

/// Plain sentences for problems a check can run into.
public enum EngineNote: CaseIterable, Sendable {
    case noMessagesDatabase
    case noLexicon
    case unreachable
    case notWitness
    case couldNotRead
    case keyForOtherAddress

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
        case .keyForOtherAddress:
            "The saved address is not the one this key was saved for, so nothing is sent. Add the key again in Settings."
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
    /// The name lookup, or nil when Contacts access is not allowed. The engine asks it only
    /// while names are on, and checks that again for every message.
    public var names: @Sendable () -> (any ContactsResolving)?
    /// Whether `http://localhost` may be the Witness address (development only).
    public var allowLocalHTTP: Bool
    public var now: @Sendable () -> Date
    public var watchDebounce: TimeInterval
    public var watchSafetyInterval: TimeInterval
    /// While paused because Messages cannot be read, how often to look whether Full Disk
    /// Access is back. Nothing else runs while paused, so without this it would stay paused
    /// until the panel was opened.
    public var accessRecoveryInterval: TimeInterval
    /// Waits between those looks. Injectable, so tests decide when time passes.
    public var sleep: @Sendable (TimeInterval) async throws -> Void
    /// At most this many messages are sent in one check (`ScanOptions.sendLimit`).
    public var sendLimit: Int

    public init(
        paths: WitnessPaths,
        tokenStore: any TokenStore,
        transport: any HTTPTransport,
        retryPolicy: RetryPolicy = .standard,
        lexiconURL: @escaping @Sendable () -> URL?,
        checkFullDiskAccess: @escaping @Sendable (URL) -> FullDiskAccessState = { FullDiskAccess.check(url: $0) },
        names: @escaping @Sendable () -> (any ContactsResolving)? = { nil },
        allowLocalHTTP: Bool = false,
        now: @escaping @Sendable () -> Date = Date.init,
        watchDebounce: TimeInterval = 5,
        watchSafetyInterval: TimeInterval = 600,
        accessRecoveryInterval: TimeInterval = 60,
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in
            try await Task.sleep(nanoseconds: UInt64(max(seconds, 0) * 1_000_000_000))
        },
        sendLimit: Int = ScanOptions.defaultSendLimit
    ) {
        self.paths = paths
        self.tokenStore = tokenStore
        self.transport = transport
        self.retryPolicy = retryPolicy
        self.lexiconURL = lexiconURL
        self.checkFullDiskAccess = checkFullDiskAccess
        self.names = names
        self.allowLocalHTTP = allowLocalHTTP
        self.now = now
        self.watchDebounce = watchDebounce
        self.watchSafetyInterval = watchSafetyInterval
        self.accessRecoveryInterval = accessRecoveryInterval
        self.sleep = sleep
        self.sendLimit = sendLimit
    }
}

/// Runs Witness for Mac in the background: watches Messages, scans with `MessageScanner`,
/// sends through `WitnessClient`, and keeps the pause state.
///
/// - A key is sent only to the address it was saved for. If `config.json` names another
///   address, nothing is sent until the key is added again (`.keyForOtherAddress`).
/// - A refused key (401 or 403) pauses it with `.keyRefused` until a new key is saved.
/// - Losing Full Disk Access pauses it with `.fullDiskAccess`; it resumes by itself once
///   Messages can be read again: while running, it looks every `accessRecoveryInterval`.
/// - A longer lookback chosen after the first check looks through the older messages once,
///   a few at a time (`MessageScanner`), and says so in the status (`lookingBack`). A new
///   lookback takes effect before the next message, even in the middle of a check. After a
///   full batch, or a 429, no check sends before the pause is over, whatever started it.
/// - The person's own Pause lasts until they resume, across restarts.
///
/// It never logs or publishes message text, senders or names: only counts and states.
/// Counts go to the unified log, for troubleshooting; the status carries none.
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
    /// Looks for Full Disk Access coming back, while paused for it and running.
    private var accessRecovery: Task<Void, Never>?
    /// Which recovery poll is current, so one that was replaced does nothing.
    private var accessRecoveryID = 0
    private var scanning = false
    private var rescanRequested = false
    /// The last check's `continueAt`: no check sends before it, whatever started it.
    private var pausedUntil: Date?
    private var cachedPrefilter: (url: URL, prefilter: Prefilter)?
    /// What is saved: nil without an address and a key. Read on start, after a key change
    /// and at each check, so the Keychain is not read on every update.
    private var savedServer: SavedServer?
    /// Open while not paused. Checked before every attempt to send, retries included, so
    /// Pause takes effect in the middle of a check too, not only at the next one.
    private let gate: OSAllocatedUnfairLock<Bool>
    /// Whether names are on. Checked for every message, so turning names off in the middle
    /// of a check takes effect at the next message.
    private let namesSwitch: OSAllocatedUnfairLock<Bool>
    /// The lookback chosen now. A check sends only while it is still the one the check started
    /// with, checked before every attempt like the Pause gate: a new choice in the middle of a
    /// check stops it before the next message, and the check the choice asked for goes on
    /// with the new one. So a shorter time sends nothing older from then on, even mid-check.
    private let lookbackNow: OSAllocatedUnfairLock<Lookback>

    private enum SavedServer: Equatable {
        case ready(host: String)
        case keyForOtherAddress(host: String)
    }

    public init(environment: EngineEnvironment) {
        self.environment = environment
        appStateStore = AppStateStore(fileURL: environment.paths.appStateFile)
        activityStore = ActivityStore(fileURL: environment.paths.activityFile)
        appState = appStateStore.load()
        activity = activityStore.load()
        gate = OSAllocatedUnfairLock(initialState: appState.pause == nil)
        namesSwitch = OSAllocatedUnfairLock(initialState: appState.namesEnabled)
        lookbackNow = OSAllocatedUnfairLock(initialState: appState.lookback)
        savedServer = Self.readSavedServer(environment)

        var status = EngineStatus()
        status.fullDiskAccess = environment.checkFullDiskAccess(environment.paths.messagesDatabase)
        switch savedServer {
        case .ready(let host)?:
            status.connection = appState.pause?.reason == .keyRefused ? .keyRefused(host: host) : .notCheckedYet(host: host)
        case .keyForOtherAddress(let host)?:
            status.connection = .keyForOtherAddress(host: host)
            status.note = EngineNote.keyForOtherAddress.text
        case nil:
            break
        }
        if let pause = appState.pause {
            status.activity = .paused(pause.reason)
        } else {
            status.activity = appState.setup.isFinished ? .watching : .waitingForSetup
        }
        status.lastCheck = activity.lastCheck
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
        startAccessRecovery()
        guard appState.setup.isFinished, appState.pause == nil else { return }
        startWatching()
    }

    /// Stops watching. The state on disk is kept.
    public func stop() {
        started = false
        stopWatching()
        stopAccessRecovery()
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
        let lookback = appState.lookback
        change(&appState)
        appState.pause = pause
        if !appState.lookback.isValid { appState.lookback = lookback }
        let namesEnabled = appState.namesEnabled
        namesSwitch.withLock { $0 = namesEnabled }
        let chosen = appState.lookback
        lookbackNow.withLock { $0 = chosen }
        saveAppState()
        refreshStatus()
        guard started, appState.setup.isFinished, appState.pause == nil else { return }
        if !wasFinished {
            startWatching()
            await scan()
        } else if appState.lookback != lookback {
            // A longer time starts looking through the older messages now; a shorter one
            // sets that aside.
            await scan()
        }
    }

    /// A new address or key was saved. Clears a pause for a refused key and checks again.
    public func connectionChanged() async {
        if appState.pause?.reason == .keyRefused { applyPause(nil) }
        savedServer = Self.readSavedServer(environment)
        switch savedServer {
        case .ready(let host)?:
            current.connection = .notCheckedYet(host: host)
            current.note = nil
        case .keyForOtherAddress(let host)?:
            current.connection = .keyForOtherAddress(host: host)
            current.note = EngineNote.keyForOtherAddress.text
        case nil:
            current.connection = .notSetUp
            current.note = nil
        }
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
              let url = try? ConfigValidation.normalizedAPIURL(config.apiUrl, allowLocalHTTP: environment.allowLocalHTTP)
        else {
            notSetUp()
            return
        }
        let host = url.host ?? url.absoluteString
        // The key goes only to the address it was saved for. config.json is an ordinary
        // file; if its address changed without the key being added again, send nothing.
        let token: String
        do {
            guard let saved = try environment.tokenStore.token(for: url) else {
                notSetUp()
                return
            }
            token = saved
        } catch KeyBindingError.otherAddress {
            Self.log.notice("The saved address is not the one the key was saved for: sending nothing")
            savedServer = .keyForOtherAddress(host: host)
            current.connection = .keyForOtherAddress(host: host)
            current.note = EngineNote.keyForOtherAddress.text
            return
        } catch {
            notSetUp()
            return
        }
        savedServer = .ready(host: host)

        guard let prefilter = loadPrefilter() else {
            current.note = EngineNote.noLexicon.text
            return
        }

        let gate = self.gate
        let namesSwitch = self.namesSwitch
        let lookbackNow = self.lookbackNow
        let lookback = appState.lookback
        let scanner = MessageScanner(
            databaseURL: databaseURL,
            prefilter: prefilter,
            cursorStore: CursorStore(fileURL: environment.paths.cursorFile),
            sender: WitnessClient(
                baseURL: url,
                token: token,
                transport: environment.transport,
                retryPolicy: environment.retryPolicy,
                // Before every attempt, retries included: Pause stops a send waiting to retry,
                // and so does a new lookback, whose own check goes on from this message.
                mayContinue: { gate.withLock { $0 } && lookbackNow.withLock { $0 } == lookback }
            ),
            names: SwitchedContactsResolver(isOn: { namesSwitch.withLock { $0 } }, resolver: environment.names),
            now: environment.now
        )

        let summary: ScanSummary
        do {
            summary = try await scanner.scanOnce(options: ScanOptions(
                lookback: lookback,
                sendLimit: environment.sendLimit,
                pausedUntil: pausedUntil
            ))
        } catch {
            // Paused during the check: the person's own Pause stays, whatever went wrong after it.
            guard appState.pause == nil else { return }
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

        if let continueAt = summary.continueAt { pausedUntil = continueAt }
        activity.recordCheck(at: environment.now())
        saveActivity()
        current.lookingBack = summary.lookingBack
        Self.log.info("Checked: \(summary.countsLine, privacy: .public)\(summary.lookingBack ? " · looking back" : "", privacy: .public)")
        // Paused during the check: it stopped at the next message, which is kept for later.
        guard appState.pause == nil else { return }

        if let stopped = summary.stoppedEarly {
            // Paused and resumed again, or a new lookback chosen, while this check waited:
            // nothing is wrong with the server, and the change has asked for another check.
            if stopped == .stopped { return }
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

        // The watcher keeps one of these at a time, the soonest, so checks started for other
        // reasons do not each start a chain of their own.
        if let retryAt = summary.retryAt { watcher?.scheduleRescan(at: retryAt) }
        // More to send (older messages, or a burst): the next few after a short pause, or a
        // longer one when the server asked to slow down. Until then no check sends anything.
        if let continueAt = summary.continueAt { watcher?.scheduleRescan(at: continueAt) }
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
            safetyInterval: environment.watchSafetyInterval,
            // The clock the checks' retryAt and continueAt come from.
            now: environment.now
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
        // The watcher (and its safety timer) is stopped, so look for access coming back.
        startAccessRecovery()
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
        if pause?.reason != .fullDiskAccess { stopAccessRecovery() }
    }

    // MARK: - Full Disk Access recovery

    /// While paused because Messages cannot be read (and running), looks every
    /// `accessRecoveryInterval` whether Full Disk Access is back, and resumes when it is.
    /// One `open` per look, nothing else.
    private func startAccessRecovery() {
        guard started, accessRecovery == nil, appState.pause?.reason == .fullDiskAccess else { return }
        accessRecoveryID += 1
        let id = accessRecoveryID
        let interval = environment.accessRecoveryInterval
        let sleep = environment.sleep
        accessRecovery = Task { [weak self] in
            while true {
                do { try await sleep(interval) } catch { return }
                guard let self, await self.lookForAccess(recoveryID: id) else { return }
            }
        }
    }

    private func stopAccessRecovery() {
        accessRecovery?.cancel()
        accessRecovery = nil
    }

    /// One look from the recovery poll. Returns whether to keep looking.
    private func lookForAccess(recoveryID: Int) -> Bool {
        guard recoveryID == accessRecoveryID, accessRecovery != nil else { return false }
        guard started, appState.pause?.reason == .fullDiskAccess else {
            stopAccessRecovery()
            return false
        }
        clearPauseIfResolved()
        guard appState.pause == nil else {
            publish()
            return true
        }
        // Resumed (clearPauseIfResolved stopped this poll). The watcher's first trigger checks
        // right away, in its own task.
        refreshStatus()
        if appState.setup.isFinished { startWatching() }
        return false
    }

    // MARK: - Status

    private static func readSavedServer(_ environment: EngineEnvironment) -> SavedServer? {
        guard let config = try? ConfigStore(fileURL: environment.paths.configFile).load(),
              let url = try? ConfigValidation.normalizedAPIURL(config.apiUrl, allowLocalHTTP: environment.allowLocalHTTP)
        else { return nil }
        let host = url.host ?? url.absoluteString
        do {
            return try environment.tokenStore.token(for: url) == nil ? nil : .ready(host: host)
        } catch KeyBindingError.otherAddress {
            return .keyForOtherAddress(host: host)
        } catch {
            return nil
        }
    }

    private func notSetUp() {
        savedServer = nil
        current.connection = .notSetUp
        current.note = nil
    }

    /// Recomputes the parts of the status that come from saved state, then publishes.
    private func refreshStatus() {
        current.lastCheck = activity.lastCheck
        if let pause = appState.pause {
            current.activity = .paused(pause.reason)
        } else if scanning {
            current.activity = .checking
        } else {
            current.activity = appState.setup.isFinished ? .watching : .waitingForSetup
        }
        switch savedServer {
        case .ready(let host)?:
            switch current.connection {
            case .notSetUp, .keyForOtherAddress: current.connection = .notCheckedYet(host: host)
            default: break
            }
        case .keyForOtherAddress(let host)?:
            current.connection = .keyForOtherAddress(host: host)
        case nil:
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
            Self.log.error("Could not save the time of the last check: \(String(describing: error), privacy: .public)")
        }
    }
}

/// Looks up a name only while names are on, asking `isOn` for every message. Turning names
/// off in the middle of a check stops names at the next message, and Contacts is not read
/// again for the rest of that check.
struct SwitchedContactsResolver: ContactsResolving {
    let isOn: @Sendable () -> Bool
    let resolver: @Sendable () -> (any ContactsResolving)?

    func name(forHandle handle: String) -> String? {
        guard isOn(), let resolver = resolver() else { return nil }
        return resolver.name(forHandle: handle)
    }
}

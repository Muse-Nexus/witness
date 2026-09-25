import Foundation

public enum WitnessMacVersion {
    public static let current = "0.2.0"
}

/// What one scan did, in counts only. Safe to print and log: it never holds message text.
public struct ScanSummary: Equatable, Sendable {
    /// Rows read from `chat.db`.
    public var scanned = 0
    /// From me, tapbacks, unsent, group events, empty, too long, or older than the lookback.
    public var skipped = 0
    /// Matched an exclusion rule (codes, business senders, no-reply).
    public var excluded = 0
    /// No positive cue; stayed on this Mac.
    public var noCue = 0
    /// Had a positive cue and qualified to be sent.
    public var candidates = 0
    /// Accepted by the server (saved, maybe, excluded, duplicate or blocked there).
    public var sent = 0
    /// Could not be sent.
    public var failed = 0
    /// Too new to send yet: Messages lets a sender unsend or edit for a few minutes.
    public var held = 0
    /// When the first held message may be sent, for the next scan.
    public var retryAt: Date?
    /// More kind messages are waiting: this scan sent as many as one scan may, or the server
    /// asked to slow down. The next scan may go on from here at this time.
    public var continueAt: Date?
    /// Messages already on the Mac are still to be looked through: an older window from a
    /// longer lookback, or the rest of a first scan that reached its send limit.
    public var lookingBack = false
    /// The cursor after the scan.
    public var cursor: Int64 = 0
    /// Set when the scan stopped before reaching the newest message, with the reason.
    public var stoppedEarly: WitnessClientError?

    public init() {}

    /// One line of counts, e.g. `scanned 12 · skipped 7 · excluded 1 · no cue 3 · candidates 1 · sent 1`.
    public var countsLine: String {
        var parts = [
            "scanned \(scanned)", "skipped \(skipped)", "excluded \(excluded)",
            "no cue \(noCue)", "candidates \(candidates)", "sent \(sent)",
        ]
        if failed > 0 { parts.append("failed \(failed)") }
        if held > 0 { parts.append("waiting \(held)") }
        return parts.joined(separator: " · ")
    }
}

public enum ScanError: Error, Equatable, CustomStringConvertible {
    case notSignedIn

    public var description: String {
        switch self {
        case .notSignedIn:
            "Witness for Mac is not signed in yet. Run: witness-mac login --url <your Witness address>"
        }
    }
}

public struct ScanOptions: Sendable, Equatable {
    /// At most this many messages are sent in one scan, so a long look back goes a few at a time.
    public static let defaultSendLimit = 20
    /// The wait before the next few, once a scan has sent `sendLimit`.
    public static let defaultPause: TimeInterval = 30
    /// The wait after the server asked to slow down (429).
    public static let defaultSlowDownPause: TimeInterval = 300

    /// Read and filter, but send nothing and do not move the cursor.
    public var dryRun: Bool
    /// How far back to look. The first scan starts there; a later scan that is asked to look
    /// further back looks through only the older messages not looked at yet.
    public var lookback: Lookback
    /// False when `lookback` is only a default nobody chose (the CLI without `--lookback`):
    /// then it applies to a first scan only, and older messages are looked through only as
    /// far as the person chose before.
    public var lookbackChosen: Bool
    public var batchSize: Int
    public var sendLimit: Int
    public var pause: TimeInterval
    public var slowDownPause: TimeInterval

    public init(
        dryRun: Bool = false,
        lookback: Lookback = .default,
        lookbackChosen: Bool = true,
        batchSize: Int = 500,
        sendLimit: Int = ScanOptions.defaultSendLimit,
        pause: TimeInterval = ScanOptions.defaultPause,
        slowDownPause: TimeInterval = ScanOptions.defaultSlowDownPause
    ) {
        self.dryRun = dryRun
        self.lookback = lookback
        self.lookbackChosen = lookbackChosen
        self.batchSize = max(1, batchSize)
        self.sendLimit = max(1, sendLimit)
        self.pause = max(0, pause)
        self.slowDownPause = max(0, slowDownPause)
    }
}

/// Reads new messages, keeps the ones with a positive cue, and sends only those.
///
/// Every message is handled in `ROWID` order and the cursor only moves past a
/// message once it is dealt with. If the server cannot be reached, or the address
/// is not a Witness (404, 405, an answer it cannot read), the scan stops and the
/// next one resumes at the first unsent candidate. Only a request the server read
/// and turned down (400, 413, 422) is skipped, since sending it again would not help.
///
/// A candidate younger than `holdInterval` is not sent yet: Messages lets the sender
/// unsend it (2 minutes) or edit it, and words someone took back must never be kept.
/// The scan stops there without moving the cursor, so the next scan reads the row
/// again, retracted or edited as it then is.
///
/// Pacing: one scan sends at most `ScanOptions.sendLimit` messages, then stops before the
/// next one and says when to go on (`ScanSummary.continueAt`). When the server asks to slow
/// down (429), `WitnessClient` waits and tries again; if it had to, or if the server still
/// refuses, the scan stops and goes on after `slowDownPause`, never past an unsent message.
///
/// New messages come first. Then, when the person chose to look further back than earlier
/// scans did, the oldest stretch still to do (`CursorState.olderWindows`) is looked through
/// with its own cursor, under the same limit.
public struct MessageScanner: Sendable {
    /// Longer messages are skipped rather than uploaded; evidence is a snippet, not an essay.
    /// Counted in UTF-16 code units, as the server counts, so nothing sent is too long there.
    public static let maximumTextLength = 16_000
    /// Apple's Undo Send window is 2 minutes; a little more covers clock differences.
    public static let holdInterval: TimeInterval = 3 * 60

    public let databaseURL: URL
    public let prefilter: Prefilter
    public let cursorStore: CursorStore
    /// `nil` is allowed only for dry runs.
    public let sender: (any CaptureSending)?
    /// Names from the person's own Contacts, when they turned names on. Looked up only
    /// for a message that is being sent.
    public let names: (any ContactsResolving)?
    private let now: @Sendable () -> Date

    public init(
        databaseURL: URL,
        prefilter: Prefilter,
        cursorStore: CursorStore,
        sender: (any CaptureSending)?,
        names: (any ContactsResolving)? = nil,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.databaseURL = databaseURL
        self.prefilter = prefilter
        self.cursorStore = cursorStore
        self.sender = sender
        self.names = names
        self.now = now
    }

    public func scanOnce(options: ScanOptions = ScanOptions()) async throws -> ScanSummary {
        guard options.dryRun || sender != nil else { throw ScanError.notSignedIn }

        let database = try MessagesDatabase(url: databaseURL)
        let newest = try database.maxRowID()
        var state: CursorState
        if let saved = try cursorStore.load(), saved.databasePath == nil || saved.databasePath == database.path,
           saved.lastRowID <= newest {
            state = saved
        } else {
            // No cursor yet, it belongs to a different database, or chat.db was rebuilt with
            // lower ROWIDs (Messages deleted and resynced, or a backup restored) so the old
            // cursor would skip everything new: start fresh with the lookback. `notBefore`
            // still keeps old history from being sent.
            state = try CursorStore.initialState(database: database, now: now(), lookback: options.lookback)
            if !options.dryRun { try persist(&state) }
        }

        // How far back the person wants: what they chose now, or else what they chose before.
        if options.lookbackChosen {
            let before = state
            state.planOlderWindows(for: options.lookback, newestRowID: newest, now: AppleTime.unixMilliseconds(now()))
            if !options.dryRun, state != before { try persist(&state) }
        }
        let wanted = options.lookbackChosen ? options.lookback : state.lookback

        var summary = ScanSummary()
        var run = Run(options: options, sendsLeft: options.dryRun ? Int.max : options.sendLimit)

        // 1. New messages.
        live: while true {
            let rows = try database.rows(after: state.lastRowID, limit: options.batchSize)
            for row in rows {
                summary.scanned += 1
                let outcome = await handle(row, notBefore: state.notBefore, run: &run, summary: &summary)
                if outcome.movesPast { state.lastRowID = row.rowID }
                if end(on: outcome, run: &run, summary: &summary) { break live }
            }
            if !options.dryRun, !rows.isEmpty { try persist(&state) }
            if rows.count < options.batchSize { break }
        }
        if !options.dryRun, summary.stoppedEarly != nil || summary.held > 0 || summary.continueAt != nil { try persist(&state) }
        summary.cursor = state.lastRowID

        // 2. Older messages, when the person chose to look further back. Not after a problem,
        //    and not once this scan has sent all it may.
        older: while summary.stoppedEarly == nil, summary.continueAt == nil,
                     var window = state.olderWindowToCheck(for: wanted) {
            var ended = false
            var finished = false
            while !ended, !finished {
                let rows = try database.rows(
                    after: window.lastRowID, through: window.throughRowID,
                    datedFrom: window.since, before: window.before, limit: options.batchSize
                )
                for row in rows {
                    summary.scanned += 1
                    let outcome = await handle(row, notBefore: window.since, run: &run, summary: &summary)
                    if outcome.movesPast { window.lastRowID = row.rowID }
                    if end(on: outcome, run: &run, summary: &summary) {
                        ended = true
                        break
                    }
                }
                if !ended, rows.count < options.batchSize { finished = true }
                state.olderWindows[0] = window
                if finished { state.finishNewestOlderWindow() }
                if !options.dryRun, !rows.isEmpty || finished { try persist(&state) }
            }
            if ended { break older }
        }
        summary.lookingBack = run.reachedSendLimit || state.olderWindowToCheck(for: wanted) != nil
        return summary
    }

    /// What one scan has left to send.
    private struct Run {
        let options: ScanOptions
        var sendsLeft: Int
        var reachedSendLimit = false
    }

    private enum RowOutcome {
        case done
        /// Sent, but the server asked to slow down first: go on later.
        case doneSlowly
        case stop(WitnessClientError)
        /// Too new to send; try again at this time.
        case hold(Date)
        /// This scan has sent all it may; this message goes first next time.
        case sendLimit

        var movesPast: Bool {
            switch self {
            case .done, .doneSlowly: true
            case .stop, .hold, .sendLimit: false
            }
        }
    }

    /// Records why a pass ends, if it does.
    private func end(on outcome: RowOutcome, run: inout Run, summary: inout ScanSummary) -> Bool {
        switch outcome {
        case .done:
            return false
        case .doneSlowly:
            summary.continueAt = now().addingTimeInterval(run.options.slowDownPause)
        case .stop(let error):
            summary.stoppedEarly = error
            if case .http(429, _) = error { summary.continueAt = now().addingTimeInterval(run.options.slowDownPause) }
        case .hold(let until):
            summary.held += 1
            summary.retryAt = until
        case .sendLimit:
            run.reachedSendLimit = true
            summary.continueAt = now().addingTimeInterval(run.options.pause)
        }
        return true
    }

    private func handle(
        _ row: MessageRow,
        notBefore: Int64,
        run: inout Run,
        summary: inout ScanSummary
    ) async -> RowOutcome {
        guard case .incoming(let message) = row else {
            summary.skipped += 1
            return .done
        }
        if let occurredAt = message.occurredAt, occurredAt < notBefore {
            summary.skipped += 1
            return .done
        }
        if message.text.utf16.count > Self.maximumTextLength {
            summary.skipped += 1
            return .done
        }

        switch prefilter.evaluate(text: message.text, handle: message.handle) {
        case .excluded:
            summary.excluded += 1
            return .done
        case .noCue:
            summary.noCue += 1
            return .done
        case .candidate:
            break
        }

        guard !run.options.dryRun, let sender else {
            summary.candidates += 1
            return .done
        }
        if let occurredAt = message.occurredAt {
            let sentAt = Date(timeIntervalSince1970: TimeInterval(occurredAt) / 1000)
            let sendableAt = sentAt.addingTimeInterval(Self.holdInterval)
            if sendableAt > now() { return .hold(sendableAt) }
        }
        guard run.sendsLeft > 0 else { return .sendLimit }
        run.sendsLeft -= 1
        summary.candidates += 1
        do {
            let fromName = message.handle.flatMap { names?.name(forHandle: $0) }
            let response = try await sender.capture(CaptureRequest(message: message, fromName: fromName))
            summary.sent += 1
            return response.askedToSlowDown ? .doneSlowly : .done
        } catch let error as WitnessClientError {
            summary.failed += 1
            // Only a request the server read and turned down is skipped; anything else
            // (a wrong address, an answer that is not Witness's) keeps the cursor here.
            return error.isRequestRejected ? .done : .stop(error)
        } catch {
            summary.failed += 1
            return .stop(.transport(String(describing: type(of: error))))
        }
    }

    private func persist(_ state: inout CursorState) throws {
        state.updatedAt = AppleTime.unixMilliseconds(now())
        try cursorStore.save(state)
    }
}

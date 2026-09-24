import Foundation

public enum WitnessMacVersion {
    public static let current = "0.1.0"
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
    /// Read and filter, but send nothing and do not move the cursor.
    public var dryRun: Bool
    /// Used only when there is no saved cursor yet.
    public var lookbackDays: Int
    public var batchSize: Int

    public init(dryRun: Bool = false, lookbackDays: Int = CursorStore.defaultLookbackDays, batchSize: Int = 500) {
        self.dryRun = dryRun
        self.lookbackDays = lookbackDays
        self.batchSize = max(1, batchSize)
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
public struct MessageScanner: Sendable {
    /// Longer messages are skipped rather than uploaded; evidence is a snippet, not an essay.
    public static let maximumTextLength = 16_000
    /// Apple's Undo Send window is 2 minutes; a little more covers clock differences.
    public static let holdInterval: TimeInterval = 3 * 60

    public let databaseURL: URL
    public let prefilter: Prefilter
    public let cursorStore: CursorStore
    /// `nil` is allowed only for dry runs.
    public let sender: (any CaptureSending)?
    private let now: @Sendable () -> Date

    public init(
        databaseURL: URL,
        prefilter: Prefilter,
        cursorStore: CursorStore,
        sender: (any CaptureSending)?,
        now: @escaping @Sendable () -> Date = Date.init
    ) {
        self.databaseURL = databaseURL
        self.prefilter = prefilter
        self.cursorStore = cursorStore
        self.sender = sender
        self.now = now
    }

    public func scanOnce(options: ScanOptions = ScanOptions()) async throws -> ScanSummary {
        guard options.dryRun || sender != nil else { throw ScanError.notSignedIn }

        let database = try MessagesDatabase(url: databaseURL)
        var state: CursorState
        if let saved = try cursorStore.load(), saved.databasePath == nil || saved.databasePath == database.path,
           saved.lastRowID <= (try database.maxRowID()) {
            state = saved
        } else {
            // No cursor yet, it belongs to a different database, or chat.db was rebuilt with
            // lower ROWIDs (Messages deleted and resynced, or a backup restored) so the old
            // cursor would skip everything new: start fresh with the lookback. `notBefore`
            // still keeps old history from being sent.
            // No cursor yet, or it belongs to a different database: start fresh with the lookback.
            state = try CursorStore.initialState(database: database, now: now(), lookbackDays: options.lookbackDays)
            if !options.dryRun { try persist(&state) }
        }

        var summary = ScanSummary()
        batches: while true {
            let rows = try database.rows(after: state.lastRowID, limit: options.batchSize)
            for row in rows {
                summary.scanned += 1
                let outcome = await handle(row, state: state, options: options, summary: &summary)
                if case .stop(let error) = outcome {
                    summary.stoppedEarly = error
                    break batches
                }
                if case .hold(let until) = outcome {
                    summary.held += 1
                    summary.retryAt = until
                    break batches
                }
                state.lastRowID = row.rowID
            }
            if !options.dryRun, !rows.isEmpty { try persist(&state) }
            if rows.count < options.batchSize { break }
        }

        if !options.dryRun, summary.stoppedEarly != nil || summary.held > 0 { try persist(&state) }
        summary.cursor = state.lastRowID
        return summary
    }

    private enum RowOutcome {
        case done
        case stop(WitnessClientError)
        /// Too new to send; try again at this time.
        case hold(Date)
    }

    private func handle(
        _ row: MessageRow,
        state: CursorState,
        options: ScanOptions,
        summary: inout ScanSummary
    ) async -> RowOutcome {
        guard case .incoming(let message) = row else {
            summary.skipped += 1
            return .done
        }
        if let occurredAt = message.occurredAt, occurredAt < state.notBefore {
            summary.skipped += 1
            return .done
        }
        if message.text.count > Self.maximumTextLength {
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
            summary.candidates += 1
        }

        guard !options.dryRun, let sender else { return .done }
        if let occurredAt = message.occurredAt {
            let sentAt = Date(timeIntervalSince1970: TimeInterval(occurredAt) / 1000)
            let sendableAt = sentAt.addingTimeInterval(Self.holdInterval)
            if sendableAt > now() {
                summary.candidates -= 1
                return .hold(sendableAt)
            }
        }
        do {
            _ = try await sender.capture(CaptureRequest(message: message))
            summary.sent += 1
            return .done
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

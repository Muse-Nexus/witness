import Darwin
import Foundation

/// Tells `witness-mac run` when to scan.
///
/// Messages writes new rows to `chat.db-wal` first, so that file is watched with a
/// `DispatchSource`. Bursts of writes are debounced (5 seconds by default) into one
/// trigger. A periodic safety trigger (every 10 minutes) covers anything a file
/// event might miss, such as the WAL being checkpointed and replaced.
///
/// Triggers are delivered through an `AsyncStream` that keeps only the newest
/// pending trigger, so while a scan is running further changes coalesce into a
/// single follow-up scan.
///
/// All mutable state is confined to `queue`, which is what makes the
/// `@unchecked Sendable` conformance sound.
public final class ChatDatabaseWatcher: @unchecked Sendable {
    public enum Trigger: Equatable, Sendable {
        case startup
        case change
        case periodic
    }

    public let databaseURL: URL
    public let debounce: TimeInterval
    public let safetyInterval: TimeInterval

    private let queue = DispatchQueue(label: "studio.musenexus.witness.watcher")
    private var fileSource: (any DispatchSourceFileSystemObject)?
    private var watchedPath: String?
    private var safetyTimer: (any DispatchSourceTimer)?
    private var pendingChange: DispatchWorkItem?
    private var continuation: AsyncStream<Trigger>.Continuation?
    private var stopped = false

    public init(databaseURL: URL, debounce: TimeInterval = 5, safetyInterval: TimeInterval = 600) {
        self.databaseURL = databaseURL
        self.debounce = debounce
        self.safetyInterval = safetyInterval
    }

    /// The WAL file if it exists, otherwise the database itself.
    var watchedURL: URL {
        let wal = URL(fileURLWithPath: databaseURL.path + "-wal")
        return FileManager.default.fileExists(atPath: wal.path) ? wal : databaseURL
    }

    /// Starts watching and returns the trigger stream. The first element is `.startup`.
    /// Call once; the stream finishes when `stop()` is called.
    public func triggers() -> AsyncStream<Trigger> {
        let (stream, continuation) = AsyncStream.makeStream(of: Trigger.self, bufferingPolicy: .bufferingNewest(1))
        continuation.onTermination = { [weak self] _ in self?.stop() }
        queue.async {
            guard !self.stopped else {
                continuation.finish()
                return
            }
            self.continuation = continuation
            continuation.yield(.startup)
            self.startFileSource()
            self.startSafetyTimer()
        }
        return stream
    }

    public func stop() {
        queue.async {
            guard !self.stopped else { return }
            self.stopped = true
            self.pendingChange?.cancel()
            self.pendingChange = nil
            self.fileSource?.cancel()
            self.fileSource = nil
            self.safetyTimer?.cancel()
            self.safetyTimer = nil
            self.continuation?.finish()
            self.continuation = nil
        }
    }

    /// Asks for one more scan at `date` (a message was too new to send yet).
    public func scheduleRescan(at date: Date) {
        let delay = max(0, date.timeIntervalSinceNow) + 1
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.stopped else { return }
            self.continuation?.yield(.periodic)
        }
    }

    /// Records a change and (re)starts the debounce timer.
    func noteChange() {
        queue.async { self.scheduleDebouncedChange() }
    }

    // MARK: - Queue-confined

    private func scheduleDebouncedChange() {
        guard !stopped else { return }
        pendingChange?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.stopped else { return }
            self.pendingChange = nil
            self.continuation?.yield(.change)
        }
        pendingChange = work
        queue.asyncAfter(deadline: .now() + debounce, execute: work)
    }

    private func startFileSource() {
        guard !stopped, fileSource == nil else { return }
        let path = watchedURL.path
        let descriptor = open(path, O_EVTONLY | O_CLOEXEC)
        // Without a descriptor (for example no Full Disk Access yet) the safety
        // timer still triggers scans and retries the watch.
        guard descriptor >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .extend, .delete, .rename, .revoke],
            queue: queue
        )
        source.setEventHandler { [weak self, weak source] in
            guard let self, let source else { return }
            let events = source.data
            self.scheduleDebouncedChange()
            if !events.isDisjoint(with: [.delete, .rename, .revoke]) {
                // The file was replaced (e.g. a WAL checkpoint): watch the new one shortly.
                self.restartFileSource(after: 1)
            }
        }
        source.setCancelHandler {
            close(descriptor)
        }
        fileSource = source
        watchedPath = path
        source.resume()
    }

    private func restartFileSource(after delay: TimeInterval) {
        fileSource?.cancel()
        fileSource = nil
        watchedPath = nil
        queue.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.startFileSource()
        }
    }

    private func startSafetyTimer() {
        guard safetyInterval > 0 else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + safetyInterval, repeating: safetyInterval, leeway: .seconds(5))
        timer.setEventHandler { [weak self] in
            guard let self, !self.stopped else { return }
            if self.fileSource == nil {
                self.startFileSource()
            } else if self.watchedPath != self.watchedURL.path {
                // A WAL appeared since we started on the database file; move to it.
                self.restartFileSource(after: 0)
            }
            self.continuation?.yield(.periodic)
        }
        safetyTimer = timer
        timer.resume()
    }
}

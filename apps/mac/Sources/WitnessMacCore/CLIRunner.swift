import Darwin
import Foundation

/// Exit codes, following `sysexits(3)` so scripts and launchd can tell failures apart.
public enum ExitCode {
    public static let ok: Int32 = 0
    public static let failure: Int32 = 1
    public static let usage: Int32 = 64 // EX_USAGE
    public static let noInput: Int32 = 66 // EX_NOINPUT: no Messages database
    public static let temporaryFailure: Int32 = 75 // EX_TEMPFAIL: server unreachable, try later
    public static let noPermission: Int32 = 77 // EX_NOPERM: Full Disk Access or token refused
    public static let configuration: Int32 = 78 // EX_CONFIG: not signed in, no lexicon
}

/// Everything the CLI touches in the outside world, injectable for tests.
public struct CLIEnvironment: Sendable {
    public var paths: WitnessPaths
    public var tokenStore: any TokenStore
    public var transport: any HTTPTransport
    public var retryPolicy: RetryPolicy
    public var environment: [String: String]
    public var now: @Sendable () -> Date
    public var output: @Sendable (String) -> Void
    public var errorOutput: @Sendable (String) -> Void
    /// Reads a secret without echoing it; `nil` if nothing was entered.
    public var readSecret: @Sendable (_ prompt: String) -> String?
    public var useColor: Bool
    /// How `run` waits: quiet period after a change, and the periodic safety scan.
    public var watchDebounce: TimeInterval
    public var watchSafetyInterval: TimeInterval
    /// Whether `run` turns SIGINT/SIGTERM into a clean stop. Only the real CLI sets this.
    public var handlesStopSignals: Bool
    /// At most this many messages are sent in one pass (`ScanOptions.sendLimit`).
    public var sendLimit: Int
    /// How `scan` waits between passes. Injectable, so tests do not wait.
    public var sleep: @Sendable (TimeInterval) async throws -> Void

    public init(
        paths: WitnessPaths,
        tokenStore: any TokenStore,
        transport: any HTTPTransport,
        retryPolicy: RetryPolicy = .standard,
        environment: [String: String] = [:],
        now: @escaping @Sendable () -> Date = Date.init,
        output: @escaping @Sendable (String) -> Void,
        errorOutput: @escaping @Sendable (String) -> Void,
        readSecret: @escaping @Sendable (String) -> String? = { _ in nil },
        useColor: Bool = false,
        watchDebounce: TimeInterval = 5,
        watchSafetyInterval: TimeInterval = 600,
        handlesStopSignals: Bool = false,
        sendLimit: Int = ScanOptions.defaultSendLimit,
        sleep: @escaping @Sendable (TimeInterval) async throws -> Void = { seconds in
            try await Task.sleep(nanoseconds: UInt64(max(seconds, 0) * 1_000_000_000))
        }
    ) {
        self.paths = paths
        self.tokenStore = tokenStore
        self.transport = transport
        self.retryPolicy = retryPolicy
        self.environment = environment
        self.now = now
        self.output = output
        self.errorOutput = errorOutput
        self.readSecret = readSecret
        self.useColor = useColor
        self.watchDebounce = watchDebounce
        self.watchSafetyInterval = watchSafetyInterval
        self.handlesStopSignals = handlesStopSignals
        self.sendLimit = sendLimit
        self.sleep = sleep
    }
}

/// Runs a parsed command. Nothing here ever prints message text: only counts,
/// states, paths and the server address.
public struct CLIRunner: Sendable {
    public let env: CLIEnvironment
    private let brand: Brand

    public init(environment: CLIEnvironment) {
        env = environment
        brand = Brand(useColor: environment.useColor)
    }

    public func run(arguments: [String]) async -> Int32 {
        do {
            return await run(try CLIParser.parse(arguments))
        } catch let error as CLIUsageError {
            env.errorOutput(error.message)
            return ExitCode.usage
        } catch {
            env.errorOutput(String(describing: error))
            return ExitCode.usage
        }
    }

    public func run(_ command: CLICommand) async -> Int32 {
        switch command {
        case .help:
            env.output(brand.wordmark(subtitle: "for Mac") + "\n\n" + CLIParser.usage)
            return ExitCode.ok
        case .version:
            env.output("witness-mac \(WitnessMacVersion.current)")
            return ExitCode.ok
        case .status(let options):
            return status(options)
        case .login(let url, let token):
            return await login(url: url, token: token)
        case .logout:
            return logout()
        case .scan(let options, let dryRun):
            return await scan(options, dryRun: dryRun)
        case .run(let options):
            return await watch(options)
        }
    }

    // MARK: - status

    private func status(_ options: SourceOptions) -> Int32 {
        let databaseURL = databaseURL(options)
        let access = FullDiskAccess.check(url: databaseURL)
        var lines = [brand.wordmark(subtitle: "for Mac · \(WitnessMacVersion.current)"), ""]

        func row(_ label: String, _ value: String) {
            lines.append("  " + label.padding(toLength: 18, withPad: " ", startingAt: 0) + value)
        }

        row("Messages access", "\(access) " + brand.dim("(\(displayPath(databaseURL)))"))

        let config = try? ConfigStore(fileURL: env.paths.configFile).load()
        row("Server", config?.apiUrl ?? "not set")
        let token: String?
        do {
            token = try env.tokenStore.readToken()
            var value = token == nil ? "not saved" : env.tokenStore.savedLocation
            if token != nil, let address = config?.apiUrl, let url = try? ConfigValidation.normalizedAPIURL(address),
               (try? env.tokenStore.token(for: url)) == nil {
                value += " · saved for a different address, so nothing is sent"
            }
            row("Device token", value)
        } catch {
            token = nil
            row("Device token", "could not be read · \(error)")
        }

        let lookback = chosenLookback(options, config: config) ?? .default
        switch Result(catching: { try CursorStore(fileURL: env.paths.cursorFile).load() }) {
        case .success(let cursor?):
            row("Cursor", "after message \(cursor.lastRowID) · saved \(formatted(milliseconds: cursor.updatedAt))")
            row("Keeping since", since(cursor.coveredSince ?? cursor.notBefore))
            if let window = cursor.olderWindowToCheck(for: cursor.lookback) {
                row("Looking back", "older messages from \(since(window.since)) are still to look through, a few at a time")
            }
        case .success(nil):
            row("Cursor", "not started · the first scan looks at \(describe(lookback))")
        case .failure:
            row("Cursor", "unreadable · delete \(displayPath(env.paths.cursorFile)) to start over")
        }

        if let lexiconURL = resolveLexicon(options) {
            // Compile every rule, so a pattern ICU cannot read shows up here rather than on the first scan.
            let summary: String
            do {
                let lexicon = try Lexicon.load(from: lexiconURL)
                let counts = try Prefilter(lexicon: lexicon).ruleCounts
                summary = "version \(lexicon.version) · \(counts.cues) cues and \(counts.exclusions) exclusions compile"
            } catch let error as PrefilterError {
                summary = "\(error)"
            } catch {
                summary = "could not be read"
            }
            row("Lexicon", "\(displayPath(lexiconURL)) · \(summary)")
        } else {
            row("Lexicon", "not found · pass --lexicon <path to lexicon.json>")
        }

        if access == .denied {
            lines.append("")
            lines.append(contentsOf: fullDiskAccessHelp())
        } else if config == nil || token == nil {
            lines.append("")
            lines.append("  To connect: witness-mac login --url <your Witness address>")
        }
        env.output(lines.joined(separator: "\n"))
        return ExitCode.ok
    }

    // MARK: - login / logout

    private func login(url rawURL: String, token rawToken: String?) async -> Int32 {
        do {
            let url = try ConfigValidation.normalizedAPIURL(rawURL)
            guard let entered = rawToken ?? env.readSecret("Paste your device token (it will not be shown): ") else {
                env.errorOutput("No token entered. Create a device token in Witness settings, then try again.")
                return ExitCode.usage
            }
            let token = try ConfigValidation.validatedDeviceToken(entered)

            // Check the address and key before saving them: a wrong address would otherwise
            // turn every kind text away later, and a key is only ever saved for an address
            // that answered like a Witness.
            let client = WitnessClient(baseURL: url, token: token, transport: env.transport, retryPolicy: env.retryPolicy)
            switch await client.checkConnection() {
            case .ok:
                break
            case .keyRefused:
                env.errorOutput("That device key was refused. Create a new one in Witness (Setup, Texts & photos), then try again.")
                return ExitCode.noPermission
            case .notWitness(let status):
                env.errorOutput(
                    "There is no Witness at \(url.absoluteString)\(status.map { " (it answered \($0))" } ?? ""). "
                        + "Use your Witness address, such as https://witness.example.com."
                )
                return ExitCode.usage
            case .badAddress(.hostNotFound):
                env.errorOutput("No server answers to \(url.absoluteString). Check the spelling and try again. Nothing was saved.")
                return ExitCode.usage
            case .badAddress(.certificate):
                env.errorOutput("This Mac does not trust the security certificate at \(url.absoluteString), so the token was not sent and nothing was saved.")
                return ExitCode.usage
            case .unreachable:
                env.errorOutput("Witness could not be reached just now, so nothing was saved. Run the same command again when you are online.")
                return ExitCode.temporaryFailure
            }

            // Both or neither: a failed save leaves the old key and address as they were.
            try SignInStore(paths: env.paths, tokenStore: env.tokenStore).save(token: token, server: url)

            env.output("""
                Signed in to \(url.absoluteString).
                Only messages with a kind word in them are sent there. Everything else stays on this Mac.
                """)
            if rawToken != nil {
                env.output(brand.dim("Next time, leave out --token to keep it out of your shell history."))
            }
            return ExitCode.ok
        } catch let error as ConfigError {
            env.errorOutput(error.description)
            return ExitCode.usage
        } catch {
            env.errorOutput("Could not save the sign-in: \(error)")
            return ExitCode.failure
        }
    }

    private func logout() -> Int32 {
        if env.tokenStore is EnvironmentTokenStore {
            env.output("WITNESS_TOKEN is set, so nothing is saved in the Keychain. Unset it to stop sending.")
            return ExitCode.ok
        }
        do {
            try env.tokenStore.deleteToken()
            env.output("The device token is removed from this Mac. Nothing more will be sent until you sign in again.")
            return ExitCode.ok
        } catch {
            env.errorOutput("Could not remove the device token: \(error)")
            return ExitCode.failure
        }
    }

    // MARK: - scan / run

    private struct Setup {
        var scanner: MessageScanner
        var options: ScanOptions
    }

    /// Checks access and configuration shared by `scan` and `run`. Returns an exit
    /// code instead when something needs the person's attention first.
    private func prepare(_ options: SourceOptions, dryRun: Bool) -> Result<Setup, ExitFailure> {
        let databaseURL = databaseURL(options)
        let access = FullDiskAccess.check(url: databaseURL)
        switch access {
        case .granted:
            break
        case .denied:
            return .failure(ExitFailure(ExitCode.noPermission, fullDiskAccessHelp()))
        case .missing:
            return .failure(ExitFailure(ExitCode.noInput, [
                "There is no Messages database at \(displayPath(databaseURL)).",
                "Open Messages and sign in, or pass --db <path>.",
            ]))
        case .unavailable:
            return .failure(ExitFailure(ExitCode.failure, [
                "Could not open \(displayPath(databaseURL)): \(access).",
            ]))
        }

        guard let lexiconURL = resolveLexicon(options) else {
            return .failure(ExitFailure(ExitCode.configuration, [
                "Could not find lexicon.json. Pass --lexicon <path>, or set \(LexiconLocator.environmentVariable).",
            ]))
        }
        let prefilter: Prefilter
        do {
            prefilter = try Prefilter.load(from: lexiconURL)
        } catch {
            return .failure(ExitFailure(ExitCode.configuration, [
                "Could not read \(displayPath(lexiconURL)): \(error)",
            ]))
        }

        let config = try? ConfigStore(fileURL: env.paths.configFile).load()
        var sender: (any CaptureSending)?
        if !dryRun {
            guard let config, let url = try? ConfigValidation.normalizedAPIURL(config.apiUrl) else {
                return .failure(ExitFailure(ExitCode.configuration, [ScanError.notSignedIn.description]))
            }
            let token: String?
            do {
                // Only the address the token was saved for gets it.
                token = try env.tokenStore.token(for: url)
            } catch KeyBindingError.otherAddress {
                return .failure(ExitFailure(ExitCode.configuration, [
                    "The saved device token was saved for a different address than \(url.absoluteString), so nothing is sent.",
                    "Sign in again: witness-mac login --url <your Witness address>",
                ]))
            } catch {
                return .failure(ExitFailure(ExitCode.noPermission, [
                    "Could not read the device token. \(error)",
                    "If macOS asked about the Keychain, run this again and choose Always Allow.",
                ]))
            }
            guard let token else {
                return .failure(ExitFailure(ExitCode.configuration, [ScanError.notSignedIn.description]))
            }
            sender = WitnessClient(baseURL: url, token: token, transport: env.transport, retryPolicy: env.retryPolicy)
        }

        let scanner = MessageScanner(
            databaseURL: databaseURL,
            prefilter: prefilter,
            cursorStore: CursorStore(fileURL: env.paths.cursorFile),
            sender: sender,
            now: env.now
        )
        // A lookback given on the command line (or in config.json) is the person's choice: a
        // longer one than before looks through the older messages. Without one, the default
        // applies to a first scan only, and an earlier choice carries on.
        let chosen = chosenLookback(options, config: config)
        let scanOptions = ScanOptions(
            dryRun: dryRun,
            lookback: chosen ?? .default,
            lookbackChosen: chosen != nil,
            sendLimit: env.sendLimit
        )
        return .success(Setup(scanner: scanner, options: scanOptions))
    }

    private func scan(_ options: SourceOptions, dryRun: Bool) async -> Int32 {
        let setup: Setup
        switch prepare(options, dryRun: dryRun) {
        case .success(let value): setup = value
        case .failure(let failure):
            failure.lines.forEach(env.errorOutput)
            return failure.code
        }

        do {
            // Passes of at most `sendLimit` messages, with a wait between, until nothing is left.
            // Control-C is safe at any point: the next scan picks up where this one stopped.
            while true {
                let summary = try await setup.scanner.scanOnce(options: setup.options)
                env.output((dryRun ? "Dry run, nothing sent: " : "") + summary.countsLine)
                if let stopped = summary.stoppedEarly {
                    env.errorOutput(stoppedMessage(stopped))
                    return stopped.isAuthorizationFailure ? ExitCode.noPermission : ExitCode.temporaryFailure
                }
                guard let continueAt = summary.continueAt else { break }
                let wait = max(0, continueAt.timeIntervalSince(env.now()))
                env.output(brand.dim("More to send. The next few go in \(Int(wait.rounded())) seconds. Control-C stops; the next scan picks up here."))
                try await env.sleep(wait)
            }
            return ExitCode.ok
        } catch is CancellationError {
            return ExitCode.ok
        } catch {
            env.errorOutput("Could not scan: \(error)")
            return ExitCode.failure
        }
    }

    private func watch(_ options: SourceOptions) async -> Int32 {
        let setup: Setup
        switch prepare(options, dryRun: false) {
        case .success(let value): setup = value
        case .failure(let failure):
            failure.lines.forEach(env.errorOutput)
            return failure.code
        }

        let watcher = ChatDatabaseWatcher(
            databaseURL: setup.scanner.databaseURL,
            debounce: env.watchDebounce,
            safetyInterval: env.watchSafetyInterval
        )
        let signals = env.handlesStopSignals ? StopSignals { watcher.stop() } : nil
        defer {
            signals?.cancel()
            watcher.stop()
        }

        env.output(brand.wordmark(subtitle: "for Mac · watching Messages"))
        env.output(brand.dim("Scans a few seconds after new messages arrive, and every 10 minutes. Control-C stops."))

        // The last scan's continueAt: no scan sends before it, whatever triggered it.
        var pausedUntil: Date?
        // The loop ends on stop() (signals) or when the surrounding task is cancelled.
        for await trigger in watcher.triggers() {
            do {
                var options = setup.options
                options.pausedUntil = pausedUntil
                let summary = try await setup.scanner.scanOnce(options: options)
                if let continueAt = summary.continueAt { pausedUntil = continueAt }
                if summary.scanned > 0 || trigger == .startup {
                    env.output("\(timestamp())  \(summary.countsLine)")
                }
                if let stopped = summary.stoppedEarly {
                    env.errorOutput("\(timestamp())  \(stoppedMessage(stopped))")
                    if stopped.isAuthorizationFailure {
                        watcher.stop()
                        return ExitCode.noPermission
                    }
                }
                // A message too new to send yet (it can still be unsent): look again when it may go.
                if let retryAt = summary.retryAt { watcher.scheduleRescan(at: retryAt) }
                // More to send (older messages, or a burst): the next few after a short wait.
                if let continueAt = summary.continueAt { watcher.scheduleRescan(at: continueAt) }
            } catch {
                env.errorOutput("\(timestamp())  Could not scan: \(error)")
            }
        }
        env.output("Stopped.")
        return ExitCode.ok
    }

    // MARK: - Helpers

    private struct ExitFailure: Error {
        var code: Int32
        var lines: [String]

        init(_ code: Int32, _ lines: [String]) {
            self.code = code
            self.lines = lines
        }
    }

    private func stoppedMessage(_ error: WitnessClientError) -> String {
        if error.isAuthorizationFailure {
            return "The server did not accept the device token. Create a new one in Witness settings, then run witness-mac login again."
        }
        switch error {
        case .http(let status, _) where !error.isTransient:
            return "The server at this address did not answer like Witness (\(status)). Nothing was skipped. Run witness-mac login --url with your Witness address, such as https://witness.example.com."
        case .invalidResponse:
            return "The server's answer could not be read, so nothing was skipped. Check the address with witness-mac status."
        default:
            break
        }
        return "Stopped early: \(error) The next scan picks up from here."
    }

    /// The lookback from the command line, else from config.json; nil when neither says.
    private func chosenLookback(_ options: SourceOptions, config: WitnessConfig?) -> Lookback? {
        options.lookback ?? config?.lookbackDays.flatMap { days in
            (0...Lookback.maximumDays).contains(days) ? Lookback.days(days) : nil
        }
    }

    private func describe(_ lookback: Lookback) -> String {
        switch lookback {
        case .days(let days): "the last \(days) \(days == 1 ? "day" : "days")"
        case .everything: "every message"
        }
    }

    /// A date for `status`, or "the first message" for everything.
    private func since(_ milliseconds: Int64) -> String {
        milliseconds <= 0 ? "the first message" : formatted(milliseconds: milliseconds, includeTime: false)
    }

    private func fullDiskAccessHelp() -> [String] {
        [
            "Witness for Mac needs Full Disk Access to read Messages.",
            "Open System Settings > Privacy & Security > Full Disk Access and turn it on for the app",
            "that runs witness-mac (your terminal app, or the witness-mac binary itself).",
            "Open the right page with:  open \"\(FullDiskAccess.settingsURLString)\"",
        ]
    }

    private func databaseURL(_ options: SourceOptions) -> URL {
        options.databasePath.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
            ?? env.paths.messagesDatabase
    }

    private func resolveLexicon(_ options: SourceOptions) -> URL? {
        LexiconLocator.resolve(
            explicitPath: options.lexiconPath.map { ($0 as NSString).expandingTildeInPath },
            environment: env.environment,
            supportDirectory: env.paths.supportDirectory
        )
    }

    private func displayPath(_ url: URL) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let path = url.path
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    private func formatted(milliseconds: Int64, includeTime: Bool = true) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(milliseconds) / 1_000)
        return date.formatted(date: .abbreviated, time: includeTime ? .shortened : .omitted)
    }

    private func timestamp() -> String {
        env.now().formatted(date: .numeric, time: .standard)
    }
}

/// Turns SIGINT and SIGTERM into a clean stop instead of an abrupt exit.
private final class StopSignals: @unchecked Sendable {
    // Created and cancelled from the same task; the handlers only call `onStop`.
    private var sources: [any DispatchSourceSignal] = []

    init(onStop: @escaping @Sendable () -> Void) {
        for signalNumber in [SIGINT, SIGTERM] {
            signal(signalNumber, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .global())
            source.setEventHandler(handler: onStop)
            source.resume()
            sources.append(source)
        }
    }

    func cancel() {
        sources.forEach { $0.cancel() }
        sources.removeAll()
        for signalNumber in [SIGINT, SIGTERM] {
            signal(signalNumber, SIG_DFL)
        }
    }
}

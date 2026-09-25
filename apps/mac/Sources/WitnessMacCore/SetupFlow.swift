import Foundation

/// The steps of the menu-bar app's setup, one calm screen each. Every step can be skipped.
public enum SetupStep: String, CaseIterable, Codable, Sendable {
    case server
    case fullDiskAccess
    case names
    case startAtLogin
    case lookback

    /// Short name for the step list in Settings.
    public var label: String {
        switch self {
        case .server: "Your Witness"
        case .fullDiskAccess: "Messages access"
        case .names: "Names"
        case .startAtLogin: "Start at login"
        case .lookback: "How far back"
        }
    }

    /// 1 to 5.
    public var number: Int { (Self.allCases.firstIndex(of: self) ?? 0) + 1 }
}

public enum StepOutcome: String, Codable, Equatable, Sendable {
    case done
    case skipped
}

/// Which steps were done or skipped, and when setup finished. Saved in `app-state.json`.
public struct SetupProgress: Codable, Equatable, Sendable {
    /// Keyed by `SetupStep.rawValue`, so an unknown step from a newer version is ignored.
    public var outcomes: [String: StepOutcome]
    /// Unix milliseconds. Witness starts checking only once setup is finished, so the first
    /// check uses the lookback the person chose.
    public var finishedAt: Int64?

    public init(outcomes: [SetupStep: StepOutcome] = [:], finishedAt: Int64? = nil) {
        self.outcomes = Dictionary(uniqueKeysWithValues: outcomes.map { ($0.key.rawValue, $0.value) })
        self.finishedAt = finishedAt
    }

    public var isFinished: Bool { finishedAt != nil }

    public func outcome(of step: SetupStep) -> StepOutcome? {
        outcomes[step.rawValue]
    }

    public mutating func set(_ outcome: StepOutcome, for step: SetupStep) {
        outcomes[step.rawValue] = outcome
    }

    /// The first step that has neither been done nor skipped.
    public var firstOpenStep: SetupStep? {
        SetupStep.allCases.first { outcome(of: $0) == nil }
    }
}

/// The setup window's state machine, with no UI in it.
///
/// On first run it goes through the steps in order and resumes at the first open step if
/// the app was quit halfway. From Settings it opens at any step. Closing the window
/// finishes setup: steps left open count as skipped, and each one stays in Settings.
public struct SetupFlow: Equatable, Sendable {
    public enum Mode: Equatable, Sendable {
        case firstRun
        case settings
    }

    public enum Position: Equatable, Sendable {
        case step(SetupStep)
        /// The closing screen.
        case finished
    }

    public let mode: Mode
    public private(set) var position: Position
    public private(set) var progress: SetupProgress

    public init(progress: SetupProgress, mode: Mode, startAt: SetupStep? = nil) {
        self.mode = mode
        self.progress = progress
        if let startAt {
            position = .step(startAt)
        } else if mode == .settings {
            position = .step(.server)
        } else if let open = progress.firstOpenStep {
            position = .step(open)
        } else {
            position = .finished
        }
    }

    public var currentStep: SetupStep? {
        if case .step(let step) = position { return step }
        return nil
    }

    public var isAtEnd: Bool { position == .finished }

    public var canGoBack: Bool {
        switch position {
        case .step(let step): step != SetupStep.allCases.first
        case .finished: mode == .firstRun
        }
    }

    /// "Step 2 of 5", or nil on the closing screen.
    public var stepCaption: String? {
        currentStep.map { "Step \($0.number) of \(SetupStep.allCases.count)" }
    }

    /// The current step is done; go on to the next one.
    public mutating func complete(now: Date) {
        guard let step = currentStep else { return }
        progress.set(.done, for: step)
        advance(from: step, now: now)
    }

    /// Leave the current step for now. A step already done stays done.
    public mutating func skip(now: Date) {
        guard let step = currentStep else { return }
        if progress.outcome(of: step) != .done { progress.set(.skipped, for: step) }
        advance(from: step, now: now)
    }

    public mutating func back() {
        guard canGoBack else { return }
        switch position {
        case .step(let step):
            guard let index = SetupStep.allCases.firstIndex(of: step), index > 0 else { return }
            position = .step(SetupStep.allCases[index - 1])
        case .finished:
            position = .step(SetupStep.allCases[SetupStep.allCases.count - 1])
        }
    }

    public mutating func go(to step: SetupStep) {
        position = .step(step)
    }

    /// Marks a step done without moving, for example when access is granted while the
    /// person is on another screen.
    public mutating func markDone(_ step: SetupStep) {
        progress.set(.done, for: step)
    }

    /// The window was closed. Steps still open count as skipped, and setup is finished.
    public mutating func close(now: Date) {
        for step in SetupStep.allCases where progress.outcome(of: step) == nil {
            progress.set(.skipped, for: step)
        }
        if progress.finishedAt == nil { progress.finishedAt = AppleTime.unixMilliseconds(now) }
        position = .finished
    }

    private mutating func advance(from step: SetupStep, now: Date) {
        guard let index = SetupStep.allCases.firstIndex(of: step) else { return }
        if index + 1 < SetupStep.allCases.count {
            position = .step(SetupStep.allCases[index + 1])
        } else {
            if progress.finishedAt == nil { progress.finishedAt = AppleTime.unixMilliseconds(now) }
            position = .finished
        }
    }
}

// MARK: - Step 1: the server and key

public enum ServerProblem: Equatable, Sendable {
    case invalidAddress
    case insecureAddress
    case invalidKey
    case keyRefused
    case notWitness(status: Int?)
    /// The name does not resolve: most often a typo.
    case hostNotFound
    /// TLS failed, so nothing was sent to that address.
    case untrustedCertificate
    case couldNotSave(String)

    public var message: String {
        switch self {
        case .invalidAddress:
            "That address does not look right. Use the full address, such as \(ServerConnector.defaultAddress)."
        case .insecureAddress:
            "The address needs to start with https://."
        case .invalidKey:
            "That does not look like a key from Witness. It starts with wit_dev_."
        case .keyRefused:
            "Witness did not accept that key. It may have been revoked. Make a new one in Witness and paste it here."
        case .notWitness(let status):
            "There is no Witness at that address\(status.map { " (it answered \($0))" } ?? ""). Check the address and try again."
        case .hostNotFound:
            "No server answers to that address. Check the spelling and try again. Nothing was saved."
        case .untrustedCertificate:
            "This Mac does not trust the security certificate at that address, so the key was not sent and nothing was saved. Check the address and try again."
        case .couldNotSave(let reason):
            "The key could not be saved on this Mac. \(reason)"
        }
    }
}

public enum ServerCheckState: Equatable, Sendable {
    case idle
    case checking
    case connected(host: String)
    /// Witness could not be reached just now (offline, a timeout, server trouble). Nothing
    /// is saved: a key is saved only for an address that answered like Witness.
    case unreachable(host: String)
    case problem(ServerProblem)

    public var message: String? {
        switch self {
        case .idle: nil
        case .checking: "Checking…"
        case .connected(let host): "Connected to \(host)."
        case .unreachable(let host):
            "\(host) could not be reached just now, so nothing was saved. When you are online, choose Check and save again."
        case .problem(let problem): problem.message
        }
    }

    public var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

/// Checks an address and key, then saves them where `witness-mac` keeps them too: the
/// address in `config.json`, the key in the Keychain, tied to that address.
public struct ServerConnector: Sendable {
    public static let defaultAddress = "https://witness.musenexus.studio"

    public let paths: WitnessPaths
    public let tokenStore: any TokenStore
    public let transport: any HTTPTransport
    public let retryPolicy: RetryPolicy
    /// `http://localhost` is accepted only in a development build of the app.
    public let allowLocalHTTP: Bool

    public init(
        paths: WitnessPaths,
        tokenStore: any TokenStore,
        transport: any HTTPTransport,
        retryPolicy: RetryPolicy = .standard,
        allowLocalHTTP: Bool = false
    ) {
        self.paths = paths
        self.tokenStore = tokenStore
        self.transport = transport
        self.retryPolicy = retryPolicy
        self.allowLocalHTTP = allowLocalHTTP
    }

    /// The saved server address, if any.
    public func savedAddress() -> String? {
        (try? ConfigStore(fileURL: paths.configFile).load())?.apiUrl
    }

    public func hasSavedKey() -> Bool {
        ((try? tokenStore.readToken()) ?? nil) != nil
    }

    /// A key is saved, and it was saved for the address in `config.json`.
    public func hasKeyForSavedAddress() -> Bool {
        guard let address = savedAddress(),
              let url = try? ConfigValidation.normalizedAPIURL(address, allowLocalHTTP: allowLocalHTTP)
        else { return false }
        return ((try? tokenStore.token(for: url)) ?? nil) != nil
    }

    /// Checks the address and key, and saves both only when the address answered like a
    /// Witness that accepts the key. Nothing is saved for a refused key, an address that is
    /// not a Witness or does not exist, or one that could not be reached just now.
    public func connect(address rawAddress: String, key rawKey: String) async -> ServerCheckState {
        let url: URL
        do {
            url = try ConfigValidation.normalizedAPIURL(rawAddress, allowLocalHTTP: allowLocalHTTP)
        } catch ConfigError.insecureURL {
            return .problem(.insecureAddress)
        } catch {
            return .problem(.invalidAddress)
        }
        guard let key = try? ConfigValidation.validatedDeviceToken(rawKey) else {
            return .problem(.invalidKey)
        }

        let client = WitnessClient(baseURL: url, token: key, transport: transport, retryPolicy: retryPolicy)
        let host = url.host ?? url.absoluteString
        switch await client.verifyKey() {
        case .ok:
            break
        case .unreachable:
            return .unreachable(host: host)
        case .keyRefused:
            return .problem(.keyRefused)
        case .notWitness(let status):
            return .problem(.notWitness(status: status))
        case .badAddress(.hostNotFound):
            return .problem(.hostNotFound)
        case .badAddress(.certificate):
            return .problem(.untrustedCertificate)
        }

        do {
            // Both or neither: a failed save leaves the old key and address as they were.
            try SignInStore(paths: paths, tokenStore: tokenStore).save(token: key, server: url)
        } catch {
            return .problem(.couldNotSave(String(describing: error)))
        }
        return .connected(host: host)
    }

    /// Removes the key from this Mac. The address stays, so a new key is quick to add.
    public func removeKey() throws {
        try tokenStore.deleteToken()
    }
}

// MARK: - Step 2: Full Disk Access

public enum FullDiskAccessPhase: Equatable, Sendable {
    case granted
    case waiting
    /// Still not readable a while after System Settings was opened. macOS applies a new
    /// Full Disk Access grant only after the app reopens, so offer to relaunch.
    case mayNeedRelaunch
    /// There is no Messages database on this Mac.
    case noMessages
}

/// Follows the Full Disk Access step while the app polls `FullDiskAccess.check` each second.
public struct FullDiskAccessWatch: Equatable, Sendable {
    public static let relaunchHintDelay: TimeInterval = 8

    public private(set) var openedSettingsAt: Date?

    public init(openedSettingsAt: Date? = nil) {
        self.openedSettingsAt = openedSettingsAt
    }

    public mutating func openedSettings(at date: Date) {
        openedSettingsAt = date
    }

    public func phase(for state: FullDiskAccessState, now: Date) -> FullDiskAccessPhase {
        switch state {
        case .granted:
            return .granted
        case .missing:
            return .noMessages
        case .denied, .unavailable:
            guard let openedSettingsAt, now.timeIntervalSince(openedSettingsAt) >= Self.relaunchHintDelay else {
                return .waiting
            }
            return .mayNeedRelaunch
        }
    }
}

// MARK: - Step 4: start at login

public enum LoginItemState: Equatable, Sendable {
    case off
    case on
    /// Turned on, and waiting for the person to allow it in System Settings > Login Items.
    case needsApproval
    /// The system could not find the app (for example when it is run from a build folder).
    case unavailable
}

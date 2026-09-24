import AppKit
import Observation
import WitnessMacCore

/// A development build (`swift build`, `swift run`) or the released app.
enum AppBuild {
    static var isDevelopment: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }
}

/// What the app reads and talks to. `live()` is the real Mac; debug snapshots use made-up
/// services so they never read real settings, the Keychain, Messages or Contacts.
struct AppServices {
    var configuration: AppLaunchConfiguration
    var transport: any HTTPTransport
    var contacts: CachedContactsResolver
    var contactsAccess: @Sendable () -> ContactsAccess
    var checkFullDiskAccess: @Sendable (URL) -> FullDiskAccessState
    var bundledLexicon: URL?

    /// A release build ignores its environment (see `AppLaunchConfiguration`).
    @MainActor
    static func live() -> AppServices {
        AppServices(
            configuration: AppLaunchConfiguration(
                processEnvironment: ProcessInfo.processInfo.environment,
                isDevelopmentBuild: AppBuild.isDevelopment
            ),
            transport: URLSessionTransport(),
            contacts: SystemContacts.resolver(),
            contactsAccess: { SystemContacts.access },
            checkFullDiskAccess: { FullDiskAccess.check(url: $0) },
            bundledLexicon: Bundle.main.url(forResource: "lexicon", withExtension: "json")
        )
    }
}

/// Everything the menu-bar panel and the setup window show, and the actions they take.
/// The background work lives in `CollectorEngine`; this only reflects it and forwards to it.
@MainActor
@Observable
final class AppModel {
    // MARK: Engine state

    private(set) var status = EngineStatus()
    private(set) var appState = AppState()

    // MARK: Setup window state

    /// Set while the setup window is open.
    private(set) var flow: SetupFlow?
    var serverAddress = ServerConnector.defaultAddress
    /// The key being pasted. Cleared as soon as it is saved in the Keychain.
    var serverKey = ""
    private(set) var serverState: ServerCheckState = .idle
    private(set) var hasSavedKey = false
    /// The saved key was saved for the saved address (so it is the one sent to).
    private(set) var keyMatchesAddress = false
    private(set) var fullDiskAccess: FullDiskAccessState = .denied
    private(set) var fullDiskAccessPhase: FullDiskAccessPhase = .waiting
    private(set) var contactsAccess: ContactsAccess = .notDetermined
    private(set) var loginItem: LoginItemState = .off
    /// The first check has happened, so the lookback no longer changes anything.
    private(set) var hasStartedChecking = false

    // MARK: Collaborators

    let paths: WitnessPaths
    let engine: CollectorEngine
    let connector: ServerConnector
    private let contacts: CachedContactsResolver
    private let services: AppServices
    private let window = SetupWindowController()
    @ObservationIgnored private var updatesTask: Task<Void, Never>?
    @ObservationIgnored private var accessPoll: Task<Void, Never>?
    @ObservationIgnored private var fullDiskAccessWatch = FullDiskAccessWatch()

    init(services: AppServices) {
        let configuration = services.configuration
        let paths = configuration.paths
        let contacts = services.contacts
        let contactsAccess = services.contactsAccess
        let bundledLexicon = services.bundledLexicon
        self.services = services
        self.paths = paths
        self.contacts = contacts
        connector = ServerConnector(
            paths: paths,
            tokenStore: configuration.tokenStore,
            transport: services.transport,
            allowLocalHTTP: configuration.allowsLocalHTTP
        )
        engine = CollectorEngine(environment: EngineEnvironment(
            paths: paths,
            tokenStore: configuration.tokenStore,
            transport: services.transport,
            // The copy inside Witness.app; only a development build looks anywhere else.
            lexiconURL: { configuration.lexiconURL(bundled: bundledLexicon) },
            checkFullDiskAccess: services.checkFullDiskAccess,
            names: { contactsAccess() == .authorized ? contacts : nil },
            allowLocalHTTP: configuration.allowsLocalHTTP
        ))
        window.onClose = { [weak self] in self?.setupWindowClosed() }
    }

    // MARK: - Launch

    func launch() {
        updatesTask = Task { [weak self, engine] in
            for await status in await engine.updates() {
                self?.status = status
            }
        }
        Task {
            await engine.start()
            appState = await engine.state
            refreshChecks()
            if !appState.setup.isFinished { openSetup(mode: .firstRun) }
        }
    }

    func shutdown() {
        updatesTask?.cancel()
        accessPoll?.cancel()
        Task { [engine] in await engine.stop() }
    }

    // MARK: - Menu bar

    var menuBarSymbol: String {
        status.pauseReason == nil ? "quote.opening" : "pause.circle"
    }

    var isPaused: Bool { status.pauseReason != nil }

    var canCheckNow: Bool {
        switch status.activity {
        case .watching: true
        case .paused(let reason): reason == .fullDiskAccess
        case .checking, .waitingForSetup: false
        }
    }

    /// The setup step that fixes the current pause, if one does.
    var fixStep: SetupStep? {
        switch status.pauseReason {
        case .keyRefused: .server
        case .fullDiskAccess: .fullDiskAccess
        case .byPerson, nil:
            switch status.connection {
            case .notSetUp: appState.setup.isFinished ? .server : nil
            case .keyForOtherAddress: .server
            default: nil
            }
        }
    }

    func panelOpened() {
        Task { [engine] in await engine.refreshFullDiskAccess() }
    }

    func checkNow() {
        Task { [engine] in await engine.checkNow() }
    }

    func togglePause() {
        Task { [engine] in
            if await engine.status.pauseReason != nil {
                await engine.resume()
            } else {
                await engine.pause()
            }
        }
    }

    func openWitness() {
        Links.open(Links.app(server: connector.savedAddress()))
    }

    func quit() {
        NSApp.terminate(nil)
    }

    // MARK: - Setup window

    func openSetup(mode: SetupFlow.Mode, at step: SetupStep? = nil) {
        if flow != nil {
            if let step { go(to: step) }
            window.bringToFront()
            return
        }
        flow = SetupFlow(progress: appState.setup, mode: mode, startAt: step)
        serverAddress = connector.savedAddress() ?? ServerConnector.defaultAddress
        serverKey = ""
        serverState = .idle
        refreshChecks()
        stepChanged()
        window.show(SetupView(model: self), settings: mode == .settings)
    }

    func closeSetup() {
        window.close()
    }

    private func setupWindowClosed() {
        accessPoll?.cancel()
        accessPoll = nil
        serverKey = ""
        guard var flow else { return }
        flow.close(now: Date())
        self.flow = nil
        saveProgress(flow.progress)
    }

    func continueStep() {
        guard var flow else { return }
        flow.complete(now: Date())
        self.flow = flow
        saveProgress(flow.progress)
        stepChanged()
    }

    func skipStep() {
        guard var flow else { return }
        flow.skip(now: Date())
        self.flow = flow
        saveProgress(flow.progress)
        stepChanged()
    }

    func back() {
        flow?.back()
        stepChanged()
    }

    func go(to step: SetupStep) {
        flow?.go(to: step)
        stepChanged()
    }

    /// Whether the current step is already satisfied, so Continue can mark it done.
    func isSatisfied(_ step: SetupStep) -> Bool {
        switch step {
        case .server: keyMatchesAddress
        case .fullDiskAccess: fullDiskAccess == .granted
        case .names: appState.namesEnabled && contactsAccess == .authorized
        case .startAtLogin, .lookback: true
        }
    }

    private func stepChanged() {
        accessPoll?.cancel()
        accessPoll = nil
        if flow?.currentStep == .fullDiskAccess { startAccessPolling() }
        if flow?.currentStep == .startAtLogin { loginItem = LoginItem.state }
        if flow?.currentStep == .lookback {
            hasStartedChecking = FileManager.default.fileExists(atPath: paths.cursorFile.path)
        }
    }

    private func saveProgress(_ progress: SetupProgress) {
        appState.setup = progress
        Task { [engine] in await engine.update { $0.setup = progress } }
    }

    private func refreshChecks() {
        refreshKeyState()
        fullDiskAccess = services.checkFullDiskAccess(paths.messagesDatabase)
        fullDiskAccessPhase = fullDiskAccessWatch.phase(for: fullDiskAccess, now: Date())
        contactsAccess = services.contactsAccess()
        loginItem = LoginItem.state
    }

    private func refreshKeyState() {
        hasSavedKey = connector.hasSavedKey()
        keyMatchesAddress = connector.hasKeyForSavedAddress()
    }

    // MARK: - Step 1: server

    func connect() {
        serverState = .checking
        let address = serverAddress
        let key = serverKey
        Task {
            let result = await connector.connect(address: address, key: key)
            serverState = result
            if result.isConnected {
                serverKey = ""
                refreshKeyState()
                serverAddress = connector.savedAddress() ?? address
                flow?.markDone(.server)
                if let progress = flow?.progress { saveProgress(progress) }
                await engine.connectionChanged()
            }
        }
    }

    func removeKey() {
        do {
            try connector.removeKey()
            serverState = .idle
        } catch {
            serverState = .problem(.couldNotSave(String(describing: error)))
        }
        refreshKeyState()
        Task { [engine] in await engine.connectionChanged() }
    }

    func openMakeKey() {
        Links.open(Links.makeKey(server: serverAddress))
    }

    // MARK: - Step 2: Full Disk Access

    func openFullDiskAccessSettings() {
        fullDiskAccessWatch.openedSettings(at: Date())
        Links.open(Links.fullDiskAccessSettings)
    }

    func relaunch() {
        AppLifecycle.relaunch()
    }

    /// Checks once a second while the step is on screen, and shows the check mark the
    /// moment access works.
    private func startAccessPolling() {
        accessPoll = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let wasGranted = self.fullDiskAccess == .granted
                self.fullDiskAccess = self.services.checkFullDiskAccess(self.paths.messagesDatabase)
                self.fullDiskAccessPhase = self.fullDiskAccessWatch.phase(for: self.fullDiskAccess, now: Date())
                if self.fullDiskAccess == .granted, !wasGranted {
                    self.flow?.markDone(.fullDiskAccess)
                    if let progress = self.flow?.progress { self.saveProgress(progress) }
                    await self.engine.refreshFullDiskAccess()
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    // MARK: - Step 3: names

    var canAskForContacts: Bool { AppLifecycle.canAskForContacts }

    func allowContacts() {
        Task {
            contactsAccess = await SystemContacts.requestAccess()
            if contactsAccess == .authorized { setNames(true) }
        }
    }

    func setNames(_ enabled: Bool) {
        appState.namesEnabled = enabled
        if enabled, contactsAccess == .authorized { flow?.markDone(.names) }
        let progress = flow?.progress
        Task { [engine, contacts] in
            // The engine's switch first: from then on no message gets a name and Contacts
            // is not read, even in a check that is already under way. Then drop the copy.
            await engine.update { state in
                state.namesEnabled = enabled
                if let progress { state.setup = progress }
            }
            contacts.invalidate()
        }
    }

    func openContactsSettings() {
        Links.open(Links.contactsSettings)
    }

    // MARK: - Step 4: start at login

    func setStartAtLogin(_ on: Bool) {
        loginItem = LoginItem.set(on)
    }

    func openLoginItemsSettings() {
        LoginItem.openSystemSettings()
    }

    // MARK: - Step 5: lookback

    func setLookback(_ days: Int) {
        appState.lookbackDays = days
        Task { [engine] in await engine.update { $0.lookbackDays = days } }
    }

    #if DEBUG
    // For `Snapshots` only: made-up states, never real data.

    func showSampleStatus(_ sample: EngineStatus, setupFinished: Bool) {
        status = sample
        appState.setup = setupFinished ? SetupProgress(finishedAt: 1) : SetupProgress()
    }

    func showClosingScreen() {
        flow?.close(now: Date())
    }

    var setupContentView: NSView? { window.contentView }
    #endif
}

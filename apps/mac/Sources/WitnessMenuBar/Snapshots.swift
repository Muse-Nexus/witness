#if DEBUG
import AppKit
import SwiftUI
import WitnessMacCore

/// Development builds only: `WITNESS_SNAPSHOT_DIR=<folder> .build/debug/WitnessMenuBar`
/// draws the status panel and every setup screen to PNG files and quits. It draws the
/// app's own views (no screen recording), with a made-up status, so screenshots for docs
/// never show anyone's real data.
///
/// It runs on made-up services: a scratch folder it creates (never the real
/// `~/Library/Application Support/Witness`, whatever `WITNESS_SUPPORT_DIR` says), a key
/// store in memory, and fixed Full Disk Access and Contacts answers. Closing the setup
/// window during the run therefore cannot mark the real setup finished. Not compiled into
/// release builds.
@MainActor
struct Snapshots {
    static let variable = "WITNESS_SNAPSHOT_DIR"

    let onlyStep: String?
    let directory: URL
    let scratch: URL
    let services: AppServices

    /// Nil unless `WITNESS_SNAPSHOT_DIR` is set.
    init?(environment: [String: String]) {
        guard let directory = environment[Self.variable], !directory.isEmpty else { return nil }
        self.directory = URL(fileURLWithPath: directory, isDirectory: true)
        onlyStep = environment["WITNESS_SNAPSHOT_STEP"]
        scratch = FileManager.default.temporaryDirectory
            .appendingPathComponent("witness-snapshots-\(UUID().uuidString)", isDirectory: true)
        let paths = WitnessPaths(
            supportDirectory: scratch.appendingPathComponent("Witness", isDirectory: true),
            messagesDatabase: scratch.appendingPathComponent("Messages/chat.db")
        )
        services = AppServices(
            configuration: AppLaunchConfiguration(isDevelopmentBuild: true, paths: paths, tokenStore: InMemoryTokenStore()),
            transport: OfflineTransport(),
            contacts: CachedContactsResolver(notificationCenter: NotificationCenter(), isAllowed: { false }, load: { [] }),
            contactsAccess: { .notDetermined },
            checkFullDiskAccess: { _ in .denied },
            bundledLexicon: nil
        )
    }

    func run(model: AppModel) {
        Task { @MainActor in
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? await Task.sleep(nanoseconds: 500_000_000)

            // One process per screen also avoids stale SwiftUI drawing caches in AppKit
            // exports. Still the same fake services, and never the live launch path.
            if let onlyStep {
                if let step = SetupStep(rawValue: onlyStep) {
                    model.openSetup(mode: .firstRun, at: step)
                } else if onlyStep == "done" {
                    model.showSampleStatus(EngineStatus(), setupFinished: true)
                    model.openSetup(mode: .firstRun)
                } else {
                    NSApp.terminate(nil)
                    return
                }
                try? await Task.sleep(nanoseconds: 600_000_000)
                writeSetup(model, name: "setup-\(onlyStep)")
                model.closeSetup()
                try? FileManager.default.removeItem(at: scratch)
                NSApp.terminate(nil)
                return
            }

            let samples: [(String, EngineStatus, Bool)] = [
                ("panel-watching", EngineStatus(
                    connection: .connected(host: "witness.example.com"), fullDiskAccess: .granted,
                    activity: .watching, lastCheck: Date().addingTimeInterval(-240)
                ), true),
                ("panel-key-refused", EngineStatus(
                    connection: .keyRefused(host: "witness.example.com"), fullDiskAccess: .granted,
                    activity: .paused(.keyRefused), lastCheck: Date().addingTimeInterval(-3_600)
                ), true),
                ("panel-looking-back", EngineStatus(
                    connection: .connected(host: "witness.example.com"), fullDiskAccess: .granted,
                    activity: .watching, lastCheck: Date().addingTimeInterval(-30), lookingBack: true
                ), true),
                ("panel-first-run", EngineStatus(), false),
            ]
            for (name, status, setupFinished) in samples {
                model.showSampleStatus(status, setupFinished: setupFinished)
                write(NSHostingView(rootView: StatusPanel(model: model)), name: name)
            }

            for step in SetupStep.allCases {
                model.openSetup(mode: .firstRun, at: step)
                try? await Task.sleep(nanoseconds: 400_000_000)
                writeSetup(model, name: "setup-\(step.rawValue)")
                model.closeSetup()
            }
            model.openSetup(mode: .firstRun)
            model.showClosingScreen()
            model.closeSetup()
            model.openSetup(mode: .firstRun)
            try? await Task.sleep(nanoseconds: 400_000_000)
            writeSetup(model, name: "setup-done")
            model.closeSetup()

            model.openSetup(mode: .settings, at: .names)
            try? await Task.sleep(nanoseconds: 400_000_000)
            writeSetup(model, name: "settings-names")
            model.closeSetup()

            try? await Task.sleep(nanoseconds: 200_000_000)
            try? FileManager.default.removeItem(at: scratch)
            print("Snapshots written to \(directory.path)")
            NSApp.terminate(nil)
        }
    }

    private func writeSetup(_ model: AppModel, name: String) {
        if let view = model.setupContentView {
            view.displayIfNeeded()
            let geometry: [String: Any] = ["viewWidth": view.bounds.width, "viewHeight": view.bounds.height,
                "windowWidth": view.window?.frame.width ?? 0, "windowHeight": view.window?.frame.height ?? 0,
                "syntheticVisibleSize": ProcessInfo.processInfo.environment["WITNESS_SNAPSHOT_VISIBLE_SIZE"] ?? "actual-screen-metadata"]
            try? JSONSerialization.data(withJSONObject: geometry, options: [.prettyPrinted, .sortedKeys])
                .write(to: directory.appendingPathComponent("\(name)-geometry.json"))
            write(view, name: name)
        }
    }

    private func write(_ view: NSView, name: String) {
        if view.frame.isEmpty { view.frame = NSRect(origin: .zero, size: view.fittingSize) }
        view.layoutSubtreeIfNeeded()
        func redraw(_ node: NSView) {
            node.needsDisplay = true
            for child in node.subviews { redraw(child) }
        }
        redraw(view)
        view.display()
        try? view.dataWithPDF(inside: view.bounds).write(to: directory.appendingPathComponent("\(name).pdf"))
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: directory.appendingPathComponent("\(name).png"))
    }
}

/// Answers every request as if the Mac were offline, so snapshot mode sends nothing.
private struct OfflineTransport: HTTPTransport {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        throw URLError(.notConnectedToInternet)
    }
}
#endif

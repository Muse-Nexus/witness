#if DEBUG
import AppKit
import SwiftUI
import WitnessMacCore

/// Development builds only: `WITNESS_SNAPSHOT_DIR=<folder> WITNESS_SUPPORT_DIR=<scratch>
/// .build/debug/WitnessMenuBar` draws the status panel and every setup screen to PNG files
/// and quits. It draws the app's own views (no screen recording), with a made-up status, so
/// screenshots for docs never show anyone's real data. Not compiled into release builds.
@MainActor
enum Snapshots {
    static let variable = "WITNESS_SNAPSHOT_DIR"

    static func run(model: AppModel, directory: URL) {
        Task { @MainActor in
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? await Task.sleep(nanoseconds: 500_000_000)

            let samples: [(String, EngineStatus)] = [
                ("panel-watching", EngineStatus(
                    connection: .connected(host: "witness.example.com"), fullDiskAccess: .granted,
                    activity: .watching, lastCheck: Date().addingTimeInterval(-240), sentToday: 1, sentThisWeek: 4
                )),
                ("panel-key-refused", EngineStatus(
                    connection: .keyRefused(host: "witness.example.com"), fullDiskAccess: .granted,
                    activity: .paused(.keyRefused), lastCheck: Date().addingTimeInterval(-3_600), sentToday: 0, sentThisWeek: 2
                )),
                ("panel-first-run", EngineStatus()),
            ]
            for (name, status) in samples {
                model.showSampleStatus(status)
                write(NSHostingView(rootView: StatusPanel(model: model)), name: name, in: directory)
            }

            model.openSetup(mode: .firstRun)
            for step in SetupStep.allCases {
                model.go(to: step)
                try? await Task.sleep(nanoseconds: 400_000_000)
                if let view = model.setupContentView { write(view, name: "setup-\(step.rawValue)", in: directory) }
            }
            model.showClosingScreen()
            try? await Task.sleep(nanoseconds: 400_000_000)
            if let view = model.setupContentView { write(view, name: "setup-done", in: directory) }
            model.closeSetup()

            model.openSetup(mode: .settings, at: .names)
            try? await Task.sleep(nanoseconds: 400_000_000)
            if let view = model.setupContentView { write(view, name: "settings-names", in: directory) }
            model.closeSetup()

            print("Snapshots written to \(directory.path)")
            NSApp.terminate(nil)
        }
    }

    private static func write(_ view: NSView, name: String, in directory: URL) {
        if view.frame.isEmpty { view.frame = NSRect(origin: .zero, size: view.fittingSize) }
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: directory.appendingPathComponent("\(name).png"))
    }
}
#endif

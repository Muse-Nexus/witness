import AppKit
import SwiftUI
import WitnessMacCore

/// Witness for Mac: a menu-bar app (no Dock icon) that watches Messages and sends on only
/// the kind messages. The work is done by `CollectorEngine` in WitnessMacCore.
@main
struct WitnessMenuBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        MenuBarExtra {
            StatusPanel(model: appDelegate.model)
        } label: {
            MenuBarLabel(model: appDelegate.model)
        }
        .menuBarExtraStyle(.window)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = AppModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Info.plist sets LSUIElement for the app bundle; this covers a bare development build.
        NSApp.setActivationPolicy(.accessory)
        AppLifecycle.ensureEditMenu()
        #if DEBUG
        if let directory = ProcessInfo.processInfo.environment[Snapshots.variable], !directory.isEmpty {
            Snapshots.run(model: model, directory: URL(fileURLWithPath: directory, isDirectory: true))
            return
        }
        #endif
        model.launch()
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.shutdown()
    }
}

struct MenuBarLabel: View {
    let model: AppModel

    var body: some View {
        Image(systemName: model.menuBarSymbol)
            .accessibilityLabel(model.isPaused ? "Witness, paused" : "Witness")
    }
}

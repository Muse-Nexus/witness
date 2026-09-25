import AppKit
import SwiftUI
import WitnessMacCore

/// Witness for Mac: a menu-bar app (no Dock icon) that watches Messages and sends on the
/// messages that might be kind; the server keeps the kind ones. The work is done by
/// `CollectorEngine` in WitnessMacCore.
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
    let model: AppModel
    #if DEBUG
    private let snapshots: Snapshots?
    #endif

    override init() {
        #if DEBUG
        // Snapshot mode gets made-up services: a scratch folder, no key, no real Messages
        // or Contacts, so it can never change the real settings.
        let snapshots = Snapshots(environment: ProcessInfo.processInfo.environment)
        self.snapshots = snapshots
        model = AppModel(services: snapshots?.services ?? .live())
        #else
        model = AppModel(services: .live())
        #endif
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Info.plist sets LSUIElement for the app bundle; this covers a bare development build.
        NSApp.setActivationPolicy(.accessory)
        AppLifecycle.ensureEditMenu()
        #if DEBUG
        if let snapshots {
            snapshots.run(model: model)
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

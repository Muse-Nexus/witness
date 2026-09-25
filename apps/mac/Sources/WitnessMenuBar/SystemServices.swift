import AppKit
import ServiceManagement
import WitnessMacCore

/// Start at login through `SMAppService.mainApp` (macOS 13 and later). Off unless the
/// person turns it on.
@MainActor
enum LoginItem {
    static var state: LoginItemState {
        switch SMAppService.mainApp.status {
        case .enabled: .on
        case .requiresApproval: .needsApproval
        case .notRegistered: .off
        case .notFound: .unavailable
        @unknown default: .off
        }
    }

    /// Returns the new state. Registering can leave it waiting for approval in System Settings.
    static func set(_ on: Bool) -> LoginItemState {
        do {
            if on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            // The state below says what actually happened.
        }
        return state
    }

    static func openSystemSettings() {
        SMAppService.openSystemSettingsLoginItems()
    }
}

/// Addresses the app opens.
enum Links {
    static let fullDiskAccessSettings = URL(string: FullDiskAccess.settingsURLString)!
    static let contactsSettings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts")!

    /// The Witness web app for a saved server address, or the hosted one.
    static func app(server: String?) -> URL {
        base(server).appendingPathComponent("app")
    }

    /// Setup > Texts and photos, where a Mac key is made.
    static func makeKey(server: String?) -> URL {
        var components = URLComponents(url: base(server).appendingPathComponent("app/setup"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "step", value: "texts")]
        return components?.url ?? app(server: server)
    }

    private static func base(_ server: String?) -> URL {
        if let server, let url = try? ConfigValidation.normalizedAPIURL(server) { return url }
        return URL(string: ServerConnector.defaultAddress)!
    }

    @MainActor
    static func open(_ url: URL) {
        NSWorkspace.shared.open(url)
    }
}

@MainActor
enum AppLifecycle {
    /// True when running as `Witness.app`, not as a bare binary from a build folder.
    static var isBundled: Bool {
        Bundle.main.bundleURL.pathExtension == "app"
    }

    /// Contacts can only be asked for from the app bundle, which carries the usage description.
    static var canAskForContacts: Bool {
        Bundle.main.object(forInfoDictionaryKey: "NSContactsUsageDescription") != nil
    }

    /// Quits and opens the app again, so a new Full Disk Access grant takes effect.
    static func relaunch() {
        guard isBundled else {
            NSApp.terminate(nil)
            return
        }
        let pid = ProcessInfo.processInfo.processIdentifier
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        // Wait for this process to exit, then open the bundle again. The path is passed as $0.
        process.arguments = [
            "-c", "while /bin/kill -0 \(pid) 2>/dev/null; do /bin/sleep 0.2; done; /usr/bin/open \"$0\"",
            Bundle.main.bundlePath,
        ]
        do {
            try process.run()
        } catch {
            return
        }
        NSApp.terminate(nil)
    }

    /// An agent app has no visible menu bar, but paste (⌘V) still needs an Edit menu to
    /// route through. SwiftUI normally provides one; this adds it if it is missing.
    static func ensureEditMenu() {
        let mainMenu = NSApp.mainMenu ?? NSMenu()
        if mainMenu.items.contains(where: { $0.submenu?.title == "Edit" }) { return }
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let item = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
        item.submenu = edit
        mainMenu.addItem(item)
        NSApp.mainMenu = mainMenu
    }
}

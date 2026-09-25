import Foundation
import Testing
@testable import WitnessMacCore

/// Checks the files scripts/build-app.sh turns into Witness.app, without building it.
@Suite("App bundle")
struct AppBundleTests {
    static var macDirectory: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // WitnessMacCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // apps/mac
    }

    static func plist(_ name: String) throws -> [String: Any] {
        let data = try Data(contentsOf: macDirectory.appendingPathComponent("App/\(name)"))
        return try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    @Test("Info.plist makes an agent app with the right id and version")
    func infoPlist() throws {
        let info = try Self.plist("Info.plist")
        #expect(info["CFBundleIdentifier"] as? String == "studio.musenexus.witness.mac")
        #expect(info["CFBundleShortVersionString"] as? String == WitnessMacVersion.current)
        #expect(WitnessMacVersion.current == "0.2.0")
        #expect(info["CFBundleExecutable"] as? String == "Witness")
        #expect(info["CFBundlePackageType"] as? String == "APPL")
        #expect(info["LSUIElement"] as? Bool == true, "menu bar only, no Dock icon")
        #expect(info["LSMinimumSystemVersion"] as? String == "14.0")
        #expect(info["CFBundleIconFile"] as? String == "AppIcon")
    }

    @Test("Asks for Contacts in plain words, and not for Photos in this version")
    func usageDescriptions() throws {
        let info = try Self.plist("Info.plist")
        let contacts = try #require(info["NSContactsUsageDescription"] as? String)
        #expect(!contacts.isEmpty)
        #expect(!contacts.contains("!"))
        #expect(contacts.contains("stay on this Mac"))
        #expect(info["NSPhotoLibraryUsageDescription"] == nil, "Photos is M3")
    }

    @Test("Hardened runtime entitlements: not sandboxed, Contacts only")
    func entitlements() throws {
        let entitlements = try Self.plist("Witness.entitlements")
        #expect(entitlements["com.apple.security.app-sandbox"] == nil)
        #expect(entitlements["com.apple.security.get-task-allow"] == nil)
        #expect(entitlements["com.apple.security.personal-information.addressbook"] as? Bool == true)
        #expect(entitlements.count == 1)
    }

    @Test("build-app.sh --lint passes")
    func scriptLint() throws {
        let process = Process()
        process.executableURL = Self.macDirectory.appendingPathComponent("scripts/build-app.sh")
        process.arguments = ["--lint"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        process.waitUntilExit()
        #expect(process.terminationStatus == 0, "\(text)")
        #expect(text.contains("look right"))
    }
}

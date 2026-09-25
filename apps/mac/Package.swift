// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "WitnessMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "WitnessMacCore", targets: ["WitnessMacCore"]),
        .executable(name: "witness-mac", targets: ["witness-mac"]),
        // The menu-bar app. scripts/build-app.sh wraps it in Witness.app.
        .executable(name: "WitnessMenuBar", targets: ["WitnessMenuBar"]),
    ],
    targets: [
        // The system SQLite that ships with macOS; no third-party dependency.
        .systemLibrary(name: "CSQLite"),
        .target(name: "WitnessMacCore", dependencies: ["CSQLite"]),
        .executableTarget(name: "witness-mac", dependencies: ["WitnessMacCore"]),
        .executableTarget(name: "WitnessMenuBar", dependencies: ["WitnessMacCore"]),
        .testTarget(
            name: "WitnessMacCoreTests",
            // CSQLite is used directly to build synthetic chat.db fixtures, so the
            // library itself never needs a writable connection.
            dependencies: ["WitnessMacCore", "CSQLite"],
            exclude: ["Fixtures"]
        ),
    ]
)

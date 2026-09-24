import Foundation
import Testing
@testable import WitnessMacCore

/// The Mac prefilter must decide exactly like the TypeScript reference
/// (`prefilter()` in packages/detector/src/filters.ts) with the real
/// lexicon.json. The cases are generated from the detector's synthetic corpus by
/// `bun run parity` in packages/detector, which writes
/// packages/detector/test/fixtures/prefilter-parity.json; the detector's own
/// tests fail while that file is stale.
@Suite("Prefilter parity with the TypeScript reference")
struct PrefilterParityTests {
    struct ParityCase: Decodable, Sendable, CustomTestStringConvertible {
        var id: String
        var text: String
        var handle: String?
        var expectPass: Bool
        var excludedBy: String?

        var testDescription: String { id }
    }

    static var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // WitnessMacCoreTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // apps/mac
            .deletingLastPathComponent() // apps
            .deletingLastPathComponent() // repository root
    }

    static var lexiconURL: URL { repositoryRoot.appendingPathComponent("packages/detector/lexicon.json") }
    static var fixtureURL: URL { repositoryRoot.appendingPathComponent("packages/detector/test/fixtures/prefilter-parity.json") }

    static func cases() throws -> [ParityCase] {
        try JSONDecoder().decode([ParityCase].self, from: Data(contentsOf: fixtureURL))
    }

    @Test("Every regex in the real lexicon compiles under NSRegularExpression")
    func realLexiconCompiles() throws {
        let prefilter = try Prefilter.load(from: Self.lexiconURL)
        #expect(prefilter.ruleCounts.cues > 100)
        #expect(prefilter.ruleCounts.exclusions > 5)
    }

    @Test("The fixture covers both outcomes")
    func fixtureShape() throws {
        let cases = try Self.cases()
        #expect(cases.count > 150)
        #expect(cases.filter(\.expectPass).count > 40)
        #expect(cases.filter { !$0.expectPass }.count > 40)
    }

    @Test("Same pass or stay decision as the TypeScript prefilter, for every case")
    func parity() throws {
        let prefilter = try Prefilter.load(from: Self.lexiconURL)
        var mismatches: [String] = []
        for item in try Self.cases() {
            let decision = prefilter.evaluate(text: item.text, handle: item.handle)
            let passes: Bool
            switch decision {
            case .candidate: passes = true
            case .excluded, .noCue: passes = false
            }
            if passes != item.expectPass {
                mismatches.append("\(item.id): TypeScript \(item.expectPass ? "passes" : "keeps it (\(item.excludedBy ?? "no cue"))"), Swift \(decision)")
            }
        }
        #expect(mismatches.isEmpty, "\(mismatches.count) differ:\n\(mismatches.joined(separator: "\n"))")
    }
}

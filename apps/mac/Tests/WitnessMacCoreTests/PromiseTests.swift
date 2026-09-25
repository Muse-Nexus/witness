import Foundation
import Testing
@testable import WitnessMacCore

/// The words that say what Witness for Mac does, held to what it does. It sends every message
/// that might be kind (it passed the prefilter), with the sender's name when names are on, and
/// the server decides what to keep. Its menu shows states only.
@Suite("What the words promise")
struct PromiseTests {
    static var repository: URL {
        AppBundleTests.macDirectory
            .deletingLastPathComponent() // apps
            .deletingLastPathComponent() // the repository
    }

    /// A Markdown file with its lines joined, so a phrase broken across lines reads as one.
    static func prose(_ path: String) throws -> String {
        let text = try String(contentsOf: repository.appendingPathComponent(path), encoding: .utf8)
        return text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    /// Ways of saying that only kind messages leave the Mac, or that a name goes only with a kept one.
    static let overclaims = [
        "sends on only the kind", "only kind messages leave", "only the kind messages in that time",
        "who sent a kept message goes", "the rest stay on your Mac",
    ]

    @Test("The setup says that messages that might be kind leave the Mac, and the server keeps the kind ones")
    func setupCopy() {
        #expect(SetupCopy.messagesAccess.contains("Only messages that might be kind leave this Mac"))
        #expect(SetupCopy.lookback.contains("sends the ones that might be kind"))
        #expect(SetupCopy.names.contains("goes with each message Witness sends"))
        for sentence in SetupCopy.all {
            for claim in Self.overclaims {
                #expect(!sentence.localizedCaseInsensitiveContains(claim), "\(sentence)")
            }
        }
    }

    @Test("The guide and the README say the same", arguments: ["docs/guides/mac.md", "apps/mac/README.md"])
    func docs(path: String) throws {
        let text = try Self.prose(path)
        for claim in Self.overclaims {
            #expect(!text.localizedCaseInsensitiveContains(claim), "\(path): \(claim)")
        }
        #expect(text.contains("might be kind"), "\(path)")
    }

    @Test("The roadmap's Mac milestone matches the app: a Mac key, and a menu with states only")
    func roadmap() throws {
        let roadmap = try Self.prose("ROADMAP.md")
        let start = try #require(roadmap.range(of: "## M2"))
        let milestone = roadmap[start.upperBound...].components(separatedBy: " ## ").first ?? ""
        #expect(milestone.contains("paste a Mac key"))
        #expect(!milestone.contains("phone key"))
        #expect(milestone.contains("states only"))
        #expect(!milestone.localizedCaseInsensitiveContains("counts"), "the menu keeps no tally (docs/SAFETY.md §2, §5, §6)")
    }
}

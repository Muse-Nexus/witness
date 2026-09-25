import Foundation
import Testing
@testable import WitnessMacCore

/// The words that say what Witness for Mac does, held to what it does. It sends every message
/// that might be kind (it passed the prefilter), each with the sender's phone number or email,
/// and their name when names are on, and the server decides what to keep. Its menu shows states
/// only. The notes of each published release are kept in `apps/mac/release-notes` and held to
/// the same words.
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
        "who sent a kept message goes", "the rest stay on your Mac", "sends only those",
        "keeps the kind texts people send you, from Messages",
    ]

    /// The release notes and docs that say what leaves the Mac.
    static let releaseNotes = ["apps/mac/release-notes/0.2.0.md"]
    static let whatLeaves = releaseNotes + ["docs/guides/mac.md", "apps/mac/README.md", "docs/PRIVACY.md"]

    @Test("The setup says that messages that might be kind leave the Mac, and the server keeps the kind ones")
    func setupCopy() {
        #expect(SetupCopy.messagesAccess.contains("Only messages that might be kind leave this Mac"))
        #expect(SetupCopy.lookback.contains("sends the ones that might be kind"))
        #expect(SetupCopy.names.contains("Each message Witness sends carries the sender’s phone number or email"))
        #expect(!SetupCopy.names.contains("Only the sender’s name goes"), "the handle goes too")
        for sentence in SetupCopy.all {
            for claim in Self.overclaims {
                #expect(!sentence.localizedCaseInsensitiveContains(claim), "\(sentence)")
            }
        }
    }

    @Test("The guide, the README and the release notes say the same", arguments: ["docs/guides/mac.md", "apps/mac/README.md"] + releaseNotes)
    func docs(path: String) throws {
        let text = try Self.prose(path)
        for claim in Self.overclaims {
            #expect(!text.localizedCaseInsensitiveContains(claim), "\(path): \(claim)")
        }
        #expect(text.contains("might be kind"), "\(path)")
    }

    @Test("What leaves the Mac includes the sender's phone number or email, which always goes", arguments: whatLeaves)
    func senderHandle(path: String) throws {
        let text = try Self.prose(path)
        #expect(text.contains("phone number or email"), "\(path)")
    }

    @Test("The release notes say what the scanner sends with each message")
    func releaseNoteDetails() throws {
        for path in Self.releaseNotes {
            let text = try Self.prose(path)
            let start = try #require(text.range(of: "What leaves your Mac"), "\(path)")
            let section = String(text[start.upperBound...].prefix(700))
            for detail in ["phone number or email", "when it was sent", "iMessage, SMS or RCS", "names on"] {
                #expect(section.contains(detail), "\(path): \(detail)")
            }
        }
    }

    @Test("The roadmap and the spec know the download is published")
    func published() throws {
        let roadmap = try Self.prose("ROADMAP.md")
        #expect(!roadmap.contains("(in source)"), "M2 is published, not only in source")
        #expect(!roadmap.localizedCaseInsensitiveContains("Still to come: a published download"))
        let spec = try Self.prose("docs/dev/SPEC.md")
        #expect(!spec.contains("no published Mac download"))
        #expect(!spec.contains("build it and open it"))
        #expect(spec.contains("mac-v0.2.0"))
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

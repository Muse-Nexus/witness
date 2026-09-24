import Foundation

/// The subset of `packages/detector/lexicon.json` (SPEC §6) the Mac prefilter uses.
///
/// The TypeScript detector owns the full schema and the scoring. The Mac only
/// needs the exclusion rules and the positive cues, so every other key
/// (boosters, dampeners, headers, Gmail terms) is ignored when decoding.
public struct Lexicon: Decodable, Equatable, Sendable {
    public struct Phrase: Decodable, Equatable, Sendable {
        public var p: String
        public var w: Double?
    }

    public struct Pattern: Decodable, Equatable, Sendable {
        public var id: String
        public var re: String
        public var w: Double?
    }

    public struct Category: Decodable, Equatable, Sendable {
        public var phrases: [Phrase]
        public var patterns: [Pattern]

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            phrases = try container.decodeIfPresent([Phrase].self, forKey: .phrases) ?? []
            patterns = try container.decodeIfPresent([Pattern].self, forKey: .patterns) ?? []
        }

        private enum CodingKeys: String, CodingKey { case phrases, patterns }
    }

    public struct Exclusions: Decodable, Equatable, Sendable {
        public var senderPatterns: [Pattern]
        public var bodyPatterns: [Pattern]

        public init(from decoder: any Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            senderPatterns = try container.decodeIfPresent([Pattern].self, forKey: .senderPatterns) ?? []
            bodyPatterns = try container.decodeIfPresent([Pattern].self, forKey: .bodyPatterns) ?? []
        }

        init() {
            senderPatterns = []
            bodyPatterns = []
        }

        private enum CodingKeys: String, CodingKey { case senderPatterns, bodyPatterns }
    }

    public var version: Int
    public var categories: [String: Category]
    public var exclusions: Exclusions

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = try container.decode(Int.self, forKey: .version)
        categories = try container.decode([String: Category].self, forKey: .categories)
        exclusions = try container.decodeIfPresent(Exclusions.self, forKey: .exclusions) ?? Exclusions()
    }

    private enum CodingKeys: String, CodingKey { case version, categories, exclusions }

    public static func load(from url: URL) throws -> Lexicon {
        try JSONDecoder().decode(Lexicon.self, from: Data(contentsOf: url))
    }
}

/// Finds `lexicon.json` when no path is given on the command line.
public enum LexiconLocator {
    public static let environmentVariable = "WITNESS_LEXICON"

    /// Where the detector keeps it, relative to the repository root.
    static let repositoryPath = "packages/detector/lexicon.json"

    /// Search order: explicit path, `$WITNESS_LEXICON`, the Witness support
    /// directory, then a source checkout: `packages/detector/lexicon.json` in the
    /// current directory or any folder above it (so it works from the repository
    /// root, `apps/mac`, or anywhere inside), and finally, in a debug build only, the
    /// checkout this binary was built from.
    public static func candidates(
        explicitPath: String?,
        environment: [String: String],
        supportDirectory: URL,
        currentDirectory: URL? = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    ) -> [URL] {
        if let explicitPath {
            return [URL(fileURLWithPath: explicitPath)]
        }
        var urls: [URL] = []
        if let fromEnvironment = environment[environmentVariable], !fromEnvironment.isEmpty {
            urls.append(URL(fileURLWithPath: fromEnvironment))
        }
        urls.append(supportDirectory.appendingPathComponent("lexicon.json"))
        if var directory = currentDirectory?.standardizedFileURL {
            for _ in 0..<8 {
                urls.append(directory.appendingPathComponent(repositoryPath))
                let parent = directory.deletingLastPathComponent()
                if parent.path == directory.path { break }
                directory = parent
            }
        }
        #if DEBUG
        urls.append(sourceTreeLexicon)
        #endif
        return urls
    }

    public static func resolve(
        explicitPath: String?,
        environment: [String: String],
        supportDirectory: URL,
        currentDirectory: URL? = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
    ) -> URL? {
        candidates(explicitPath: explicitPath, environment: environment, supportDirectory: supportDirectory, currentDirectory: currentDirectory)
            .first { FileManager.default.isReadableFile(atPath: $0.path) }
    }

    #if DEBUG
    /// `apps/mac/../../packages/detector/lexicon.json`, located from this source file.
    /// Debug builds only: `#filePath` would put the builder's folders into a release binary.
    static var sourceTreeLexicon: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // WitnessMacCore
            .deletingLastPathComponent() // Sources
            .deletingLastPathComponent() // apps/mac
            .appendingPathComponent("../../packages/detector/lexicon.json")
            .standardizedFileURL
    }
    #endif
}

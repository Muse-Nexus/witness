import Foundation

public enum PrefilterDecision: Equatable, Sendable {
    /// An exclusion rule matched. The message stays on this Mac.
    case excluded(rule: String)
    /// At least one positive cue matched; the message is sent to the server's detector.
    /// Carries the matching category names, never any message text.
    case candidate(categories: [String])
    /// Nothing suggests evidence. The message stays on this Mac.
    case noCue
}

public enum PrefilterError: Error, Equatable, CustomStringConvertible {
    case invalidPattern(id: String)

    public var description: String {
        switch self {
        case .invalidPattern(let id): "lexicon.json has a pattern that does not compile: \(id)"
        }
    }
}

/// Decides, on the Mac, whether a message is worth sending to Witness at all.
///
/// This is deliberately generous: it is not the detector. Its job is to keep
/// the ordinary run of messages on the Mac and send only those with some
/// positive cue, so the server's detector can make the real call.
///
/// It mirrors `prefilter()` in `packages/detector/src/filters.ts` for a text
/// message (text plus sender handle), and a shared fixture checks that both
/// reach the same decision (`PrefilterParityTests`):
///
/// 1. Exclude business senders: Apple Business Chat handles (`urn:biz:`),
///    short codes (a handle of at most 6 digits once spaces, `().+-` are
///    removed), and SMS sender names (letters and no `@`).
/// 2. Exclude `exclusions.senderPatterns` (matched against the handle) and
///    `exclusions.bodyPatterns` (matched against the text).
/// 3. Pass if any category phrase or pattern matches.
///
/// Before matching, curly quotes are folded to ASCII. Phrases compile the way
/// `phraseSource()` does (whole words, any whitespace, optional apostrophes,
/// "-" = hyphen, space or nothing), and every regex is translated so that ICU
/// behaves like JavaScript's non-Unicode mode (`JavaScriptRegex`).
public struct Prefilter: Sendable {
    /// Rule id reported for short codes and Business Chat handles.
    public static let businessSenderRule = "builtin.business_sender"
    /// Rule id reported for alphanumeric SMS sender names such as "BANKCO".
    public static let alphanumericSenderRule = "builtin.alphanumeric_sender"

    private let senderExclusions: [CompiledRule]
    private let bodyExclusions: [CompiledRule]
    private let cues: [CompiledRule]

    public init(lexicon: Lexicon) throws {
        senderExclusions = try lexicon.exclusions.senderPatterns.map { try CompiledRule(id: $0.id, javaScriptPattern: $0.re) }
        bodyExclusions = try lexicon.exclusions.bodyPatterns.map { try CompiledRule(id: $0.id, javaScriptPattern: $0.re) }

        var cues: [CompiledRule] = []
        for (category, entry) in lexicon.categories.sorted(by: { $0.key < $1.key }) {
            for phrase in entry.phrases where !phrase.p.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                cues.append(try CompiledRule(id: category, javaScriptPattern: Self.phraseSource(phrase.p), reportedAs: "\(category) phrase \"\(phrase.p)\""))
            }
            for pattern in entry.patterns {
                cues.append(try CompiledRule(id: category, javaScriptPattern: pattern.re, reportedAs: "\(category).\(pattern.id)"))
            }
        }
        self.cues = cues
    }

    public static func load(from url: URL) throws -> Prefilter {
        try Prefilter(lexicon: Lexicon.load(from: url))
    }

    /// Counts for `witness-mac status`: how many rules compiled.
    public var ruleCounts: (cues: Int, exclusions: Int) {
        (cues.count, senderExclusions.count + bodyExclusions.count)
    }

    public func evaluate(text: String, handle: String?) -> PrefilterDecision {
        let trimmedHandle = handle.map(Self.trimJavaScriptWhitespace) ?? ""
        if !trimmedHandle.isEmpty {
            if let rule = Self.builtinSenderRule(trimmedHandle) {
                return .excluded(rule: rule)
            }
            let sender = Self.fold(trimmedHandle)
            if let rule = senderExclusions.first(where: { $0.matches(sender) }) {
                return .excluded(rule: rule.id)
            }
        }

        let folded = Self.fold(text)
        if let rule = bodyExclusions.first(where: { $0.matches(folded) }) {
            return .excluded(rule: rule.id)
        }

        let categories = Set(cues.filter { $0.matches(folded) }.map(\.id))
        return categories.isEmpty ? .noCue : .candidate(categories: categories.sorted())
    }

    // MARK: - Mirrors of the TypeScript reference

    /// `exclusionFor()` in rules.ts, the handle checks: Business Chat, short codes, SMS sender names.
    static func builtinSenderRule(_ handle: String) -> String? {
        if handle.lowercased().hasPrefix("urn:biz:") { return businessSenderRule }
        // JS: handle.replace(/[\s().+-]/g, '') is all ASCII digits and at most 6 of them.
        let digits = handle.unicodeScalars.filter { !isJavaScriptWhitespace($0) && !"().+-".unicodeScalars.contains($0) }
        if !digits.isEmpty, digits.count <= 6, digits.allSatisfy({ ("0"..."9").contains($0) }) {
            return businessSenderRule
        }
        // People have numbers or email addresses; a sender name like "BANKCO" is a business.
        if !handle.contains("@"), handle.unicodeScalars.contains(where: { ("a"..."z").contains($0) || ("A"..."Z").contains($0) }) {
            return alphanumericSenderRule
        }
        return nil
    }

    /// `foldForMatch()` in text.ts: curly apostrophes and quotes become ASCII.
    static func fold(_ text: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\u{2018}", "\u{2019}", "\u{02BC}": scalars.append("'")
            case "\u{201C}", "\u{201D}": scalars.append("\"")
            default: scalars.append(scalar)
            }
        }
        return String(scalars)
    }

    /// `phraseSource()` in lexicon.ts: a literal phrase as a (JavaScript) regex source.
    static func phraseSource(_ phrase: String) -> String {
        // foldPhrase(): trim, lowercase, fold quotes, collapse whitespace.
        let normalized = fold(trimJavaScriptWhitespace(phrase).lowercased())
            .unicodeScalars.split(whereSeparator: isJavaScriptWhitespace)
            .map { String(String.UnicodeScalarView($0)) }
            .joined(separator: " ")
        var body = ""
        for scalar in normalized.unicodeScalars {
            switch scalar {
            case " ": body += #"\s+"#
            case "'": body += "'?"
            case "-": body += #"[\s\-]?"#
            default:
                if #".*+?^${}()|[]\/"#.unicodeScalars.contains(scalar) { body += "\\" }
                body.unicodeScalars.append(scalar)
            }
        }
        func isEdge(_ scalar: Unicode.Scalar?) -> Bool {
            guard let scalar else { return false }
            return ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar) || ("0"..."9").contains(scalar) || scalar == "_"
        }
        let scalars = normalized.unicodeScalars
        return (isEdge(scalars.first) ? #"\b"# : "") + body + (isEdge(scalars.last) ? #"\b"# : "")
    }

    /// JavaScript's `\s` (and `String.prototype.trim`) whitespace set.
    static func isJavaScriptWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: true
        default: false
        }
    }

    static func trimJavaScriptWhitespace(_ text: String) -> String {
        let scalars = Array(text.unicodeScalars)
        guard let start = scalars.firstIndex(where: { !isJavaScriptWhitespace($0) }),
              let end = scalars.lastIndex(where: { !isJavaScriptWhitespace($0) })
        else { return "" }
        return String(String.UnicodeScalarView(scalars[start...end]))
    }
}

/// Translates a lexicon regex (written for JavaScript, flags `gi`, no `u`) so
/// that ICU (`NSRegularExpression`) matches the same strings.
///
/// The lexicon's portable subset (LEXICON.md) already rules out syntax that
/// only one engine has. What remains are shorthands whose meaning differs:
/// in JavaScript without the `u` flag `\b`, `\w` and `\d` are ASCII-only, `.`
/// excludes only `\n \r U+2028 U+2029`, and `$` is the end of the input. ICU
/// makes them Unicode-aware and line-aware, so "Thank youé" would match
/// `\byou\b` in JavaScript and not in ICU. This spells each one out.
enum JavaScriptRegex {
    static let word = "A-Za-z0-9_"
    static let boundary = "(?:(?<=[\(word)])(?![\(word)])|(?<![\(word)])(?=[\(word)]))"
    static let nonBoundary = "(?:(?<=[\(word)])(?=[\(word)])|(?<![\(word)])(?![\(word)]))"

    static func icuPattern(_ source: String) -> String {
        var out = ""
        var inClass = false
        var scalars = source.unicodeScalars.makeIterator()
        while let scalar = scalars.next() {
            if scalar == "\\" {
                guard let next = scalars.next() else {
                    out += "\\"
                    break
                }
                switch (next, inClass) {
                case ("b", false): out += boundary
                case ("B", false): out += nonBoundary
                case ("w", false): out += "[\(word)]"
                case ("W", false): out += "[^\(word)]"
                case ("d", false): out += "[0-9]"
                case ("D", false): out += "[^0-9]"
                case ("w", true): out += word
                case ("d", true): out += "0-9"
                default:
                    out += "\\"
                    out.unicodeScalars.append(next)
                }
                continue
            }
            if inClass {
                if scalar == "]" { inClass = false }
                out.unicodeScalars.append(scalar)
                continue
            }
            switch scalar {
            case "[": inClass = true; out += "["
            case ".": out += #"[^\n\r\u2028\u2029]"#
            case "$": out += #"\z"#
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out
    }
}

/// A compiled case-insensitive rule.
///
/// `NSRegularExpression` is immutable after creation and documented as safe to
/// use from multiple threads, which is what makes the `@unchecked` sound.
struct CompiledRule: @unchecked Sendable {
    let id: String
    private let expression: NSRegularExpression

    /// Compiles a lexicon (JavaScript) pattern for ICU; see `JavaScriptRegex`.
    init(id: String, javaScriptPattern pattern: String, reportedAs errorID: String? = nil) throws {
        self.id = id
        do {
            expression = try NSRegularExpression(pattern: JavaScriptRegex.icuPattern(pattern), options: [.caseInsensitive])
        } catch {
            throw PrefilterError.invalidPattern(id: errorID ?? id)
        }
    }

    func matches(_ text: String) -> Bool {
        expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
    }
}

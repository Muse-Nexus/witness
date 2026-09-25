import Foundation
import Testing
@testable import WitnessMacCore

@Suite("Prefilter")
struct PrefilterTests {
    let prefilter: Prefilter

    init() throws {
        prefilter = try Fixtures.prefilter()
    }

    @Test("Positive cues make a candidate and report their categories")
    func candidates() {
        #expect(prefilter.evaluate(text: "Thank you so much for tonight", handle: "+12065550101")
            == .candidate(categories: ["gratitude"]))
        #expect(prefilter.evaluate(text: "PROUD OF YOU", handle: "+12065550101")
            == .candidate(categories: ["pride"]))
        #expect(prefilter.evaluate(text: "You made my day ❤️", handle: nil)
            == .candidate(categories: ["care", "love"]))
        #expect(prefilter.evaluate(text: "Congrats!!", handle: "friend@example.com")
            == .candidate(categories: ["accomplishment"]))
    }

    @Test("Category patterns match, including curly apostrophes from a phone keyboard")
    func patterns() {
        #expect(prefilter.evaluate(text: "I couldn’t have done it without you", handle: nil)
            == .candidate(categories: ["gratitude"]))
        #expect(prefilter.evaluate(text: "couldnt have made it without you honestly", handle: nil)
            == .candidate(categories: ["gratitude"]))
    }

    @Test("Phrases match whole words only, across any whitespace")
    func wholeWords() {
        #expect(prefilter.evaluate(text: "Can you grab my glove your size?", handle: nil) == .noCue)
        #expect(prefilter.evaluate(text: "thankyou", handle: nil) == .noCue)
        #expect(prefilter.evaluate(text: "Thank   you\nso much", handle: nil) == .candidate(categories: ["gratitude"]))
    }

    @Test("Ordinary messages have no cue")
    func noCue() {
        #expect(prefilter.evaluate(text: "Running late, see you at 6", handle: "+12065550101") == .noCue)
        #expect(prefilter.evaluate(text: "", handle: "+12065550101") == .noCue)
    }

    @Test("Sender exclusions win over positive cues")
    func senderExclusions() {
        #expect(prefilter.evaluate(text: "Thank you for your order", handle: "no-reply@example.com")
            == .excluded(rule: "noreply"))
        #expect(prefilter.evaluate(text: "Thank you for your order", handle: "notifications@example.com")
            == .excluded(rule: "noreply"))
    }

    @Test("Soft exclusion rules never keep a message on the Mac; the server weighs them")
    func softExclusions() {
        #expect(prefilter.evaluate(text: "Thank you so much for the new logo", handle: "info@example.com")
            == .candidate(categories: ["gratitude"]))
        #expect(prefilter.evaluate(text: "So proud of you\nPrivacy Policy", handle: "+12065550101")
            == .candidate(categories: ["pride"]))
        #expect(prefilter.evaluate(text: "Running late", handle: "support@example.com") == .noCue)
    }

    @Test("Short codes and Business Chat handles are excluded", arguments: ["12345", "733", "+123456", "urn:biz:0000-example"])
    func businessSenders(handle: String) {
        #expect(prefilter.evaluate(text: "Thank you so much for shopping", handle: handle)
            == .excluded(rule: Prefilter.businessSenderRule))
    }

    @Test("Full phone numbers are not mistaken for short codes")
    func fullNumbers() {
        #expect(prefilter.evaluate(text: "Thank you", handle: "+12065550101") == .candidate(categories: ["gratitude"]))
        #expect(prefilter.evaluate(text: "Thank you", handle: "2065550101") == .candidate(categories: ["gratitude"]))
    }

    @Test("Body exclusions such as one-time codes")
    func bodyExclusions() {
        #expect(prefilter.evaluate(text: "Thank you! Your code is 123456", handle: "+12065550104")
            == .excluded(rule: "otp"))
        #expect(prefilter.evaluate(text: "Your passcode: 99887766", handle: nil) == .excluded(rule: "otp"))
    }

    @Test("An invalid pattern is reported by id")
    func invalidPattern() throws {
        let json = """
            { "version": 1, "categories": { "gratitude": { "phrases": [],
              "patterns": [ { "id": "broken", "re": "(unclosed", "w": 0.5 } ] } } }
            """
        let lexicon = try JSONDecoder().decode(Lexicon.self, from: Data(json.utf8))
        #expect(throws: PrefilterError.invalidPattern(id: "gratitude.broken")) {
            try Prefilter(lexicon: lexicon)
        }
    }

    @Test("The lexicon decoder ignores sections the Mac does not use and defaults missing ones")
    func lenientDecoding() throws {
        let json = """
            { "version": 2, "language": "en", "futureKey": { "anything": [1, 2] },
              "categories": { "care": { "phrases": [ { "p": "here for you" } ] } } }
            """
        let lexicon = try JSONDecoder().decode(Lexicon.self, from: Data(json.utf8))
        #expect(lexicon.version == 2)
        #expect(lexicon.categories["care"]?.patterns.isEmpty == true)
        #expect(lexicon.exclusions.senderPatterns.isEmpty)
        let prefilter = try Prefilter(lexicon: lexicon)
        #expect(prefilter.evaluate(text: "I'm here for you", handle: nil) == .candidate(categories: ["care"]))
    }

    @Test("The fixture lexicon matches the SPEC §6 shape")
    func fixtureShape() throws {
        let lexicon = try Lexicon.load(from: Fixtures.lexiconURL)
        #expect(lexicon.version == 1)
        #expect(!lexicon.categories.isEmpty)
        #expect(lexicon.exclusions.senderPatterns.map(\.id) == ["noreply", "business_mailbox"])
        #expect(lexicon.exclusions.bodyPatterns.map(\.id) == ["otp", "legal_footer"])
        #expect(lexicon.exclusions.senderPatterns.map(\.soft) == [nil, true])
    }

    @Test("Phrases compile like phraseSource() in lexicon.ts")
    func wholeWordPattern() {
        #expect(Prefilter.phraseSource("thank you") == #"\bthank\s+you\b"#)
        #expect(Prefilter.phraseSource("<3") == #"<3\b"#)
        #expect(Prefilter.phraseSource("❤️") == "❤️")
        #expect(Prefilter.phraseSource("you're") == #"\byou'?re\b"#)
        #expect(Prefilter.phraseSource("You’re  AMAZING") == #"\byou'?re\s+amazing\b"#)
        #expect(Prefilter.phraseSource("well-deserved") == #"\bwell[\s\-]?deserved\b"#)
        #expect(Prefilter.phraseSource("so (very) proud.") == #"\bso\s+\(very\)\s+proud\."#)
    }

    @Test("ICU gets JavaScript's ASCII meaning of \\b, \\w, \\d, . and $")
    func javaScriptTranslation() throws {
        #expect(JavaScriptRegex.icuPattern(#"\d{4}"#) == "[0-9]{4}")
        #expect(JavaScriptRegex.icuPattern(#"[\w.]+"#) == "[A-Za-z0-9_.]+")
        #expect(JavaScriptRegex.icuPattern(#"a.b$"#) == #"a[^\n\r\u2028\u2029]b\z"#)
        #expect(JavaScriptRegex.icuPattern(#"\\b"#) == #"\\b"#)
        let rule = try CompiledRule(id: "t", javaScriptPattern: #"\byou\b"#)
        // JavaScript (no u flag) sees a word boundary between "u" and "é"; plain ICU would not.
        #expect(rule.matches("Thank youé"))
        #expect(!rule.matches("Thank yous"))
    }

    @Test("SMS sender names are businesses; formatted short codes too")
    func builtinSenders() {
        #expect(prefilter.evaluate(text: "Thank you so much", handle: "BANKCO") == .excluded(rule: Prefilter.alphanumericSenderRule))
        #expect(prefilter.evaluate(text: "Thank you so much", handle: "(733) 12") == .excluded(rule: Prefilter.businessSenderRule))
        #expect(prefilter.evaluate(text: "Thank you so much", handle: "URN:BIZ:0000-example") == .excluded(rule: Prefilter.businessSenderRule))
        #expect(prefilter.evaluate(text: "Thank you so much", handle: "5550101") == .candidate(categories: ["gratitude"]))
        #expect(prefilter.evaluate(text: "Thank you so much", handle: "kai@example.com") == .candidate(categories: ["gratitude"]))
    }

    @Test("Lexicon locator order: explicit, environment, support directory, source tree")
    func locator() {
        let support = URL(fileURLWithPath: "/tmp/witness-support")
        let explicit = LexiconLocator.candidates(explicitPath: "/tmp/a.json", environment: ["WITNESS_LEXICON": "/tmp/b.json"], supportDirectory: support)
        #expect(explicit.map(\.path) == ["/tmp/a.json"])

        let implicit = LexiconLocator.candidates(explicitPath: nil, environment: ["WITNESS_LEXICON": "/tmp/b.json"], supportDirectory: support)
        #expect(implicit.map(\.path).prefix(2) == ["/tmp/b.json", "/tmp/witness-support/lexicon.json"])
        #expect(implicit.last?.path.hasSuffix("packages/detector/lexicon.json") == true)
        #expect(implicit.last?.path.contains("/apps/mac/") == false)

        // From anywhere inside a checkout: the current folder and each one above it.
        let nested = LexiconLocator.candidates(
            explicitPath: nil, environment: [:], supportDirectory: support,
            currentDirectory: URL(fileURLWithPath: "/tmp/checkout/apps/mac", isDirectory: true)
        )
        #expect(nested.map(\.path).contains("/tmp/checkout/packages/detector/lexicon.json"))
        #expect(nested.map(\.path).contains("/tmp/checkout/apps/mac/packages/detector/lexicon.json"))
    }

    @Test("The default lexicon resolves from the repository without --lexicon")
    func resolvesFromRepository() throws {
        let support = URL(fileURLWithPath: "/tmp/witness-support-\(UUID().uuidString)")
        for directory in [PrefilterParityTests.repositoryRoot, PrefilterParityTests.repositoryRoot.appendingPathComponent("apps/mac"), URL(fileURLWithPath: "/")] {
            let found = try #require(LexiconLocator.resolve(explicitPath: nil, environment: [:], supportDirectory: support, currentDirectory: directory))
            #expect(found.standardizedFileURL.path == PrefilterParityTests.lexiconURL.standardizedFileURL.path)
        }
    }
}

import Foundation
import Testing
@testable import WitnessMacCore

@Suite("TypedStreamText")
struct TypedStreamTextTests {
    @Test("Reads text from NSAttributedString and NSMutableAttributedString")
    func plainAttributedStrings() {
        let text = "Thank you for staying with me at the hospital."
        #expect(TypedStreamText.decode(TypedStreamArchiver.attributedBody(text, mutable: false)) == text)
        #expect(TypedStreamText.decode(TypedStreamArchiver.attributedBody(text, mutable: true)) == text)
    }

    @Test("Reads text when the attributed string carries attributes and several runs")
    func attributedStringWithAttributes() {
        let text = "You were so good with the kids today. Truly."
        let string = NSMutableAttributedString(string: text)
        let partKey = NSAttributedString.Key("__kIMMessagePartAttributeName")
        string.addAttribute(partKey, value: NSNumber(value: 0), range: NSRange(location: 0, length: 36))
        string.addAttribute(partKey, value: NSNumber(value: 1), range: NSRange(location: 37, length: 7))
        string.addAttribute(
            NSAttributedString.Key("__kIMDataDetectedAttributeName"),
            value: NSString(string: "synthetic-detector-result"),
            range: NSRange(location: 4, length: 4)
        )
        #expect(TypedStreamText.decode(TypedStreamArchiver.archive(string)) == text)
    }

    @Test(
        "Round-trips non-ASCII text",
        arguments: [
            "a❤️b",
            "👨‍👩‍👧‍👦 family photo 👍🏽",
            "🇺🇸🇯🇵",
            "谢谢你一直在我身边",
            "ありがとう、本当に助かりました",
            "شكرا جزيلا",
            "Cafe\u{301} with you was lovely",
            "Line one\nLine two\n\tindented",
        ]
    )
    func unicode(_ text: String) {
        #expect(TypedStreamText.decode(TypedStreamArchiver.attributedBody(text)) == text)
    }

    /// Lengths either side of each integer encoding: 1 byte (< 128), Int16 (< 32768), Int32.
    @Test("Handles every length encoding", arguments: [1, 127, 128, 129, 300, 32_767, 32_768, 65_536, 70_001])
    func lengths(_ length: Int) {
        let text = String(repeating: "kind words ", count: length / 11 + 1).prefix(length)
        let expected = String(text)
        #expect(TypedStreamText.decode(TypedStreamArchiver.attributedBody(expected)) == expected)
    }

    @Test("A long multi-byte message decodes exactly")
    func longMultibyte() {
        let text = String(repeating: "谢谢 🙏 ", count: 12_000)
        #expect(text.utf8.count > 70_000)
        #expect(TypedStreamText.decode(TypedStreamArchiver.attributedBody(text)) == text)
    }

    @Test("An empty attributed string decodes to an empty string")
    func emptyString() {
        #expect(TypedStreamText.decode(TypedStreamArchiver.attributedBody("")) == "")
    }

    @Test("A bare NSString archive is also understood")
    func bareString() {
        #expect(TypedStreamText.decode(TypedStreamArchiver.archive(NSString(string: "hello there"))) == "hello there")
    }

    @Test("Archives of other types are rejected")
    func otherRootObjects() {
        #expect(TypedStreamText.decode(TypedStreamArchiver.archive(NSNumber(value: 42))) == nil)
        #expect(TypedStreamText.decode(TypedStreamArchiver.archive(NSArray(array: ["one", "two"]))) == nil)
        #expect(TypedStreamText.decode(TypedStreamArchiver.archive(NSDictionary(dictionary: ["k": "v"]))) == nil)
    }

    @Test("Keyed archives, plists and empty data are rejected")
    func otherFormats() throws {
        let keyed = try NSKeyedArchiver.archivedData(
            withRootObject: NSAttributedString(string: "hi"),
            requiringSecureCoding: false
        )
        #expect(TypedStreamText.decode(keyed) == nil)
        #expect(TypedStreamText.decode(Data()) == nil)
        #expect(TypedStreamText.decode(Data("streamtyped".utf8)) == nil)
    }

    @Test("Invalid UTF-8 inside the string is rejected, not repaired")
    func invalidUTF8() throws {
        var blob = TypedStreamArchiver.attributedBody("hi")
        let range = try #require(blob.range(of: Data([0x02, 0x68, 0x69])))
        blob.replaceSubrange(range, with: [0x02, 0xFF, 0xFE])
        #expect(TypedStreamText.decode(blob) == nil)
    }

    @Test("A declared length larger than the blob is rejected")
    func oversizedLength() throws {
        var blob = TypedStreamArchiver.attributedBody("hi")
        let range = try #require(blob.range(of: Data([0x02, 0x68, 0x69])))
        blob.replaceSubrange(range, with: [0x82, 0xFF, 0xFF, 0xFF, 0x7F, 0x68, 0x69])
        #expect(TypedStreamText.decode(blob) == nil)
    }

    @Test("Negative lengths and dangling references are rejected")
    func negativeLengthAndBadReference() throws {
        var negative = TypedStreamArchiver.attributedBody("hi")
        let text = try #require(negative.range(of: Data([0x02, 0x68, 0x69])))
        negative.replaceSubrange(text, with: [0xFF, 0x68, 0x69]) // 0xFF is -1
        #expect(TypedStreamText.decode(negative) == nil)

        var dangling = TypedStreamArchiver.attributedBody("hi")
        // The superclass of the inner string is a reference to NSObject; point it past the table.
        let reference = try #require(dangling.range(of: Data([0x01, 0x95, 0x84, 0x01, 0x2B])))
        dangling[reference.lowerBound + 1] = 0xFE
        #expect(TypedStreamText.decode(dangling) == nil)
    }

    @Test("An endless superclass chain is cut off, not followed forever")
    func deepClassChain() {
        var blob: [UInt8] = [0x04, 0x0B] + Array("streamtyped".utf8) + [0x81, 0xE8, 0x03]
        blob += [0x84, 0x01, 0x40, 0x84] // type "@", new object
        for index in 0..<64 {
            let name = Array("NSClass\(index)".utf8)
            blob += [0x84, 0x84, UInt8(name.count)] + name + [0x00]
        }
        blob += [0x85]
        #expect(TypedStreamText.decode(Data(blob)) == nil)
    }

    @Test("Every truncation yields nil or the whole text, never a fragment")
    func truncation() {
        for mutable in [false, true] {
            let text = "I'm so proud of you ❤️"
            let blob = TypedStreamArchiver.attributedBody(text, mutable: mutable)
            let textStart = blob.range(of: Data(text.utf8))!.lowerBound
            for length in 0..<blob.count {
                let result = TypedStreamText.decode(blob.prefix(length))
                #expect(result == nil || result == text, "prefix \(length)")
                if length <= textStart + text.utf8.count {
                    #expect(result == nil, "prefix \(length) cuts into the text")
                }
            }
        }
    }

    @Test("Random bytes never crash the decoder")
    func randomBytes() {
        var generator = SplitMix64(seed: 0x57_49_54_4E_45_53_53)
        for _ in 0..<20_000 {
            let count = Int.random(in: 0...256, using: &generator)
            let bytes = (0..<count).map { _ in UInt8.random(in: 0...255, using: &generator) }
            _ = TypedStreamText.decode(Data(bytes))
        }
    }

    @Test("Random bytes after a valid header never crash the decoder")
    func randomBodies() {
        var generator = SplitMix64(seed: 2026)
        let header: [UInt8] = [0x04, 0x0B] + Array("streamtyped".utf8) + [0x81, 0xE8, 0x03, 0x84, 0x01, 0x40]
        // Bias towards the marker bytes so the parser goes deep.
        let alphabet: [UInt8] = [0x00, 0x01, 0x02, 0x2B, 0x40, 0x7F, 0x80, 0x81, 0x82, 0x84, 0x85, 0x86, 0x92, 0x93, 0x94, 0xFF]
        for _ in 0..<20_000 {
            let count = Int.random(in: 0...64, using: &generator)
            let body = (0..<count).map { _ in
                Bool.random(using: &generator)
                    ? alphabet.randomElement(using: &generator)!
                    : UInt8.random(in: 0...255, using: &generator)
            }
            _ = TypedStreamText.decode(Data(header + body))
        }
    }

    @Test("Mutated real blobs never crash the decoder")
    func mutations() {
        var generator = SplitMix64(seed: 0xC0FFEE)
        let originals = [
            TypedStreamArchiver.attributedBody("Thank you, truly.", mutable: false),
            TypedStreamArchiver.attributedBody("Congrats on the new job 🎉", mutable: true),
            TypedStreamArchiver.attributedBody(String(repeating: "x", count: 300)),
        ]
        for _ in 0..<20_000 {
            var bytes = [UInt8](originals.randomElement(using: &generator)!)
            for _ in 0..<Int.random(in: 1...4, using: &generator) {
                let index = Int.random(in: 0..<bytes.count, using: &generator)
                bytes[index] = UInt8.random(in: 0...255, using: &generator)
            }
            _ = TypedStreamText.decode(Data(bytes))
        }
    }
}

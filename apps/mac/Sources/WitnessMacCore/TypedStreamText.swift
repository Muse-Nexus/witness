import Foundation

/// Extracts the primary text from a Messages `attributedBody` blob.
///
/// Newer versions of Messages often leave `message.text` empty and keep the body
/// only in `attributedBody`, an `NSAttributedString` archived with the legacy
/// `NSArchiver` "typedstream" format.
///
/// This is a clean-room, deliberately minimal reader. It was written from first
/// principles by archiving attributed strings with `NSArchiver` and reading the
/// bytes (see `TypedStreamTextTests`). It understands just enough of the format to
/// walk from the stream header to the first string object and read its UTF-8
/// contents. Anything it does not recognise produces `nil`: it never traps, every
/// read is bounds-checked, and every loop either consumes input or is capped.
///
/// The layout it relies on, as observed in archives written by `NSArchiver`:
///
///     header    := int(version) int(11) "streamtyped" int(systemVersion)
///     int       := 0x00...0x7F                  literal value
///                | 0x81 <2 bytes little-endian>  Int16
///                | 0x82 <4 bytes little-endian>  Int32
///                | 0x92...0xFF                   small negative literal
///     shared    := 0x84 int(length) <bytes>      new entry in the shared-string table
///                | 0x92 + n                      the n-th shared string
///     object    := 0x84 class ...contents... 0x86   (0x84 = new object)
///     class     := 0x84 shared(name) int(version) class   new class, then its superclass
///                | 0x85                          end of the superclass chain
///                | 0x92 + n                      the n-th object-table entry (a class seen before)
///
/// Objects and classes share one reference table; shared strings (type
/// encodings and class names) have their own. An `NSAttributedString` archives
/// its string first, as type `"@"` followed by an `NSString`/`NSMutableString`
/// object whose contents are type `"+"`, a length, and that many UTF-8 bytes.
public enum TypedStreamText {
    /// Blobs larger than this are not decoded. Real message bodies are far smaller.
    public static let maximumInputSize = 16 * 1024 * 1024

    /// Returns the message text, or `nil` if the blob is not a typedstream
    /// attributed string this reader understands.
    public static func decode(_ data: Data) -> String? {
        guard !data.isEmpty, data.count <= maximumInputSize else { return nil }
        var reader = TypedStreamReader(bytes: [UInt8](data))
        return reader.primaryText()
    }
}

struct TypedStreamReader {
    private enum Tag {
        static let int16: UInt8 = 0x81
        static let int32: UInt8 = 0x82
        static let new: UInt8 = 0x84
        static let nilValue: UInt8 = 0x85
        static let endOfObject: UInt8 = 0x86
        static let firstReference: UInt8 = 0x92
    }

    private enum TableEntry {
        case object
        case classInfo(name: String, superclass: Int?)
    }

    private static let signature = Array("streamtyped".utf8)
    /// Real class chains are two or three deep; this only guards against cycles.
    private static let maximumClassDepth = 32
    private static let maximumClassNameLength = 256

    private let bytes: [UInt8]
    private var offset = 0
    private var sharedStrings: [[UInt8]] = []
    private var objectTable: [TableEntry] = []

    init(bytes: [UInt8]) {
        self.bytes = bytes
    }

    mutating func primaryText() -> String? {
        guard readHeader(), readTypeEncoding() == "@" else { return nil }
        guard let rootChain = readNewObjectClassChain() else { return nil }

        if Self.isPlainStringClass(rootChain) {
            return readStringContents()
        }
        guard rootChain.contains("NSAttributedString") else { return nil }
        guard readTypeEncoding() == "@",
              let stringChain = readNewObjectClassChain(),
              Self.isPlainStringClass(stringChain)
        else { return nil }
        return readStringContents()
    }

    // MARK: - Structure

    private mutating func readHeader() -> Bool {
        guard let version = readInteger(), version > 0,
              let signatureLength = readInteger(),
              signatureLength == Self.signature.count,
              let signature = readBytes(count: signatureLength),
              signature.elementsEqual(Self.signature),
              readInteger() != nil // system version; any value is fine
        else { return false }
        return true
    }

    /// Reads a type encoding such as `"@"` (object) or `"+"` (byte string).
    private mutating func readTypeEncoding() -> String? {
        guard let raw = readSharedString() else { return nil }
        return Self.ascii(raw, maximumLength: 64)
    }

    /// Reads a freshly archived object (not a back-reference or nil) and returns its
    /// class chain, most derived first, e.g. `["NSMutableString", "NSString", "NSObject"]`.
    private mutating func readNewObjectClassChain() -> [String]? {
        guard readByte() == Tag.new else { return nil }
        objectTable.append(.object)
        return readClassChain()
    }

    private mutating func readClassChain() -> [String]? {
        var definedHere: [Int] = []
        var names: [String] = []

        for _ in 0..<Self.maximumClassDepth {
            guard let tag = readByte() else { return nil }
            switch tag {
            case Tag.new:
                guard let rawName = readSharedString(),
                      let name = Self.ascii(rawName, maximumLength: Self.maximumClassNameLength),
                      readInteger() != nil // class version
                else { return nil }
                objectTable.append(.classInfo(name: name, superclass: nil))
                definedHere.append(objectTable.count - 1)
                names.append(name)
            case Tag.nilValue:
                linkSuperclasses(definedHere, terminal: nil)
                return names
            case Tag.firstReference...:
                let index = Int(tag - Tag.firstReference)
                guard index < objectTable.count, case .classInfo = objectTable[index] else { return nil }
                linkSuperclasses(definedHere, terminal: index)
                return names + ancestry(startingAt: index)
            default:
                return nil
            }
        }
        return nil
    }

    private mutating func linkSuperclasses(_ indices: [Int], terminal: Int?) {
        for (position, index) in indices.enumerated() {
            guard case .classInfo(let name, _) = objectTable[index] else { continue }
            let superclass = position + 1 < indices.count ? indices[position + 1] : terminal
            objectTable[index] = .classInfo(name: name, superclass: superclass)
        }
    }

    private func ancestry(startingAt start: Int) -> [String] {
        var names: [String] = []
        var current: Int? = start
        for _ in 0..<Self.maximumClassDepth {
            guard let index = current, index < objectTable.count,
                  case .classInfo(let name, let superclass) = objectTable[index]
            else { break }
            names.append(name)
            current = superclass
        }
        return names
    }

    /// The string's contents: type `"+"`, a byte length, the UTF-8 bytes, and the
    /// end-of-object marker. Requiring the marker means a blob cut off inside the
    /// text never yields a partial string.
    private mutating func readStringContents() -> String? {
        guard readTypeEncoding() == "+",
              let length = readInteger(),
              let body = readBytes(count: length),
              readByte() == Tag.endOfObject
        else { return nil }
        return Self.strictUTF8(body)
    }

    private static func isPlainStringClass(_ chain: [String]) -> Bool {
        chain.contains("NSString") && !chain.contains("NSAttributedString")
    }

    // MARK: - Primitives

    private mutating func readSharedString() -> [UInt8]? {
        guard let tag = readByte() else { return nil }
        switch tag {
        case Tag.new:
            guard let length = readInteger(), let raw = readBytes(count: length) else { return nil }
            let value = Array(raw)
            sharedStrings.append(value)
            return value
        case Tag.firstReference...:
            let index = Int(tag - Tag.firstReference)
            return index < sharedStrings.count ? sharedStrings[index] : nil
        default:
            return nil
        }
    }

    private mutating func readInteger() -> Int? {
        guard let tag = readByte() else { return nil }
        switch tag {
        case 0x00...0x7F:
            return Int(tag)
        case Tag.int16:
            guard let raw = readBytes(count: 2) else { return nil }
            let value = UInt16(raw[raw.startIndex]) | UInt16(raw[raw.startIndex + 1]) << 8
            return Int(Int16(bitPattern: value))
        case Tag.int32:
            guard let raw = readBytes(count: 4) else { return nil }
            var value: UInt32 = 0
            for (shift, byte) in raw.enumerated() {
                value |= UInt32(byte) << (8 * UInt32(shift))
            }
            return Int(Int32(bitPattern: value))
        case Tag.firstReference...:
            return Int(Int8(bitPattern: tag))
        default:
            return nil
        }
    }

    private mutating func readByte() -> UInt8? {
        guard offset < bytes.count else { return nil }
        defer { offset += 1 }
        return bytes[offset]
    }

    private mutating func readBytes(count: Int) -> ArraySlice<UInt8>? {
        guard count >= 0, count <= bytes.count - offset else { return nil }
        defer { offset += count }
        return bytes[offset..<(offset + count)]
    }

    private static func ascii(_ raw: [UInt8], maximumLength: Int) -> String? {
        guard !raw.isEmpty, raw.count <= maximumLength,
              raw.allSatisfy({ (0x21...0x7E).contains($0) })
        else { return nil }
        return String(decoding: raw, as: UTF8.self)
    }

    /// Decodes UTF-8, rejecting (rather than repairing) invalid sequences.
    private static func strictUTF8(_ raw: ArraySlice<UInt8>) -> String? {
        let decoded = String(decoding: raw, as: UTF8.self)
        return decoded.utf8.elementsEqual(raw) ? decoded : nil
    }
}

import Foundation

/// How far back Witness looks through Messages: a number of days, or every message on this Mac.
///
/// The first scan starts there. Choosing a longer time later looks through the older
/// messages once, a few at a time (`CursorState.olderWindows`); choosing a shorter one
/// changes nothing that was already sent.
public enum Lookback: Hashable, Sendable {
    case days(Int)
    case everything

    public static let lastThirtyDays = Lookback.days(30)
    public static let lastYear = Lookback.days(365)
    /// What setup and Settings offer, in order.
    public static let choices: [Lookback] = [.lastThirtyDays, .lastYear, .everything]
    /// For a new setup, and for the CLI when nothing else is given.
    public static let `default` = Lookback.lastYear
    /// The CLI takes any whole number of days up to this.
    public static let maximumDays = 3650

    static let dayMilliseconds: Int64 = 86_400_000

    /// A number of days from 0 to `maximumDays`, or everything.
    public var isValid: Bool {
        switch self {
        case .days(let days): (0...Self.maximumDays).contains(days)
        case .everything: true
        }
    }

    /// Unix milliseconds: messages dated earlier are outside the range. 0 for everything
    /// (Messages dates start in 2001, so every dated message is inside).
    public func floor(atUnixMilliseconds now: Int64) -> Int64 {
        switch self {
        case .days(let days): now - Int64(min(max(days, 0), Self.maximumDays)) * Self.dayMilliseconds
        case .everything: 0
        }
    }

    /// Setup's words: "The last 30 days", "The last year", "Everything".
    public var label: String {
        switch self {
        case .days(365): "The last year"
        case .days(1): "The last day"
        case .days(let days): "The last \(days) days"
        case .everything: "Everything"
        }
    }

    /// The same words inside a sentence: "the last year", "everything".
    public var phrase: String {
        label.prefix(1).lowercased() + label.dropFirst()
    }
}

extension Lookback: Codable {
    /// On disk: a number of days, or the string "everything".
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let days = try? container.decode(Int.self) {
            self = .days(days)
        } else if try container.decode(String.self) == "everything" {
            self = .everything
        } else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected a number of days or \"everything\".")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .days(let days): try container.encode(days)
        case .everything: try container.encode("everything")
        }
    }
}

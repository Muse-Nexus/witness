import Foundation

/// Conversions for Messages timestamps.
///
/// `message.date` counts from the Apple reference date (2001-01-01 UTC). Since
/// macOS 10.13 it is in nanoseconds; older databases used seconds. A value above
/// ten billion cannot be seconds (that would be the year 2318), so anything larger
/// is read as nanoseconds.
public enum AppleTime {
    static let referenceDateUnixSeconds: Int64 = 978_307_200
    static let nanosecondThreshold: Int64 = 10_000_000_000

    /// Unix milliseconds for a raw `message.date` value, or `nil` when unknown.
    public static func unixMilliseconds(fromMessagesDate raw: Int64) -> Int64? {
        guard raw > 0 else { return nil }
        if raw > nanosecondThreshold {
            return referenceDateUnixSeconds * 1_000 + raw / 1_000_000
        }
        return (referenceDateUnixSeconds + raw) * 1_000
    }

    /// The nanosecond-style `message.date` value for a Unix millisecond timestamp.
    public static func messagesNanoseconds(fromUnixMilliseconds milliseconds: Int64) -> Int64 {
        (milliseconds - referenceDateUnixSeconds * 1_000) * 1_000_000
    }

    /// The legacy seconds-style `message.date` value for a Unix millisecond timestamp.
    public static func messagesSeconds(fromUnixMilliseconds milliseconds: Int64) -> Int64 {
        milliseconds / 1_000 - referenceDateUnixSeconds
    }

    public static func unixMilliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1_000).rounded())
    }
}

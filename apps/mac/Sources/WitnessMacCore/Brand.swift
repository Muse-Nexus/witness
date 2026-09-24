import Foundation

/// Muse Nexus brand marks for terminal output (SPEC §4).
///
/// The wordmark is a tracked-caps `MUSE NEXUS` eyebrow over `Witness.`, with the
/// coral block cursor before the eyebrow and a coral period. Colour is used only
/// on an interactive terminal and never when `NO_COLOR` is set.
public struct Brand: Sendable {
    public var useColor: Bool

    public init(useColor: Bool) {
        self.useColor = useColor
    }

    /// Dark-mode coral, oklch(71% .17 25), as 24-bit sRGB.
    private static let coral = "\u{1B}[38;2;250;112;106m"
    private static let dim = "\u{1B}[2m"
    private static let reset = "\u{1B}[0m"

    public func coral(_ text: String) -> String {
        useColor ? Self.coral + text + Self.reset : text
    }

    public func dim(_ text: String) -> String {
        useColor ? Self.dim + text + Self.reset : text
    }

    /// Eyebrow with the coral block cursor, e.g. `▍MUSE NEXUS`.
    public func eyebrow(_ text: String) -> String {
        coral("▍") + dim(text)
    }

    public func wordmark(subtitle: String) -> String {
        eyebrow("MUSE NEXUS") + "\n" + "Witness" + coral(".") + "  " + dim(subtitle)
    }

    public static func shouldUseColor(environment: [String: String], isTerminal: Bool) -> Bool {
        isTerminal && environment["NO_COLOR"] == nil && environment["TERM"] != "dumb"
    }
}

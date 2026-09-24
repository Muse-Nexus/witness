import SwiftUI

/// Muse Nexus colours for the menu-bar app (SPEC §4): ink, cream and coral, dark by default.
enum Theme {
    /// `--ink` oklch(0% 0 0).
    static let ink = Color(red: 0, green: 0, blue: 0)
    /// A step up from ink, for fields and cards.
    static let inkRaised = Color(red: 0.075, green: 0.072, blue: 0.068)
    /// `--cream` oklch(96.5% .016 90), about #F7F2E8.
    static let cream = Color(red: 247 / 255, green: 242 / 255, blue: 232 / 255)
    /// Dark-mode `--coral` oklch(71% .17 25).
    static let coral = Color(red: 250 / 255, green: 112 / 255, blue: 106 / 255)
    /// `--coral-foreground` for dark mode, oklch(8% 0 0).
    static let coralForeground = Color(red: 0.035, green: 0.035, blue: 0.035)
    /// Moss, lifted for contrast on ink: the check mark when something is allowed.
    static let granted = Color(red: 0.56, green: 0.78, blue: 0.58)
    static let dim = cream.opacity(0.64)
    static let faint = cream.opacity(0.42)
    /// Hairlines: cream at 14%.
    static let hairline = cream.opacity(0.14)

    static func display(_ size: CGFloat) -> Font {
        .system(size: size, weight: .regular, design: .serif)
    }
}

/// `▍MUSE NEXUS` over `Witness.` with a coral period.
struct Wordmark: View {
    var size: CGFloat = 22

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Eyebrow(text: "MUSE NEXUS")
            (Text("Witness").foregroundStyle(Theme.cream) + Text(".").foregroundStyle(Theme.coral))
                .font(Theme.display(size))
                .accessibilityLabel("Witness")
        }
    }
}

/// A tracked-caps eyebrow after the coral block cursor.
struct Eyebrow: View {
    var text: String

    var body: some View {
        HStack(spacing: 3) {
            Text("▍").foregroundStyle(Theme.coral)
            Text(text.uppercased())
                .tracking(1.6)
                .foregroundStyle(Theme.dim)
        }
        .font(.system(size: 9.5, weight: .semibold))
        .accessibilityElement(children: .combine)
    }
}

struct Hairline: View {
    var body: some View {
        Rectangle().fill(Theme.hairline).frame(height: 1)
    }
}

/// The main action: coral with dark text.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Theme.coralForeground)
            .padding(.horizontal, 14)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(Theme.coral.opacity(configuration.isPressed ? 0.8 : 1))
            )
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(Rectangle())
    }
}

/// A quieter action: cream text inside a hairline.
struct SecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(Theme.cream)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(configuration.isPressed ? Theme.hairline : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .stroke(Theme.cream.opacity(0.28), lineWidth: 1)
            )
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(Rectangle())
    }
}

/// A plain text action, like a menu row or a link.
struct QuietButtonStyle: ButtonStyle {
    var color: Color = Theme.cream
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13))
            .foregroundStyle(color.opacity(configuration.isPressed ? 0.6 : 1))
            .opacity(isEnabled ? 1 : 0.4)
            .contentShape(Rectangle())
    }
}

/// A text field on ink: raised background and a hairline.
struct FieldBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .textFieldStyle(.plain)
            .font(.system(size: 13))
            .foregroundStyle(Theme.cream)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Theme.inkRaised))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).stroke(Theme.hairline, lineWidth: 1))
    }
}

extension View {
    func witnessField() -> some View { modifier(FieldBackground()) }
}

/// The crisis line, kept in the app (docs/SAFETY.md §4).
struct CrisisLine: View {
    var body: some View {
        Text("If you are in crisis, call or text 988 (US) or visit findahelpline.com. Witness is not treatment.")
            .font(.system(size: 10.5))
            .foregroundStyle(Theme.faint)
            .fixedSize(horizontal: false, vertical: true)
    }
}

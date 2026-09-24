import SwiftUI
import WitnessMacCore

/// The panel under the menu-bar icon. Shows states and counts only: never message text,
/// never names.
struct StatusPanel: View {
    let model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Wordmark(size: 22)

            VStack(alignment: .leading, spacing: 6) {
                Text(StatusCopy.activity(model.status.activity))
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.cream)
                    .fixedSize(horizontal: false, vertical: true)
                if let note = model.status.note {
                    Text(note)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let step = model.fixStep {
                    Button(fixLabel(step)) { model.openSetup(mode: .settings, at: step) }
                        .buttonStyle(PrimaryButtonStyle())
                        .padding(.top, 4)
                }
            }

            Hairline()

            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 7) {
                row("Witness", StatusCopy.connection(model.status.connection))
                row("Messages access", StatusCopy.fullDiskAccess(model.status.fullDiskAccess),
                    granted: model.status.fullDiskAccess == .granted)
                row("Last check", StatusCopy.lastCheck(model.status.lastCheck, now: Date()))
                row("Sent today", "\(model.status.sentToday)")
                row("Sent this week", "\(model.status.sentThisWeek)")
            }

            HStack(spacing: 8) {
                Button("Check now") { model.checkNow() }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(!model.canCheckNow)
                Button(model.isPaused ? "Resume" : "Pause") { model.togglePause() }
                    .buttonStyle(SecondaryButtonStyle())
                    .disabled(model.status.activity == .waitingForSetup)
            }

            Hairline()

            VStack(alignment: .leading, spacing: 9) {
                Button("Open Witness") { model.openWitness() }
                Button(model.appState.setup.isFinished ? "Settings…" : "Finish setup…") {
                    model.openSetup(mode: model.appState.setup.isFinished ? .settings : .firstRun)
                }
                Button("Quit Witness") { model.quit() }
            }
            .buttonStyle(QuietButtonStyle())

            Hairline()
            CrisisLine()
        }
        .padding(18)
        .frame(width: 320, alignment: .leading)
        .background(Theme.ink)
        .environment(\.colorScheme, .dark)
        .onAppear { model.panelOpened() }
    }

    private func fixLabel(_ step: SetupStep) -> String {
        switch step {
        case .server: "Add a key"
        case .fullDiskAccess: "Turn on Messages access"
        default: "Open Settings"
        }
    }

    @ViewBuilder
    private func row(_ label: String, _ value: String, granted: Bool = false) -> some View {
        GridRow {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(Theme.dim)
            HStack(spacing: 5) {
                if granted {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Theme.granted)
                        .font(.system(size: 11))
                }
                Text(value)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.cream)
                    .lineLimit(2)
            }
        }
    }
}

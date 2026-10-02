import AppKit
import SwiftUI
import WitnessMacCore

@MainActor
private enum SetupWindowSize {
    static var current: NSSize {
        var available = NSScreen.main?.visibleFrame.size ?? NSSize(width: 840, height: 840)
        #if DEBUG
        let environment = ProcessInfo.processInfo.environment
        if environment[Snapshots.variable] != nil,
           let value = environment["WITNESS_SNAPSHOT_VISIBLE_SIZE"] {
            let parts = value.split(separator: "x").compactMap { Double($0) }
            if parts.count == 2, parts[0] >= 800, parts[1] >= 480 {
                available = NSSize(width: parts[0], height: parts[1])
            }
        }
        #endif
        return NSSize(width: min(800, max(640, available.width - 40)),
                      height: min(760, max(300, available.height - 80)))
    }
}

/// Hosts the setup window. An agent app has no Dock icon, so the window is brought to the
/// front explicitly.
@MainActor
final class SetupWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    var onClose: (() -> Void)?

    func show<Content: View>(_ content: Content, settings: Bool) {
        if window != nil {
            bringToFront()
            return
        }
        let hosting = NSHostingController(rootView: content)
        let window = NSWindow(contentViewController: hosting)
        window.title = settings ? "Witness Settings" : "Set up Witness"
        window.styleMask = [.titled, .closable, .fullSizeContentView]
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.backgroundColor = .black
        window.appearance = NSAppearance(named: .darkAqua)
        window.delegate = self
        window.setContentSize(SetupWindowSize.current)
        window.center()
        self.window = window
        bringToFront()
    }

    func bringToFront() {
        #if DEBUG
        if ProcessInfo.processInfo.environment[Snapshots.variable] != nil {
            window?.orderBack(nil)
            window?.displayIfNeeded()
            return
        }
        #endif
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
    }

    func close() {
        window?.close()
    }

    var contentView: NSView? { window?.contentView }

    func windowWillClose(_ notification: Notification) {
        window = nil
        onClose?()
    }
}

/// One calm step per screen. On first run the steps go in order; from Settings a list on
/// the left opens any of them.
struct SetupView: View {
    @Bindable var model: AppModel

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Rectangle().fill(Theme.hairline).frame(width: 1)
            VStack(alignment: .leading, spacing: 0) {
                ViewThatFits(in: .vertical) {
                    stepContent
                    ScrollView { stepContent.fixedSize(horizontal: false, vertical: true) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                Hairline()
                VStack(alignment: .leading, spacing: 12) {
                    footer
                    // On every step, Settings included (docs/SAFETY.md §4).
                    CrisisLine()
                }
                .padding(.horizontal, 36)
                .padding(.top, 16)
                .padding(.bottom, 14)
            }
        }
        .frame(width: SetupWindowSize.current.width, height: SetupWindowSize.current.height)
        .background(Theme.ink)
        .environment(\.colorScheme, .dark)
    }

    private var stepContent: some View {
        VStack(alignment: .leading, spacing: 18) { content }
            .padding(.horizontal, 36)
            .padding(.top, 40)
            .padding(.bottom, 20)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Sidebar

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 4) {
            Wordmark(size: 20)
                .padding(.bottom, 18)
            ForEach(SetupStep.allCases, id: \.self) { step in
                Button {
                    model.go(to: step)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: model.isSatisfied(step) && step != .startAtLogin && step != .lookback
                              ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(model.isSatisfied(step) && step != .startAtLogin && step != .lookback
                                             ? Theme.granted : Theme.faint)
                            .font(.system(size: 11))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.label)
                            if step == .names || step == .startAtLogin {
                                Text("Optional").font(.system(size: 10)).foregroundStyle(Theme.faint)
                            }
                        }
                            .font(.system(size: 13, weight: model.flow?.currentStep == step ? .semibold : .regular))
                            .foregroundStyle(model.flow?.currentStep == step ? Theme.cream : Theme.dim)
                        Spacer()
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(model.flow?.currentStep == step ? Theme.inkRaised : Color.clear)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Spacer()
            if model.flow?.mode == .firstRun {
                Text("Closing saves your progress. Checking starts only after you finish these steps.")
                    .font(.system(size: 11)).foregroundStyle(Theme.faint)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
            Toggle("Pause Witness", isOn: Binding(
                get: { model.isPaused },
                set: { _ in model.togglePause() }
            ))
            .toggleStyle(.switch)
            .controlSize(.small)
            .font(.system(size: 12))
            .foregroundStyle(Theme.dim)
            .disabled(model.status.activity == .waitingForSetup)
            .padding(.bottom, 6)
            }
        }
        .padding(.top, 36)
        .padding(.horizontal, 18)
        .padding(.bottom, 18)
        .frame(width: 200, alignment: .leading)
    }

    // MARK: Content

    @ViewBuilder
    private var content: some View {
        switch model.flow?.position {
        case .step(.server): ServerStep(model: model)
        case .step(.fullDiskAccess): FullDiskAccessStep(model: model)
        case .step(.names): NamesStep(model: model)
        case .step(.startAtLogin): StartAtLoginStep(model: model)
        case .step(.lookback): LookbackStep(model: model)
        case .finished, nil: DoneStep(model: model)
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 10) {
            if model.flow?.canGoBack == true {
                Button("Back") { model.back() }
                    .buttonStyle(QuietButtonStyle(color: Theme.dim))
            }
            Spacer()
            if let step = model.flow?.currentStep {
                if model.flow?.mode == .settings {
                    Button("Done") { model.closeSetup() }
                        .buttonStyle(SecondaryButtonStyle())
                    if step != SetupStep.allCases.last {
                        Button("Next") { model.isSatisfied(step) ? model.continueStep() : model.skipStep() }
                            .buttonStyle(PrimaryButtonStyle())
                    }
                } else {
                    if !model.isSatisfied(step) {
                        Button("Skip for now") { model.skipStep() }
                            .buttonStyle(QuietButtonStyle(color: Theme.dim))
                    }
                    Button(step == .lookback ? (model.messagesReady ? "Start checking" : "Save setup") : "Continue") { model.continueStep() }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(!model.isSatisfied(step))
                        .keyboardShortcut(.defaultAction)
                }
            } else {
                Button("Close") { model.closeSetup() }
                    .buttonStyle(PrimaryButtonStyle())
                    .keyboardShortcut(.defaultAction)
            }
        }
    }
}

/// Eyebrow, title and lede shared by every step.
struct StepHeader: View {
    var eyebrow: String?
    var title: String
    var lede: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let eyebrow { Eyebrow(text: eyebrow) }
            Text(title)
                .font(Theme.display(28))
                .foregroundStyle(Theme.cream)
                .fixedSize(horizontal: false, vertical: true)
            Text(lede)
                .font(.system(size: 13.5))
                .foregroundStyle(Theme.dim)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A line under a control saying how things stand.
struct StateLine: View {
    enum Kind {
        case good
        case waiting
        case problem
        case plain
    }

    var kind: Kind
    var text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            switch kind {
            case .good:
                Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.granted)
            case .waiting:
                ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 14, height: 14)
            case .problem:
                Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.coral)
            case .plain:
                EmptyView()
            }
            Text(text)
                .font(.system(size: 12.5))
                .foregroundStyle(kind == .problem ? Theme.cream : Theme.dim)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

import AppKit
import SwiftUI
import WitnessMacCore

// Product voice: calm, plain, warm, second person, no exclamation marks, and never
// telling the person how to feel (docs/SAFETY.md §9).

// MARK: - 1. Your Witness

struct ServerStep: View {
    @Bindable var model: AppModel
    @FocusState private var keyFocused: Bool

    var body: some View {
        StepHeader(
            eyebrow: model.flow?.stepCaption,
            title: "Connect to your Witness.",
            lede: "Paste the phone key from Witness. It starts with wit_dev_ and can only add things to your Witness, never read them. It is kept in your Keychain on this Mac."
        )

        VStack(alignment: .leading, spacing: 12) {
            field("Witness address") {
                TextField("", text: $model.serverAddress, prompt: Text(ServerConnector.defaultAddress))
                    .witnessField()
                    .disableAutocorrection(true)
            }
            field(model.hasSavedKey ? "New key (a key is already saved)" : "Key") {
                SecureField("", text: $model.serverKey, prompt: Text("wit_dev_…"))
                    .witnessField()
                    .focused($keyFocused)
                    .onSubmit { if canCheck { model.connect() } }
                    .onAppear { keyFocused = !model.hasSavedKey }
            }
            HStack(spacing: 12) {
                Button("Check and save") { model.connect() }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!canCheck)
                if model.hasSavedKey {
                    Button("Remove the key from this Mac") { model.removeKey() }
                        .buttonStyle(QuietButtonStyle(color: Theme.dim))
                }
            }
            if let message = model.serverState.message {
                StateLine(kind: stateKind, text: message)
            } else if model.hasSavedKey, !model.keyMatchesAddress, model.connector.savedAddress() != nil {
                StateLine(kind: .problem, text: "The saved key belongs to a different address, so nothing is sent. Paste a key for this address and choose Check and save.")
            } else if model.hasSavedKey {
                StateLine(kind: .good, text: "A key is saved on this Mac.")
            }
        }

        VStack(alignment: .leading, spacing: 6) {
            Text("To make a key, open Witness, go to Setup, then Texts and photos, and choose Create a phone key.")
                .font(.system(size: 12))
                .foregroundStyle(Theme.faint)
                .fixedSize(horizontal: false, vertical: true)
            Button("Open Witness to make a key") { model.openMakeKey() }
                .buttonStyle(QuietButtonStyle(color: Theme.coral))
        }
        .padding(.top, 4)
    }

    private var canCheck: Bool {
        model.serverState != .checking
            && !model.serverKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.serverAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var stateKind: StateLine.Kind {
        switch model.serverState {
        case .checking: .waiting
        case .connected: .good
        case .unreachable: .plain
        case .problem: .problem
        case .idle: .plain
        }
    }

    private func field<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(Theme.dim)
            content()
        }
    }
}

// MARK: - 2. Messages access

struct FullDiskAccessStep: View {
    let model: AppModel

    var body: some View {
        StepHeader(
            eyebrow: model.flow?.stepCaption,
            title: "Let Witness read Messages.",
            lede: "Messages keeps your texts in a protected file on this Mac, so macOS asks you to allow Full Disk Access. Witness only reads that file. It never changes, sends or deletes anything, and only kind messages leave this Mac, one at a time."
        )

        VStack(alignment: .leading, spacing: 14) {
            numbered(1, "Open Full Disk Access in System Settings.") {
                Button("Open System Settings") { model.openFullDiskAccessSettings() }
                    .buttonStyle(PrimaryButtonStyle())
            }
            numbered(2, "Turn on Witness. If it is not in the list, drag this icon into the list.") {
                AppIconDragSource()
            }
        }

        Group {
            switch model.fullDiskAccessPhase {
            case .granted:
                StateLine(kind: .good, text: "Access is on. Witness can read Messages.")
            case .waiting:
                StateLine(kind: .waiting, text: "Waiting for access. This updates by itself.")
            case .mayNeedRelaunch:
                VStack(alignment: .leading, spacing: 8) {
                    StateLine(kind: .plain, text: "If you have turned it on, Witness needs to reopen to use it.")
                    Button("Relaunch Witness") { model.relaunch() }
                        .buttonStyle(SecondaryButtonStyle())
                }
            case .noMessages:
                StateLine(kind: .plain, text: "There is no Messages database on this Mac yet. Open Messages and sign in, then come back.")
            }
        }
        .padding(.top, 2)
    }

    private func numbered<Content: View>(_ number: Int, _ text: String, @ViewBuilder _ content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(Theme.display(18))
                .foregroundStyle(Theme.coral)
                .frame(width: 16, alignment: .leading)
            VStack(alignment: .leading, spacing: 8) {
                Text(text)
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.cream)
                    .fixedSize(horizontal: false, vertical: true)
                content()
            }
        }
    }
}

/// The app's icon, which can be dragged into the Full Disk Access list.
struct AppIconDragSource: View {
    var body: some View {
        HStack(spacing: 10) {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: 44, height: 44)
                .onDrag { NSItemProvider(object: Bundle.main.bundleURL as NSURL) }
                .help("Drag Witness into the Full Disk Access list")
            Text("Witness")
                .font(.system(size: 12))
                .foregroundStyle(Theme.dim)
        }
    }
}

// MARK: - 3. Names

struct NamesStep: View {
    let model: AppModel

    var body: some View {
        StepHeader(
            eyebrow: model.flow?.stepCaption,
            title: "Show who said it.",
            lede: "Witness can look up who sent a kind message in your Contacts, so it shows their name. Your contacts stay on this Mac. Only the name of the person who sent a kept message goes with it."
        )

        VStack(alignment: .leading, spacing: 12) {
            switch model.contactsAccess {
            case .authorized:
                Toggle("Show names from Contacts", isOn: Binding(
                    get: { model.appState.namesEnabled },
                    set: { model.setNames($0) }
                ))
                .toggleStyle(.switch)
                .foregroundStyle(Theme.cream)
                StateLine(kind: model.appState.namesEnabled ? .good : .plain,
                          text: model.appState.namesEnabled ? "Names are on." : "Names are off. Kept messages show who sent them only by number or address.")
            case .notDetermined:
                if model.canAskForContacts {
                    Button("Allow Contacts") { model.allowContacts() }
                        .buttonStyle(PrimaryButtonStyle())
                } else {
                    StateLine(kind: .plain, text: "Names need the Witness app. Build it with scripts/build-app.sh.")
                }
            case .denied, .restricted:
                StateLine(kind: .plain, text: "Contacts access is off for Witness. You can turn it on in System Settings, under Privacy & Security, then Contacts.")
                Button("Open Contacts settings") { model.openContactsSettings() }
                    .buttonStyle(SecondaryButtonStyle())
            }
        }

        Text("macOS gives an app all of your contacts or none. Witness reads only names, phone numbers and email addresses, and keeps nothing from Contacts on disk. If a number matches more than one card, no name is sent.")
            .font(.system(size: 12))
            .foregroundStyle(Theme.faint)
            .fixedSize(horizontal: false, vertical: true)
    }
}

// MARK: - 4. Start at login

struct StartAtLoginStep: View {
    let model: AppModel

    var body: some View {
        StepHeader(
            eyebrow: model.flow?.stepCaption,
            title: "Start with your Mac.",
            lede: "Witness can open quietly when you log in, so it keeps watching without you having to remember it. It stays off unless you turn it on."
        )

        VStack(alignment: .leading, spacing: 12) {
            Toggle("Open Witness at login", isOn: Binding(
                get: { model.loginItem == .on || model.loginItem == .needsApproval },
                set: { model.setStartAtLogin($0) }
            ))
            .toggleStyle(.switch)
            .foregroundStyle(Theme.cream)
            .disabled(model.loginItem == .unavailable)

            switch model.loginItem {
            case .needsApproval:
                StateLine(kind: .plain, text: "macOS needs you to allow it before it takes effect.")
                Button("Allow it in System Settings") { model.openLoginItemsSettings() }
                    .buttonStyle(SecondaryButtonStyle())
            case .unavailable:
                StateLine(kind: .plain, text: "Move Witness to your Applications folder to use this.")
            case .on:
                StateLine(kind: .good, text: "Witness opens when you log in.")
            case .off:
                EmptyView()
            }
        }
    }
}

// MARK: - 5. First check

struct LookbackStep: View {
    let model: AppModel

    var body: some View {
        StepHeader(
            eyebrow: model.flow?.stepCaption,
            title: "How far back to look.",
            lede: "The first check looks at messages from the past \(model.appState.lookbackDays) days. Older messages stay on this Mac. After that, Witness looks only at new messages, each one once."
        )

        Picker("First check", selection: Binding(
            get: { model.appState.lookbackDays },
            set: { model.setLookback($0) }
        )) {
            ForEach(AppState.lookbackChoices, id: \.self) { days in
                Text("\(days) days").tag(days)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .frame(maxWidth: 300)

        if model.hasStartedChecking {
            StateLine(kind: .plain, text: "Witness has already made its first check, so this changes nothing now.")
        }
    }
}

// MARK: - Done

struct DoneStep: View {
    let model: AppModel

    var body: some View {
        StepHeader(
            eyebrow: nil,
            title: "Witness is ready.",
            lede: "It checks quietly from the menu bar. You can pause it, or change any of this in Settings."
        )

        VStack(alignment: .leading, spacing: 8) {
            ForEach(SetupStep.allCases, id: \.self) { step in
                let (isOn, detail) = summary(step)
                HStack(spacing: 8) {
                    Image(systemName: isOn ? "checkmark.circle.fill" : "circle.dashed")
                        .foregroundStyle(isOn ? Theme.granted : Theme.faint)
                        .font(.system(size: 12))
                    Text(step.label)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.cream)
                    Text(detail)
                        .font(.system(size: 12))
                        .foregroundStyle(Theme.faint)
                }
            }
        }

        CrisisLine()
            .padding(.top, 8)
    }

    /// Whether the step is in place, and a few words on how it stands.
    private func summary(_ step: SetupStep) -> (Bool, String) {
        switch step {
        case .server:
            model.isSatisfied(.server) ? (true, "connected") : (false, "not yet")
        case .fullDiskAccess:
            model.isSatisfied(.fullDiskAccess) ? (true, "allowed") : (false, "not yet")
        case .names:
            model.isSatisfied(.names) ? (true, "on") : (false, "off")
        case .startAtLogin:
            model.loginItem == .on ? (true, "on") : (false, "off")
        case .lookback:
            (true, "the past \(model.appState.lookbackDays) days")
        }
    }
}

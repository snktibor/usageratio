import ServiceManagement
import SwiftUI
import UsageRatioCore

/// Server URL, the read token (into the keychain), and open-at-login.
struct SettingsView: View {
    let store: StatusStore
    /// False on the very first run: there is nothing to go back to yet.
    let canCancel: Bool
    let done: () -> Void

    @State private var server = ""
    @State private var token = ""
    @State private var problem: String?
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

    private var strings: Strings { store.strings }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(strings.settings).font(.headline)

            VStack(alignment: .leading, spacing: 4) {
                Text(strings.serverLabel).font(.caption).foregroundStyle(.secondary)
                TextField("https://usage.example.com", text: $server)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(strings.tokenLabel).font(.caption).foregroundStyle(.secondary)
                SecureField("ur_…", text: $token).textFieldStyle(.roundedBorder)
                Text(store.hasToken ? strings.tokenSaved : strings.tokenHint)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Toggle(strings.launchAtLogin, isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, enabled in setLaunchAtLogin(enabled) }

            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            HStack {
                Spacer()
                if canCancel {
                    Button(strings.cancel, action: done).keyboardShortcut(.cancelAction)
                }
                Button(strings.save) {
                    problem = store.save(serverText: server, token: token)
                    if problem == nil {
                        token = ""
                        done()
                    }
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .onAppear { server = store.serverURL?.absoluteString ?? "" }
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            problem = nil
        } catch {
            problem = strings.launchAtLoginFailed
            launchAtLogin = SMAppService.mainApp.status == .enabled
        }
    }
}

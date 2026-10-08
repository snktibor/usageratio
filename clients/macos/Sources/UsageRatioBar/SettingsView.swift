import AppKit
import ServiceManagement
import SwiftUI
import UsageRatioCore

/// Behind the gear: what the menu bar shows, the connection, and the rest.
/// The display choices apply at once; the connection on Save.
struct SettingsView: View {
    @Bindable var store: StatusStore
    /// False on the very first run: there is nothing to go back to yet.
    let canClose: Bool
    let close: () -> Void

    @State private var server = ""
    @State private var token = ""
    @State private var problem: String?
    @State private var saved = false
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

    private var strings: Strings { store.strings }

    var body: some View {
        VStack(spacing: 14) {
            header
            if let payload = store.payload, !payload.providers.isEmpty {
                display(payload)
            }
            connection
            general
        }
        .onAppear { server = store.serverURL?.absoluteString ?? "" }
    }

    private var header: some View {
        ZStack {
            Text(strings.settings).font(.title3.weight(.semibold))
            if canClose {
                HStack {
                    Spacer()
                    Button(strings.done, action: close)
                        .keyboardShortcut(.cancelAction)
                        .controlSize(.small)
                }
            }
        }
    }

    private func display(_ payload: StatusPayload) -> some View {
        VStack(spacing: 8) {
            SectionHeader(title: strings.displaySection)
            row(strings.provider) {
                Picker(strings.provider, selection: Binding(
                    get: { store.selectedProvider?.id ?? "" },
                    set: { store.select(providerId: $0) }
                )) {
                    ForEach(payload.providers) { provider in
                        Text(Display.shareText(
                            name: provider.label, percent: provider.percent, tokens: provider.tokens, strings: strings
                        ))
                        .tag(provider.id)
                    }
                }
            }
            if let provider = store.selectedProvider, !provider.groups.isEmpty {
                row(strings.menuBarShows) {
                    Picker(strings.menuBarShows, selection: $store.selectedScope) {
                        Text(strings.wholeProvider).tag(MenuBarScope.total)
                        Section(strings.groupsSection) {
                            ForEach(provider.groups) { group in
                                Text(Display.shareText(
                                    name: group.id, percent: group.percent, tokens: group.tokens, strings: strings
                                ))
                                .tag(MenuBarScope.group(group.id))
                            }
                        }
                        Section(strings.machinesSection) {
                            ForEach(provider.machines) { machine in
                                Text(Display.shareText(
                                    name: machine.id, percent: machine.percent, tokens: machine.tokens, strings: strings
                                ))
                                .tag(MenuBarScope.machine(machine.id))
                            }
                        }
                    }
                }
            }
        }
    }

    private var connection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(title: strings.connectionSection)
            Text(strings.serverLabel).font(.caption).foregroundStyle(.secondary)
            TextField("https://usage.example.com", text: $server)
                .textFieldStyle(.roundedBorder)
                .autocorrectionDisabled()
                .onChange(of: server) { saved = false }
            Text(strings.tokenLabel).font(.caption).foregroundStyle(.secondary)
            SecureField("ur_…", text: $token)
                .textFieldStyle(.roundedBorder)
                .onChange(of: token) { saved = false }
            Text(store.hasToken ? strings.tokenSaved : strings.tokenHint)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let problem {
                Label(problem, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            HStack {
                Spacer()
                if saved {
                    Label(strings.saved, systemImage: "checkmark").font(.caption).foregroundStyle(.secondary)
                }
                Button(strings.save) {
                    problem = store.save(serverText: server, token: token)
                    saved = problem == nil
                    if saved { token = "" }
                }
                .keyboardShortcut(.defaultAction)
                .controlSize(.small)
            }
        }
    }

    private var general: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: strings.generalSection)
            Toggle(strings.launchAtLogin, isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, enabled in setLaunchAtLogin(enabled) }
            HStack {
                Button(strings.openDashboard, systemImage: "safari") {
                    if let url = store.serverURL { NSWorkspace.shared.open(url) }
                }
                .disabled(store.serverURL == nil)
                Spacer()
                Button(strings.quit, systemImage: "power") { NSApplication.shared.terminate(nil) }
                    .labelStyle(.iconOnly)
                    .help(strings.quit)
            }
            .controlSize(.small)
        }
    }

    /// A label on the left, its menu on the right.
    private func row<Control: View>(_ label: String, @ViewBuilder control: () -> Control) -> some View {
        HStack {
            Text(label).font(.callout).foregroundStyle(.secondary)
            Spacer(minLength: 8)
            control()
                .pickerStyle(.menu)
                .labelsHidden()
                .controlSize(.small)
                .fixedSize()
        }
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

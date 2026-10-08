import AppKit
import SwiftUI
import UsageRatioCore

/// The popover, a compact card for the selected provider: how much is used and
/// left, a bar with a marker where the cycle stands (ahead of the even pace or
/// not), when it runs out, and which groups and machines took how much.
/// Every choice and setting is behind the gear.
struct PopoverView: View {
    let store: StatusStore
    @State private var showingSettings = false

    /// Machines listed before "+N more".
    private static let machineRows = 6

    var body: some View {
        Group {
            if showingSettings || store.error == .notConfigured {
                SettingsView(store: store, canClose: store.error != .notConfigured) { showingSettings = false }
            } else {
                content
            }
        }
        .padding(16)
        .frame(width: 300)
        .onAppear { store.refreshIfIdle() }
    }

    private var strings: Strings { store.strings }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let payload = store.payload, let provider = store.selectedProvider {
                Text("\(provider.label) · \(Display.periodText(payload.cycle, strings: strings))")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                summary(provider: provider, cycle: payload.cycle)
                if provider.groups.count > 1 {
                    groups(provider)
                }
                if !provider.machines.isEmpty {
                    machines(provider)
                }
            } else {
                Text(store.payload == nil ? "UsageRatio" : strings.noProviders)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            if let error = store.error, !store.isRefreshing {
                Label(strings.message(for: error), systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            footer
        }
    }

    private func summary(provider: StatusPayload.Provider, cycle: StatusPayload.Cycle) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .lastTextBaseline) {
                VStack(alignment: .leading, spacing: 0) {
                    if provider.percent == nil {
                        Text(Display.tokensText(provider.tokens, strings: strings))
                            .font(.system(size: 26, weight: .semibold).monospacedDigit())
                    } else {
                        Text(Display.precisePercentText(provider.percent, strings: strings))
                            .font(.system(size: 34, weight: .semibold).monospacedDigit())
                            .foregroundStyle(provider.status == .good ? Color.primary : statusColor(provider.status))
                    }
                    Text(sourceText(provider)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let remaining = Display.remainingText(provider.percent, strings: strings) {
                    Text(remaining)
                        .font(.callout)
                        .foregroundStyle((provider.percent ?? 0) > 100 ? Color.red : Color.secondary)
                }
            }

            if let percent = provider.percent {
                let elapsed = Display.elapsedPercent(cycle, now: store.now)
                PaceBar(
                    percent: percent,
                    elapsed: elapsed,
                    status: provider.status,
                    elapsedLabel: strings.elapsed(Display.percentText(elapsed))
                )
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(([Display.runOutText(provider, strings: strings), Display.resetText(cycle, strings: strings)]
                    .compactMap { $0 }).joined(separator: " · "))
                if !provider.subLimits.isEmpty {
                    Text(provider.subLimits
                        .map { "\($0.name): \(Display.precisePercentText($0.percent, strings: strings))" }
                        .joined(separator: " · "))
                }
                if let lastReportAt = provider.lastReportAt,
                   store.now.timeIntervalSince(lastReportAt) > Display.staleAfter {
                    Text(strings.lastReport(Display.relative(lastReportAt, now: store.now, strings: strings)))
                        .foregroundStyle(.orange)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
    }

    private func sourceText(_ provider: StatusPayload.Provider) -> String {
        switch provider.source {
        case "official": strings.sourceOfficial
        case "estimate": strings.sourceEstimate
        default: strings.noLimit
        }
    }

    private func groups(_ provider: StatusPayload.Provider) -> some View {
        let fractions = Display.barFractions(provider.groups.map { $0.percent ?? $0.tokens })
        return VStack(spacing: 6) {
            SectionHeader(title: strings.groupsSection)
            ForEach(Array(provider.groups.enumerated()), id: \.element.id) { index, group in
                ShareRow(
                    name: group.id,
                    value: value(percent: group.percent, tokens: group.tokens),
                    fraction: fractions[index],
                    status: Display.shareStatus(group.percent),
                    highlighted: store.selectedScope == .group(group.id),
                    quiet: group.tokens == 0
                )
            }
        }
    }

    private func machines(_ provider: StatusPayload.Provider) -> some View {
        let shown = Array(provider.machines.prefix(Self.machineRows))
        let fractions = Display.barFractions(provider.machines.map { $0.percent ?? $0.tokens })
        return VStack(spacing: 6) {
            SectionHeader(title: strings.machinesSection)
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, machine in
                ShareRow(
                    name: machine.id,
                    value: value(percent: machine.percent, tokens: machine.tokens),
                    fraction: fractions[index],
                    status: Display.shareStatus(machine.percent),
                    highlighted: store.selectedScope == .machine(machine.id),
                    quiet: machine.tokens == 0
                )
            }
            if provider.machines.count > shown.count {
                Text(strings.more(provider.machines.count - shown.count))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func value(percent: Double?, tokens: Double) -> String {
        percent == nil
            ? tokens.formatted(.number.notation(.compactName).locale(strings.locale))
            : Display.precisePercentText(percent, strings: strings)
    }

    private var footer: some View {
        HStack {
            Button { store.restart() } label: {
                Label(updatedText, systemImage: "arrow.clockwise")
                    .font(.caption)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(store.isRefreshing)
            .help(strings.refresh)
            Spacer()
            Button { showingSettings = true } label: {
                Image(systemName: "gearshape").font(.body)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help(strings.settings)
            .accessibilityLabel(strings.settings)
        }
        .padding(.top, 2)
    }

    private var updatedText: String {
        if store.isRefreshing { return strings.refreshing }
        return store.lastSuccess.map { Display.relative($0, now: store.now, strings: strings) } ?? strings.refresh
    }
}

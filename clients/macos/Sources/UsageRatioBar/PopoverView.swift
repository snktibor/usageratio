import AppKit
import SwiftUI
import UsageRatioCore

/// The popover, a card for the selected provider that answers three questions in
/// order: how am I doing (the figure, a status badge, what is left), how long until
/// the reset (the pace bar, when it runs out, when it resets), and who took it (the
/// groups with their machines). Every choice and setting is behind the gear.
struct PopoverView: View {
    let store: StatusStore
    @State private var showingSettings = false

    /// Machines listed before "+N more".
    private static let machineRows = 8

    var body: some View {
        Group {
            if showingSettings || store.error == .notConfigured {
                SettingsView(store: store, canClose: store.error != .notConfigured) { showingSettings = false }
            } else {
                content
            }
        }
        .padding(16)
        .frame(width: 320)
        .onAppear { store.refreshIfIdle() }
        .onDisappear { store.dismissMovedNotes() }
    }

    private var strings: Strings { store.strings }

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let payload = store.payload, let provider = store.selectedProvider {
                let cycle = Display.cycle(of: provider, in: payload)
                header(provider, cycle: cycle)
                summary(provider, cycle: cycle)
                if !provider.subLimits.isEmpty {
                    subLimits(provider)
                }
                breakdown(provider)
            } else {
                Text(store.payload == nil ? "UsageRatio" : strings.noProviders)
                    .font(.headline)
                    .frame(maxWidth: .infinity)
            }
            if let error = store.error, !store.isRefreshing {
                Label(strings.message(for: error), systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            footer
        }
    }

    // MARK: Header

    private func header(_ provider: StatusPayload.Provider, cycle: StatusPayload.Cycle) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(provider.label).font(.headline)
            Text(Display.periodText(cycle, strings: strings))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            if let status = provider.status {
                StatusBadge(status: status, text: Display.statusText(status, strings: strings))
            }
        }
    }

    // MARK: Summary

    private func summary(_ provider: StatusPayload.Provider, cycle: StatusPayload.Cycle) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .lastTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    if provider.percent == nil {
                        Text(Display.tokensText(provider.tokens, strings: strings))
                            .font(.system(size: 26, weight: .semibold, design: .rounded).monospacedDigit())
                    } else {
                        Text(Display.precisePercentText(provider.percent, strings: strings))
                            .font(.system(size: 36, weight: .semibold, design: .rounded).monospacedDigit())
                            .foregroundStyle(provider.status == .good ? Color.primary : statusColor(provider.status))
                    }
                    Text(sourceText(provider)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if let remaining = Display.remainingText(provider.percent, strings: strings) {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(remaining)
                            .font(.callout.weight(.medium))
                            .foregroundStyle((provider.percent ?? 0) > 100 ? Color.red : Color.primary)
                        Text(Display.tokensOfLimitText(provider.tokens, limit: provider.limit, strings: strings))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
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

            facts(provider, cycle: cycle)
        }
    }

    private func sourceText(_ provider: StatusPayload.Provider) -> String {
        switch provider.source {
        case "official": "\(strings.used) · \(strings.sourceOfficial)"
        case "estimate": "\(strings.used) · \(strings.sourceEstimate)"
        default: strings.noLimit
        }
    }

    /// When it runs out, when it resets, and a warning while the figure is stale: one icon and line each.
    private func facts(_ provider: StatusPayload.Provider, cycle: StatusPayload.Cycle) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let runOut = Display.runOutText(provider, strings: strings) {
                let runsOut = provider.pace?.runOutAt != nil
                let lasts = provider.pace?.projectedPercent != nil && !runsOut
                Label(runOut, systemImage: runsOut ? "exclamationmark.triangle.fill" : lasts ? "checkmark.circle.fill" : "clock")
                    .foregroundStyle(runsOut ? Color.orange : lasts ? Color.green : Color.secondary)
            }
            Label(
                "\(Display.resetText(cycle, strings: strings)) · \(Display.relative(cycle.end, now: store.now, strings: strings))",
                systemImage: "arrow.counterclockwise"
            )
            .foregroundStyle(.secondary)
            if let lastReportAt = provider.lastReportAt,
               store.now.timeIntervalSince(lastReportAt) > Display.staleAfter {
                Label(
                    strings.lastReport(Display.relative(lastReportAt, now: store.now, strings: strings)),
                    systemImage: "clock.badge.exclamationmark"
                )
                .foregroundStyle(.orange)
            }
            if let window = store.limits[provider.id]?.fiveHour, window.resetsAt > store.now {
                Label(Display.fiveHourText(window, strings: strings), systemImage: "hourglass")
                    .foregroundStyle(.secondary)
            }
            if let refusal = store.uploadNotes[provider.id] {
                Label(Display.uploadNoteText(refusal, strings: strings), systemImage: "icloud.slash")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let moved = store.movedNotes[provider.id] {
                Label(
                    strings.cycleMoved(provider.label, Display.momentText(moved, strings: strings)),
                    systemImage: "calendar.badge.clock"
                )
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .font(.caption)
        .labelStyle(FactLabelStyle())
    }

    // MARK: Sub-limits

    /// Each in percent of its own budget, so its bar is absolute, not against the heaviest row.
    private func subLimits(_ provider: StatusPayload.Provider) -> some View {
        VStack(spacing: 6) {
            SectionHeader(title: strings.subLimitsSection)
            ForEach(provider.subLimits) { subLimit in
                ShareRow(
                    name: subLimit.name,
                    value: Display.precisePercentText(subLimit.percent, strings: strings),
                    fraction: (subLimit.percent ?? 0) / 100,
                    status: subLimit.status ?? Display.shareStatus(subLimit.percent),
                    quiet: subLimit.percent == nil
                )
            }
        }
    }

    // MARK: Breakdown

    /// The groups with their machines under them; the machines alone while there is one group.
    private func breakdown(_ provider: StatusPayload.Provider) -> some View {
        let (rows, hidden) = Display.breakdown(provider, limit: Self.machineRows)
        let nested = rows.contains { $0.kind == .group }
        return Group {
            if !rows.isEmpty {
                VStack(spacing: 6) {
                    SectionHeader(title: nested ? strings.groupsSection : strings.machinesSection)
                    ForEach(rows, id: \.scope) { row in
                        ShareRow(
                            name: row.id,
                            value: value(percent: row.percent, tokens: row.tokens),
                            fraction: row.fraction,
                            status: Display.shareStatus(row.percent),
                            emphasized: row.kind == .group,
                            indented: nested && row.kind == .machine,
                            highlighted: store.selectedScope == row.scope,
                            highlightedHelp: strings.shownInMenuBar,
                            quiet: row.tokens == 0,
                            stale: staleText(row.lastReportAt)
                        )
                    }
                    if hidden > 0 {
                        Text(strings.more(hidden))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private func staleText(_ lastReportAt: Date?) -> String? {
        guard let lastReportAt, store.now.timeIntervalSince(lastReportAt) > Display.staleAfter else { return nil }
        return strings.lastReport(Display.relative(lastReportAt, now: store.now, strings: strings))
    }

    private func value(percent: Double?, tokens: Double) -> String {
        percent == nil
            ? tokens.formatted(.number.notation(.compactName).locale(strings.locale))
            : Display.precisePercentText(percent, strings: strings)
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 14) {
            Button { store.restart() } label: {
                Label(updatedText, systemImage: "arrow.clockwise")
                    .font(.caption)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(store.isRefreshing)
            .help(strings.refresh)
            Spacer()
            Button {
                if let url = store.serverURL { NSWorkspace.shared.open(url) }
            } label: {
                Image(systemName: "safari").font(.body)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .disabled(store.serverURL == nil)
            .help(strings.openDashboard)
            .accessibilityLabel(strings.openDashboard)
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
        return store.lastSuccess.map { strings.updated(Display.relative($0, now: store.now, strings: strings)) }
            ?? strings.refresh
    }
}

/// An icon of a fixed width, so the facts' text lines up.
private struct FactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            configuration.icon.frame(width: 14)
            configuration.title
        }
    }
}

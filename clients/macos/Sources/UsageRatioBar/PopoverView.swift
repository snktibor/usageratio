import AppKit
import SwiftUI
import UsageRatioCore

/// The popover: every provider with its bar, sub-limits, source and pace,
/// the reset countdown, and the buttons. A click on a provider puts it in the
/// menu bar. The settings screen takes its place when the gear is pressed.
struct PopoverView: View {
    let store: StatusStore
    @State private var showingSettings = false

    var body: some View {
        Group {
            if showingSettings || store.error == .notConfigured {
                SettingsView(store: store, canCancel: store.error != .notConfigured) { showingSettings = false }
            } else {
                content
            }
        }
        .padding(14)
        .frame(width: 330)
        .onAppear { store.refreshIfIdle() }
    }

    private var strings: Strings { store.strings }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let payload = store.payload {
                if payload.providers.isEmpty {
                    Text(strings.noProviders).font(.callout).foregroundStyle(.secondary)
                } else {
                    ForEach(payload.providers) { provider in
                        ProviderRow(
                            provider: provider,
                            selected: provider.id == store.selectedProvider?.id,
                            strings: strings,
                            now: store.now
                        ) { store.selectedProviderId = provider.id }
                    }
                    if payload.providers.count > 1 {
                        Text(strings.selectHint).font(.caption2).foregroundStyle(.tertiary)
                    }
                }
            }
            Divider()
            footer
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text("UsageRatio").font(.headline)
                Spacer()
                if let cycle = store.payload?.cycle {
                    Text(Display.cycleTitle(cycle, strings: strings)).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let cycle = store.payload?.cycle {
                Text(Display.resetLine(cycle, now: store.now, strings: strings))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            Group {
                if store.isRefreshing {
                    Text(strings.refreshing).foregroundStyle(.secondary)
                } else if let error = store.error {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(strings.message(for: error), systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                        // What is on screen is from then.
                        if let lastSuccess = store.lastSuccess {
                            Text(strings.updated(Display.relative(lastSuccess, now: store.now, strings: strings)))
                                .foregroundStyle(.secondary)
                        }
                    }
                } else if let lastSuccess = store.lastSuccess {
                    Text(strings.updated(Display.relative(lastSuccess, now: store.now, strings: strings)))
                        .foregroundStyle(.secondary)
                }
            }
            .font(.caption)

            HStack(spacing: 8) {
                Button(strings.refresh, systemImage: "arrow.clockwise") { store.restart() }
                    .disabled(store.isRefreshing)
                Button(strings.dashboard, systemImage: "safari") {
                    if let url = store.serverURL { NSWorkspace.shared.open(url) }
                }
                .help(strings.openDashboard)
                .disabled(store.serverURL == nil)
                Spacer()
                Button(strings.settings, systemImage: "gearshape") { showingSettings = true }
                    .labelStyle(.iconOnly)
                    .help(strings.settings)
                Button(strings.quit, systemImage: "power") { NSApplication.shared.terminate(nil) }
                    .labelStyle(.iconOnly)
                    .help(strings.quit)
            }
            .controlSize(.small)
        }
    }
}

private struct ProviderRow: View {
    let provider: StatusPayload.Provider
    let selected: Bool
    let strings: Strings
    let now: Date
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                        .font(.caption)
                    Text(provider.label).font(.subheadline.weight(.semibold))
                    if provider.source != nil {
                        Text(provider.isOfficial ? strings.official : strings.estimate)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .overlay(Capsule().strokeBorder(.tertiary))
                    }
                    Spacer()
                    if provider.percent == nil {
                        // Nothing to measure it against: what was used is all there is to say.
                        Text(Display.tokensText(provider.tokens, strings: strings))
                            .font(.callout.monospacedDigit())
                            .foregroundStyle(.secondary)
                    } else {
                        Text(Display.precisePercentText(provider.percent, strings: strings))
                            .font(.title3.weight(.semibold).monospacedDigit())
                            .foregroundStyle(provider.status == .good || provider.status == nil
                                ? Color.primary : UsageBar.color(provider.status))
                    }
                }

                if provider.percent == nil {
                    Text(strings.noLimit).font(.caption).foregroundStyle(.secondary)
                } else {
                    UsageBar(percent: provider.percent, status: provider.status)
                    if let pace = Display.paceLine(provider, strings: strings) {
                        Text(pace).font(.caption).foregroundStyle(.secondary)
                    }
                }

                ForEach(provider.subLimits) { sub in
                    HStack(spacing: 6) {
                        Text(sub.name).font(.caption).frame(width: 80, alignment: .leading).lineLimit(1)
                        UsageBar(percent: sub.percent, status: sub.status, height: 4)
                        Text(Display.precisePercentText(sub.percent, strings: strings))
                            .font(.caption.monospacedDigit())
                            .frame(width: 44, alignment: .trailing)
                    }
                    .padding(.leading, 18)
                }

                reportLine.font(.caption2)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder
    private var reportLine: some View {
        if let lastReportAt = provider.lastReportAt {
            let stale = now.timeIntervalSince(lastReportAt) > Display.staleAfter
            Text(strings.lastReport(Display.relative(lastReportAt, now: now, strings: strings)))
                .foregroundStyle(stale ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.tertiary))
        } else {
            Text(strings.noReport).foregroundStyle(.tertiary)
        }
    }
}

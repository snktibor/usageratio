import SwiftUI
import UsageRatioCore

/// The accent while all is well, orange past the warning level, red when critical.
func statusColor(_ status: QuotaStatus?) -> Color {
    switch status {
    case .warning: .orange
    case .critical: .red
    default: .accentColor
    }
}

/// "● Warning": a tinted capsule in the card's header. Green while all is well, so the
/// state reads without the colour too, next to the plain (uncoloured) big figure.
struct StatusBadge: View {
    let status: QuotaStatus
    let text: String

    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text).font(.caption.weight(.medium))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(color)
        .background(color.opacity(0.14), in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private var color: Color { status == .good ? .green : statusColor(status) }
}

/// The purple of the moment the pace runs out: its marker on a bar, and the tick before its line.
extension Color {
    static let runOut = Color(red: 0.66, green: 0.44, blue: 1)
}

/// The tick before "runs out at …", the same mark as on the bar above it.
struct RunOutTick: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(Color.runOut)
            .frame(width: 2.5, height: 11)
            // Level with the text beside it, as an SF Symbol sits.
            .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1.5 }
            .accessibilityHidden(true)
    }
}

/// The budget used, with a marker where the time stands (a fill past it is ahead of the even pace)
/// and, in purple, one where the pace runs out before the reset.
struct PaceBar: View {
    let percent: Double
    /// Of the time gone by, 0–100; nil: no window is running, so no marker.
    let elapsed: Double?
    let status: QuotaStatus?
    /// "▲ time elapsed 47%" under the marker; nil: no label (the 5-hour bar writes its own line).
    var elapsedLabel: String?
    /// Where the pace runs out, 0–100; nil while it lasts.
    var runOut: Double?
    var height: CGFloat = 8

    var body: some View {
        VStack(spacing: 7) {
            GeometryReader { geometry in
                let width = geometry.size.width
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.1))
                    if percent > 0 {
                        Capsule()
                            .fill(statusColor(status).gradient)
                            .frame(width: max(height, width * min(percent, 100) / 100))
                    }
                    if let elapsed { marker(at: elapsed, in: width, color: Color.primary.opacity(0.8)) }
                    if let runOut { marker(at: runOut, in: width, color: .runOut) }
                }
            }
            .frame(height: height)

            if let elapsedLabel, let elapsed {
                // Under the marker: to its right in the first half, to its left after.
                GeometryReader { geometry in
                    let x = geometry.size.width * elapsed / 100
                    Group {
                        if elapsed <= 50 {
                            Text("▲ \(elapsedLabel)")
                                .padding(.leading, max(0, x - 4))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else {
                            Text("\(elapsedLabel) ▲")
                                .padding(.trailing, max(0, geometry.size.width - x - 4))
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }
                .frame(height: 13)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(["\(Int(percent.rounded()))%", elapsedLabel].compactMap { $0 }.joined(separator: ", "))
    }

    private func marker(at position: Double, in width: CGFloat, color: Color) -> some View {
        RoundedRectangle(cornerRadius: 1)
            .fill(color)
            .frame(width: 2, height: height + 4)
            .offset(x: min(width - 2, max(0, width * position / 100 - 1)))
    }
}

/// One row with a bar: a group, a machine under its group, or a sub-limit.
struct ShareRow: View {
    let name: String
    let value: String
    /// Of the bar's full width.
    let fraction: Double
    let status: QuotaStatus?
    /// A group row: bold, with its machines indented under it.
    var emphasized = false
    /// A machine under its group.
    var indented = false
    /// The one the menu bar shows: marked with a menu bar icon, carrying `highlightedHelp`.
    var highlighted = false
    var highlightedHelp = ""
    /// No usage this cycle.
    var quiet = false
    /// "Last report 3 hours ago" while a machine's newest report is old; nil otherwise.
    var stale: String?

    private static let nameWidth: CGFloat = 108
    private static let indent: CGFloat = 14

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 4) {
                Text(name)
                    .fontWeight(emphasized ? .semibold : .regular)
                    .foregroundStyle(highlighted ? Color.accentColor : quiet ? Color.secondary : Color.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let stale {
                    Image(systemName: "clock.badge.exclamationmark")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .help(stale)
                        .accessibilityLabel(stale)
                }
                if highlighted {
                    Image(systemName: "menubar.rectangle")
                        .font(.caption2)
                        .foregroundStyle(Color.accentColor)
                        .help(highlightedHelp)
                        .accessibilityLabel(highlightedHelp)
                }
            }
            .padding(.leading, indented ? Self.indent : 0)
            .frame(width: Self.nameWidth, alignment: .leading)

            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.1))
                    if fraction > 0 {
                        Capsule()
                            .fill(statusColor(status).opacity(highlighted || emphasized ? 1 : 0.7))
                            .frame(width: max(4, geometry.size.width * min(1, fraction)))
                    }
                }
            }
            .frame(height: 6)

            Text(value)
                .monospacedDigit()
                .fontWeight(emphasized ? .semibold : .regular)
                .foregroundStyle(quiet ? .secondary : .primary)
                .frame(width: 56, alignment: .trailing)
        }
        .font(.callout)
        .accessibilityElement(children: .combine)
    }
}

/// "MACHINES": a small, spaced-out heading over a hairline, as the System Settings panes have.
struct SectionHeader: View {
    let title: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            Text(title)
                .font(.caption2.weight(.semibold))
                .tracking(1)
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityAddTraits(.isHeader)
    }
}

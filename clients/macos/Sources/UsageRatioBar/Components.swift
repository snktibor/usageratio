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

/// The budget used, with a marker where the cycle stands: a fill past the marker is ahead of the even pace.
struct PaceBar: View {
    let percent: Double
    let elapsed: Double
    let status: QuotaStatus?
    let elapsedLabel: String

    var body: some View {
        VStack(spacing: 3) {
            GeometryReader { geometry in
                let width = geometry.size.width
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.2))
                    Capsule()
                        .fill(statusColor(status))
                        .frame(width: max(6, width * min(percent, 100) / 100))
                    RoundedRectangle(cornerRadius: 1)
                        .fill(Color.primary)
                        .frame(width: 2, height: 16)
                        .offset(x: min(width - 2, max(0, width * elapsed / 100 - 1)))
                }
            }
            .frame(height: 10)

            // "▲ time elapsed 47%" under the marker: to its right in the first half, to its left after.
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
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Int(percent.rounded()))%, \(elapsedLabel)")
    }
}

/// One group or machine: its name, a bar against the heaviest row, its figure.
struct ShareRow: View {
    let name: String
    let value: String
    let fraction: Double
    let status: QuotaStatus?
    /// The one the menu bar shows.
    let highlighted: Bool
    /// No usage this cycle.
    let quiet: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text(name)
                .fontWeight(highlighted ? .semibold : .regular)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(width: 96, alignment: .leading)
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.secondary.opacity(0.2))
                    if fraction > 0 {
                        Capsule()
                            .fill(highlighted ? statusColor(status) : statusColor(status).opacity(0.75))
                            .frame(width: max(4, geometry.size.width * fraction))
                    }
                }
            }
            .frame(height: 6)
            Text(value)
                .monospacedDigit()
                .fontWeight(highlighted ? .semibold : .regular)
                .frame(width: 58, alignment: .trailing)
        }
        .font(.callout)
        .foregroundStyle(quiet ? .secondary : .primary)
    }
}

/// "—— MACHINES ——": a centred, spaced-out heading between two hairlines.
struct SectionHeader: View {
    let title: String

    var body: some View {
        HStack(spacing: 8) {
            line
            Text(title)
                .font(.caption2.weight(.semibold))
                .tracking(1.2)
                .textCase(.uppercase)
                .foregroundStyle(.secondary)
                .fixedSize()
            line
        }
        .accessibilityAddTraits(.isHeader)
    }

    private var line: some View {
        Rectangle().fill(Color.secondary.opacity(0.3)).frame(height: 1)
    }
}

import SwiftUI
import UsageRatioCore

/// A thin bar for a percentage, coloured by its status; full at 100% and beyond.
struct UsageBar: View {
    let percent: Double?
    let status: QuotaStatus?
    var height: CGFloat = 6

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                if let percent {
                    Capsule()
                        .fill(Self.color(status))
                        .frame(width: geometry.size.width * min(max(percent, 0), 100) / 100)
                }
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }

    static func color(_ status: QuotaStatus?) -> Color {
        switch status {
        case .warning: .orange
        case .critical: .red
        default: .accentColor
        }
    }
}

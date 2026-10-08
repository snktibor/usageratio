import AppKit
import SwiftUI
import UsageRatioCore

/// What sits in the menu bar: a gauge and the chosen provider's percentage.
/// Drawn into an image, since a menu bar label is otherwise always
/// monochrome: a template image (adapts to light/dark) while all is well,
/// orange or red past the warning level, dimmed while the figure is stale.
struct MenuBarLabel: View {
    let store: StatusStore

    var body: some View {
        let provider = store.selectedProvider
        let figure = store.menuBarFigure
        if store.payload == nil, let error = store.error, error != .notConfigured {
            Image(nsImage: Self.render(symbol: "exclamationmark.triangle", text: nil, color: nil, dimmed: false))
        } else {
            Image(nsImage: Self.render(
                symbol: Display.gaugeSymbol(figure?.percent),
                text: Display.percentText(figure?.percent),
                color: Self.color(figure?.status),
                dimmed: store.isStale
            ))
            .accessibilityLabel(
                [provider?.label ?? "UsageRatio", figure?.name, Display.percentText(figure?.percent)]
                    .compactMap { $0 }
                    .joined(separator: " ")
            )
        }
    }

    private static func color(_ status: QuotaStatus?) -> Color? {
        switch status {
        case .warning: .orange
        case .critical: .red
        default: nil
        }
    }

    private static func render(symbol: String, text: String?, color: Color?, dimmed: Bool) -> NSImage {
        let content = HStack(spacing: 3) {
            Image(systemName: symbol)
            if let text { Text(text).monospacedDigit() }
        }
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(color ?? .black)
        .opacity(dimmed ? 0.45 : 1)
        .fixedSize()

        let renderer = ImageRenderer(content: content)
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2
        let image = renderer.nsImage ?? NSImage()
        image.isTemplate = color == nil
        return image
    }
}

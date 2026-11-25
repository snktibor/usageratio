import AppKit
import SwiftUI
import UsageRatioCore

/// What sits in the menu bar, in the chosen style: a number with a progress ring around it (by default
/// the cycle's percentage inside, the 5-hour window around), a gauge and the percentage, or the
/// percentage alone. Drawn into an image, since a menu bar label is otherwise always monochrome: a
/// template image (adapts to light/dark) while all is well, orange or red past the warning level,
/// dimmed while the figure is stale.
struct MenuBarLabel: View {
    let store: StatusStore
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if store.payload == nil, let error = store.error, error != .notConfigured {
            Image(nsImage: Self.render(symbol: "exclamationmark.triangle", text: nil, color: nil, dimmed: false))
        } else {
            let figures = Display.iconFigures(
                cycle: store.menuBarFigure, fiveHour: store.fiveHour, number: store.iconNumber, ring: store.iconRing
            )
            image(number: figures.number, ring: figures.ring)
                .accessibilityLabel(accessibilityText)
        }
    }

    private func image(number: IconFigure, ring: IconFigure) -> Image {
        switch store.menuBarStyle {
        case .ring:
            Image(nsImage: Self.renderRing(number: number, ring: ring, dimmed: store.isStale, dark: colorScheme == .dark))
        case .classic:
            Image(nsImage: Self.render(
                symbol: Display.gaugeSymbol(number.percent), text: Display.percentText(number.percent),
                color: Self.color(number.status), dimmed: store.isStale
            ))
        case .number:
            Image(nsImage: Self.render(
                symbol: nil, text: Display.percentText(number.percent), color: Self.color(number.status), dimmed: store.isStale
            ))
        }
    }

    /// "Claude tibusz 18%, 5-hour window 62%".
    private var accessibilityText: String {
        let cycle = [store.selectedProvider?.label ?? "UsageRatio", store.menuBarFigure?.name, Display.percentText(store.menuBarFigure?.percent)]
            .compactMap { $0 }
            .joined(separator: " ")
        guard let fiveHour = store.fiveHour else { return cycle }
        return "\(cycle), \(store.strings.fiveHourSection) \(Display.percentText(fiveHour.percent))"
    }

    private static func color(_ status: QuotaStatus?) -> Color? {
        switch status {
        case .warning: .orange
        case .critical: .red
        default: nil
        }
    }

    private static func render(symbol: String?, text: String?, color: Color?, dimmed: Bool) -> NSImage {
        let content = HStack(spacing: 3) {
            if let symbol { Image(systemName: symbol) }
            if let text { Text(text).monospacedDigit() }
        }
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(color ?? .black)
        .opacity(dimmed ? 0.45 : 1)
        .fixedSize()
        return image(of: content, template: color == nil)
    }

    /// The ring and the number each take their own warning colour. A template image is all one colour,
    /// so once either is coloured the rest is drawn in the menu bar's own black or white.
    private static func renderRing(number: IconFigure, ring: IconFigure, dimmed: Bool, dark: Bool) -> NSImage {
        let numberColor = color(number.status)
        let ringColor = color(ring.status)
        let template = numberColor == nil && ringColor == nil
        let neutral: Color = template || !dark ? .black : .white
        let text = Display.ringNumberText(number.percent)
        let fraction = min(1, max(0, (ring.percent ?? 0) / 100))
        let lineWidth: CGFloat = 1.8

        let content = ZStack {
            Circle()
                .inset(by: lineWidth / 2)
                .stroke(neutral.opacity(0.3), lineWidth: lineWidth)
            if fraction > 0 {
                Circle()
                    .inset(by: lineWidth / 2)
                    .trim(from: 0, to: fraction)
                    .stroke(ringColor ?? neutral, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            Text(text)
                .font(.system(size: text.count > 2 ? 7 : 8.5, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(numberColor ?? neutral)
        }
        .frame(width: 18, height: 18)
        .opacity(dimmed ? 0.45 : 1)
        return image(of: content, template: template)
    }

    private static func image(of content: some View, template: Bool) -> NSImage {
        let renderer = ImageRenderer(content: content)
        renderer.scale = NSScreen.main?.backingScaleFactor ?? 2
        let image = renderer.nsImage ?? NSImage()
        image.isTemplate = template
        return image
    }
}

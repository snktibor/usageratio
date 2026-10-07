import Foundation

/// How the figures read in the menu bar and the popover. Pure: every function
/// takes `now` and the wording, so the tests can pin both.
public enum Display {
    /// Older than this, a figure is shown dimmed: the machines report hourly, so two hours means a gap.
    public static let staleAfter: TimeInterval = 2 * 3600

    /// "62%", "112%" over the limit, "–" while unknown: whole numbers, for the menu bar.
    public static func percentText(_ percent: Double?) -> String {
        guard let percent, percent.isFinite else { return "–" }
        return "\(Int(percent.rounded()))%"
    }

    /// "62.5%" ("62,5%" in Hungarian and German): one decimal at most, as the dashboard shows it.
    public static func precisePercentText(_ percent: Double?, strings: Strings) -> String {
        guard let percent, percent.isFinite else { return "–" }
        return percent.formatted(.number.precision(.fractionLength(0...1)).locale(strings.locale)) + "%"
    }

    /// "30K tokens".
    public static func tokensText(_ tokens: Double, strings: Strings) -> String {
        strings.tokens(tokens.formatted(.number.notation(.compactName).locale(strings.locale)))
    }

    /// An SF Symbol gauge whose needle follows the percentage.
    public static func gaugeSymbol(_ percent: Double?) -> String {
        guard let percent else { return "gauge.with.dots.needle.0percent" }
        switch percent {
        case ..<17: return "gauge.with.dots.needle.0percent"
        case ..<42: return "gauge.with.dots.needle.33percent"
        case ..<58: return "gauge.with.dots.needle.50percent"
        case ..<84: return "gauge.with.dots.needle.67percent"
        default: return "gauge.with.dots.needle.100percent"
        }
    }

    /// The provider the menu bar shows: the chosen one while it is still listed, else the first.
    public static func selectedProvider(
        in payload: StatusPayload?, id: String?
    ) -> StatusPayload.Provider? {
        guard let providers = payload?.providers else { return nil }
        return providers.first { $0.id == id } ?? providers.first
    }

    /// True when the last successful lookup, or the newest report behind the figure, is older than `staleAfter`.
    public static func isStale(_ provider: StatusPayload.Provider?, lastSuccess: Date?, now: Date) -> Bool {
        guard let lastSuccess else { return false }
        if now.timeIntervalSince(lastSuccess) > staleAfter { return true }
        guard let lastReportAt = provider?.lastReportAt else { return false }
        return now.timeIntervalSince(lastReportAt) > staleAfter
    }

    /// "3d 4h" (in the app's language): at most the two largest units.
    public static func countdown(from now: Date, to end: Date, strings: Strings) -> String {
        let formatter = DateComponentsFormatter()
        var calendar = Calendar.current
        calendar.locale = strings.locale
        formatter.calendar = calendar
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        formatter.allowedUnits = [.day, .hour, .minute]
        return formatter.string(from: max(60, end.timeIntervalSince(now))) ?? ""
    }

    /// "Monday 09:00": weekday and time, in this Mac's time zone.
    public static func shortDate(_ date: Date, strings: Strings) -> String {
        let formatter = DateFormatter()
        formatter.locale = strings.locale
        formatter.setLocalizedDateFormatFromTemplate("EEEEjmm")
        return formatter.string(from: date)
    }

    /// "5 min ago".
    public static func relative(_ date: Date, now: Date, strings: Strings) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = strings.locale
        formatter.unitsStyle = .short
        // Under a minute reads "now" rather than a count of seconds.
        if abs(now.timeIntervalSince(date)) < 60 { return formatter.localizedString(fromTimeInterval: 0) }
        return formatter.localizedString(for: date, relativeTo: now)
    }

    public static func resetLine(_ cycle: StatusPayload.Cycle, now: Date, strings: Strings) -> String {
        strings.resetsIn(countdown(from: now, to: cycle.end, strings: strings), shortDate(cycle.end, strings: strings))
    }

    public static func cycleTitle(_ cycle: StatusPayload.Cycle, strings: Strings) -> String {
        cycle.period == "monthly" ? strings.monthlyCycle : strings.weeklyCycle
    }

    /// The pace under a provider's bar; nil while there is no percentage to project.
    public static func paceLine(_ provider: StatusPayload.Provider, strings: Strings) -> String? {
        guard provider.percent != nil, let pace = provider.pace else { return nil }
        guard let projected = pace.projectedPercent else { return strings.paceTooEarly }
        if let runOutAt = pace.runOutAt {
            return strings.paceRunsOut(percentText(projected), shortDate(runOutAt, strings: strings))
        }
        return strings.paceProjection(percentText(projected))
    }
}

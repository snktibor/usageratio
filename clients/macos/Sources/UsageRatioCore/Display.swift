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

    /// The figure the menu bar shows: the provider's own, or one group's or machine's part of it.
    /// A group or machine no longer listed falls back to the provider's.
    public static func figure(of provider: StatusPayload.Provider, scope: MenuBarScope) -> MenuBarFigure {
        switch scope {
        case .group(let id):
            if let group = provider.groups.first(where: { $0.id == id }) {
                let newest = provider.machines.filter { $0.groupId == id }.map(\.lastReportAt).max()
                return MenuBarFigure(name: id, percent: group.percent, status: shareStatus(group.percent), lastReportAt: newest)
            }
        case .machine(let id):
            if let machine = provider.machines.first(where: { $0.id == id }) {
                return MenuBarFigure(
                    name: id, percent: machine.percent, status: shareStatus(machine.percent), lastReportAt: machine.lastReportAt
                )
            }
        case .total:
            break
        }
        return MenuBarFigure(name: nil, percent: provider.percent, status: provider.status, lastReportAt: provider.lastReportAt)
    }

    /// A group's or machine's part has no pace of its own: only the levels the dashboard warns at.
    public static func shareStatus(_ percent: Double?) -> QuotaStatus? {
        guard let percent else { return nil }
        return percent >= 100 ? .critical : percent >= 80 ? .warning : .good
    }

    /// True when the last successful lookup, or the newest report behind the figure, is older than `staleAfter`.
    public static func isStale(lastReportAt: Date?, lastSuccess: Date?, now: Date) -> Bool {
        guard let lastSuccess else { return false }
        if now.timeIntervalSince(lastSuccess) > staleAfter { return true }
        guard let lastReportAt else { return false }
        return now.timeIntervalSince(lastReportAt) > staleAfter
    }

    /// "mac-studio · 23,4%" in the scope picker, or its tokens while there is no percentage.
    public static func shareText(name: String, percent: Double?, tokens: Double, strings: Strings) -> String {
        let figure = percent == nil ? tokensText(tokens, strings: strings) : precisePercentText(percent, strings: strings)
        return "\(name) · \(figure)"
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
        // Under a minute reads "now" ("most", "jetzt"): the numeric style would say "in 0 seconds".
        if abs(now.timeIntervalSince(date)) < 60 {
            formatter.dateTimeStyle = .named
            return formatter.localizedString(fromTimeInterval: 0)
        }
        return formatter.localizedString(for: date, relativeTo: now)
    }

    /// "Reset: Monday 02:00".
    public static func resetText(_ cycle: StatusPayload.Cycle, strings: Strings) -> String {
        strings.reset(shortDate(cycle.end, strings: strings))
    }

    /// "weekly" / "monthly", after the provider's name.
    public static func periodText(_ cycle: StatusPayload.Cycle, strings: Strings) -> String {
        cycle.period == "monthly" ? strings.monthly : strings.weekly
    }

    /// How much of the cycle has gone by, 0–100.
    public static func elapsedPercent(_ cycle: StatusPayload.Cycle, now: Date) -> Double {
        let length = cycle.end.timeIntervalSince(cycle.start)
        guard length > 0 else { return 0 }
        return min(100, max(0, now.timeIntervalSince(cycle.start) / length * 100))
    }

    /// "Runs out Saturday 06:25", or that it lasts; nil while there is no percentage.
    public static func runOutText(_ provider: StatusPayload.Provider, strings: Strings) -> String? {
        guard provider.percent != nil, let pace = provider.pace else { return nil }
        if let runOutAt = pace.runOutAt { return strings.runsOut(shortDate(runOutAt, strings: strings)) }
        return pace.projectedPercent == nil ? strings.tooEarly : strings.lastsUntilReset
    }

    /// "37.5% left", or "Over by 12.5%" past the limit; nil while there is no percentage.
    public static func remainingText(_ percent: Double?, strings: Strings) -> String? {
        guard let percent else { return nil }
        return percent > 100
            ? strings.over(precisePercentText(percent - 100, strings: strings))
            : strings.remaining(precisePercentText(100 - percent, strings: strings))
    }

    /// Each row's bar against the heaviest row, so the differences show even when all are small.
    public static func barFractions(_ values: [Double]) -> [Double] {
        let top = values.max() ?? 0
        return values.map { top > 0 ? max(0, $0) / top : 0 }
    }
}

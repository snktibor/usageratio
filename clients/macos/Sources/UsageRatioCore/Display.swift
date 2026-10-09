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

    /// The provider's own cycle (start and end) under the payload's period and time zone; the payload's cycle without one.
    public static func cycle(of provider: StatusPayload.Provider, in payload: StatusPayload) -> StatusPayload.Cycle {
        guard let own = provider.cycle else { return payload.cycle }
        return StatusPayload.Cycle(
            period: payload.cycle.period, start: own.start, end: own.end, timeZone: payload.cycle.timeZone
        )
    }

    /// "5-hour window: 23% · resets 14:30".
    public static func fiveHourText(_ window: LimitWindow, strings: Strings) -> String {
        let formatter = DateFormatter()
        formatter.locale = strings.locale
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        return strings.fiveHourWindow(percentText(window.usedPercent), formatter.string(from: window.resetsAt))
    }

    /// "Thursday 09:00": the weekday (0 = Sunday) and time a cycle resets at, as the dashboard writes it.
    public static func momentText(_ moment: ResetMoment, strings: Strings) -> String {
        let formatter = DateFormatter()
        formatter.locale = strings.locale
        let names = formatter.standaloneWeekdaySymbols ?? []
        var day = names.indices.contains(moment.weekday) ? names[moment.weekday] : ""
        if strings.languageCode == "hu" { day = day.lowercased() }
        return "\(day) " + String(format: "%02d:%02d", moment.hour, moment.minute)
    }

    /// Why an upload was declined.
    public static func uploadNoteText(_ refusal: OfficialReportRefusal, strings: Strings) -> String {
        switch refusal {
        case .notOfficialToken: strings.uploadNotOfficialToken
        case .periodNotWeekly: strings.uploadMonthly
        case .staleReading: strings.uploadStale
        }
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

    /// "41.2M / 70M tokens" while there is a limit, "41.2M tokens" otherwise.
    public static func tokensOfLimitText(_ tokens: Double, limit: Double?, strings: Strings) -> String {
        let compact = { (value: Double) in value.formatted(.number.notation(.compactName).locale(strings.locale)) }
        guard let limit, limit > 0 else { return tokensText(tokens, strings: strings) }
        return strings.tokensOfLimit(compact(tokens), compact(limit))
    }

    /// The status badge's wording.
    public static func statusText(_ status: QuotaStatus, strings: Strings) -> String {
        switch status {
        case .good: strings.statusGood
        case .warning: strings.statusWarning
        case .critical: strings.statusCritical
        }
    }

    /// One row of the breakdown: a group, or a machine under its group.
    public struct BreakdownRow: Equatable, Sendable {
        public enum Kind: Equatable, Sendable { case group, machine }
        public let kind: Kind
        public let id: String
        public let percent: Double?
        public let tokens: Double
        /// Its bar against the heaviest group (or machine, when the machines stand alone).
        public let fraction: Double
        /// A machine's newest report; nil for a group.
        public let lastReportAt: Date?
        public let scope: MenuBarScope
    }

    /// The breakdown as a tree: every group with its machines under it, in the server's order.
    /// With one group (or none) the machines stand alone, since the group would only repeat the total.
    /// At most `limit` machines are listed; the rest is counted in `hidden`.
    public static func breakdown(
        _ provider: StatusPayload.Provider, limit: Int
    ) -> (rows: [BreakdownRow], hidden: Int) {
        let value = { (percent: Double?, tokens: Double) in percent ?? tokens }
        let nested = provider.groups.count > 1
        let shown = Array(provider.machines.prefix(limit))
        let hidden = provider.machines.count - shown.count
        let top = (nested ? provider.groups.map { value($0.percent, $0.tokens) } : shown.map { value($0.percent, $0.tokens) })
            .max() ?? 0
        let fraction = { (percent: Double?, tokens: Double) in top > 0 ? max(0, value(percent, tokens)) / top : 0 }
        let machineRow = { (machine: StatusPayload.Machine) in
            BreakdownRow(
                kind: .machine, id: machine.id, percent: machine.percent, tokens: machine.tokens,
                fraction: fraction(machine.percent, machine.tokens), lastReportAt: machine.lastReportAt,
                scope: .machine(machine.id)
            )
        }
        guard nested else { return (shown.map(machineRow), hidden) }

        var rows: [BreakdownRow] = []
        var placed = Set<String>()
        for group in provider.groups {
            rows.append(BreakdownRow(
                kind: .group, id: group.id, percent: group.percent, tokens: group.tokens,
                fraction: fraction(group.percent, group.tokens), lastReportAt: nil, scope: .group(group.id)
            ))
            for machine in shown where machine.groupId == group.id {
                rows.append(machineRow(machine))
                placed.insert(machine.id)
            }
        }
        // A machine whose group is not listed (should not happen): at the end, rather than lost.
        rows += shown.filter { !placed.contains($0.id) }.map(machineRow)
        return (rows, hidden)
    }
}

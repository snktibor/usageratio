import Foundation

/// How the menu bar draws its figure.
public enum MenuBarStyle: String, CaseIterable, Sendable {
    /// A number with a progress ring around it.
    case ring
    /// A gauge symbol and the percentage.
    case classic
    /// The percentage alone.
    case number
}

/// Which window a part of the menu bar icon follows.
public enum MenuBarWindow: String, CaseIterable, Sendable {
    /// The selected provider's cycle (weekly or monthly), in the chosen scope.
    case cycle
    /// The provider's own 5-hour window, as read on this Mac.
    case fiveHour
}

/// When the card lists the groups and machines behind the figure.
public enum BreakdownMode: String, CaseIterable, Sendable {
    /// Only when more than one machine reported in this cycle: one machine would only repeat the total.
    case auto
    case always
    case never
}

/// One figure of the menu bar icon: how far, and its warning level.
public struct IconFigure: Equatable, Sendable {
    public let percent: Double?
    public let status: QuotaStatus?

    public init(percent: Double?, status: QuotaStatus?) {
        self.percent = percent
        self.status = status
    }
}

/// The 5-hour window as the card and the icon show it, as of `now`.
public struct FiveHourView: Equatable, Sendable {
    public enum Outlook: Equatable, Sendable {
        /// The window is over and no request has started a new one.
        case idle
        /// Too little of the window has gone by for a pace.
        case tooEarly
        case lasts
        case runsOut(Date)
        case usedUp
    }

    /// Used, 0–100 (more past the limit); 0 while idle.
    public let percent: Double
    /// Of the window gone by, 0–100; 0 while idle.
    public let elapsed: Double
    /// Nil while idle.
    public let resetsAt: Date?
    public let outlook: FiveHourView.Outlook

    /// Where the pace runs out along the bar, 0–100; nil when it lasts.
    public var runOutPercent: Double? {
        guard case .runsOut(let date) = outlook, let resetsAt else { return nil }
        return Display.position(of: date, from: resetsAt.addingTimeInterval(-Display.fiveHourLength), to: resetsAt)
    }
}

extension Display {
    public static let fiveHourLength: TimeInterval = 5 * 3600
    /// Before this much of the window, a pace would be a guess from a single request.
    public static let fiveHourPaceAfter: TimeInterval = 15 * 60

    /// The window from the provider's own reading. A window whose reset has passed is over: nothing
    /// is used until the next request opens one (and the next reading tells). The pace is the
    /// window's average so far, carried on in a straight line.
    public static func fiveHour(_ window: LimitWindow?, now: Date) -> FiveHourView? {
        guard let window else { return nil }
        guard window.resetsAt > now else {
            return FiveHourView(percent: 0, elapsed: 0, resetsAt: nil, outlook: .idle)
        }
        let start = window.resetsAt.addingTimeInterval(-fiveHourLength)
        let gone = max(0, now.timeIntervalSince(start))
        let used = max(0, window.usedPercent)
        let outlook: FiveHourView.Outlook
        if used >= 100 {
            outlook = .usedUp
        } else if gone < fiveHourPaceAfter {
            outlook = .tooEarly
        } else if used == 0 {
            outlook = .lasts
        } else {
            let runOut = start.addingTimeInterval(gone * 100 / used)
            outlook = runOut < window.resetsAt ? .runsOut(runOut) : .lasts
        }
        return FiveHourView(
            percent: used, elapsed: min(100, gone / fiveHourLength * 100), resetsAt: window.resetsAt, outlook: outlook
        )
    }

    /// How far `date` lies from `start` to `end`, 0–100.
    public static func position(of date: Date, from start: Date, to end: Date) -> Double {
        let length = end.timeIntervalSince(start)
        guard length > 0 else { return 0 }
        return min(100, max(0, date.timeIntervalSince(start) / length * 100))
    }

    /// Where the cycle runs out at its average pace along its bar, 0–100; nil when it lasts.
    public static func runOutPercent(_ provider: StatusPayload.Provider, cycle: StatusPayload.Cycle) -> Double? {
        guard provider.percent != nil, let runOutAt = provider.pace?.runOutAt, runOutAt < cycle.end else { return nil }
        return position(of: runOutAt, from: cycle.start, to: cycle.end)
    }

    /// The number's and the ring's figures. The 5-hour window stands in only while there is a reading
    /// of it; otherwise that part shows the cycle's figure too.
    public static func iconFigures(
        cycle: MenuBarFigure?, fiveHour: FiveHourView?, number: MenuBarWindow, ring: MenuBarWindow
    ) -> (number: IconFigure, ring: IconFigure) {
        let cycleFigure = IconFigure(percent: cycle?.percent, status: cycle?.status)
        let pick = { (window: MenuBarWindow) -> IconFigure in
            guard window == .fiveHour, let fiveHour else { return cycleFigure }
            return IconFigure(percent: fiveHour.percent, status: shareStatus(fiveHour.percent))
        }
        return (pick(number), pick(ring))
    }

    /// "18", "–" while unknown: the number inside the ring has no room for a "%".
    public static func ringNumberText(_ percent: Double?) -> String {
        guard let percent, percent.isFinite else { return "–" }
        return "\(Int(percent.rounded()))"
    }

    /// Whether the card lists the groups and machines.
    public static func showsBreakdown(_ provider: StatusPayload.Provider, mode: BreakdownMode) -> Bool {
        switch mode {
        case .always: true
        case .never: false
        case .auto: provider.machines.count > 1
        }
    }

    /// "16:40": the time the window resets.
    public static func timeText(_ date: Date, strings: Strings) -> String {
        let formatter = DateFormatter()
        formatter.locale = strings.locale
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        return formatter.string(from: date)
    }

    /// "2h 57m left", under the 5-hour bar; nil while idle.
    public static func fiveHourLeftText(_ view: FiveHourView, now: Date, strings: Strings) -> String? {
        guard let resetsAt = view.resetsAt else { return nil }
        return strings.fiveHourLeft(durationText(resetsAt.timeIntervalSince(now), strings: strings))
    }

    /// The line under the 5-hour bar: when it runs out, that it lasts, or why there is no pace.
    public static func fiveHourOutlookText(_ view: FiveHourView, strings: Strings) -> String {
        switch view.outlook {
        case .idle: strings.fiveHourIdle
        case .tooEarly: strings.tooEarly
        case .lasts: strings.fiveHourLasts
        case .runsOut(let date): strings.fiveHourRunsOut(timeText(date, strings: strings))
        case .usedUp: strings.fiveHourUsedUp
        }
    }
}

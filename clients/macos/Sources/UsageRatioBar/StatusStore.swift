import AppKit
import Observation
import UsageRatioCore

/// Polls GET /api/status every five minutes, sooner after waking from sleep,
/// with a growing back-off while it fails; holds what the label and the popover show.
@MainActor
@Observable
final class StatusStore {
    static let interval: TimeInterval = 300
    private static let maxBackoff: TimeInterval = 1800
    private static let wakeDelay: TimeInterval = 10

    private(set) var payload: StatusPayload?
    private(set) var lastSuccess: Date?
    private(set) var error: StatusError?
    private(set) var isRefreshing = false
    /// Ticks every minute, so the relative times and the staleness move without a lookup.
    private(set) var now = Date()
    private(set) var serverURL: URL?
    private(set) var hasToken = Keychain.hasToken
    /// The providers' own usage limits read on this Mac, by provider id.
    private(set) var limits: [String: LimitsSnapshot] = [:]
    /// What was found at each source (the settings screen's "Sources").
    private(set) var sources: (claude: SourceReading, codex: SourceReading) = (.missing, .missing)
    /// A provider's last upload the server declined, by provider id.
    private(set) var uploadNotes: [String: OfficialReportRefusal] = [:]
    /// A provider's weekly reset the server moved on our word; shown until the popover closes.
    private(set) var movedNotes: [String: ResetMoment] = [:]

    var selectedProviderId: String? {
        didSet { UserDefaults.standard.set(selectedProviderId, forKey: Keys.provider) }
    }

    /// Of the selected provider: all of it, or one group's or machine's part.
    var selectedScope: MenuBarScope = .total {
        didSet { UserDefaults.standard.set(selectedScope.storage, forKey: Keys.scope) }
    }

    let strings: Strings

    @ObservationIgnored private let client = StatusClient()
    @ObservationIgnored private let reporter = OfficialReportClient()
    @ObservationIgnored private var loop: Task<Void, Never>?
    @ObservationIgnored private var clock: Task<Void, Never>?
    @ObservationIgnored private var failures = 0
    /// A fixed payload for previews and snapshots: never polls.
    @ObservationIgnored private var previewing = false

    private enum Keys {
        static let server = "serverURL"
        static let provider = "selectedProvider"
        static let scope = "selectedScope"
        static let lastUploaded = "lastUploadedLimits"
    }

    init() {
        strings = Strings.forPreferredLanguages()
        serverURL = UserDefaults.standard.string(forKey: Keys.server).flatMap(normalizedServerURL)
        selectedProviderId = UserDefaults.standard.string(forKey: Keys.provider)
        selectedScope = MenuBarScope(storage: UserDefaults.standard.string(forKey: Keys.scope))

        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.restart(after: Self.wakeDelay) }
        }
        clock = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                self?.now = Date()
            }
        }
        restart()
    }

#if DEBUG
    /// A store that shows `payload` as of `now` and never touches the network or the keychain:
    /// for previews and the offscreen snapshots that check the card's layout.
    init(
        preview payload: StatusPayload, now: Date, strings: Strings, scope: MenuBarScope = .total,
        limits: [String: LimitsSnapshot] = [:], sources: (claude: SourceReading, codex: SourceReading) = (.missing, .missing),
        uploadNotes: [String: OfficialReportRefusal] = [:], movedNotes: [String: ResetMoment] = [:]
    ) {
        self.limits = limits
        self.sources = sources
        self.uploadNotes = uploadNotes
        self.movedNotes = movedNotes
        self.strings = strings
        self.payload = payload
        self.now = now
        self.lastSuccess = now
        self.selectedScope = scope
        self.serverURL = URL(string: "https://usage.example.com")
        self.hasToken = true
        self.previewing = true
    }
#endif

    var selectedProvider: StatusPayload.Provider? {
        Display.selectedProvider(in: payload, id: selectedProviderId)
    }

    /// What the menu bar shows.
    var menuBarFigure: MenuBarFigure? {
        selectedProvider.map { Display.figure(of: $0, scope: selectedScope) }
    }

    var isStale: Bool {
        Display.isStale(lastReportAt: menuBarFigure?.lastReportAt, lastSuccess: lastSuccess, now: now)
    }

    /// A click on a provider in the popover: another provider starts from its whole figure.
    func select(providerId: String) {
        guard providerId != selectedProvider?.id else { return }
        selectedProviderId = providerId
        selectedScope = .total
    }

    /// A lookup right now (after `delay`), and the five-minute rhythm from there.
    func restart(after delay: TimeInterval = 0) {
        guard !previewing else { return }
        loop?.cancel()
        loop = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            while !Task.isCancelled {
                guard let next = await self?.refresh() else { return }
                try? await Task.sleep(for: .seconds(next))
            }
        }
    }

    /// Opening the popover refreshes a figure older than a minute.
    func refreshIfIdle() {
        guard !isRefreshing else { return }
        if let lastSuccess, Date().timeIntervalSince(lastSuccess) < 60 { return }
        restart()
    }

    /// The "cycle moved" notes are shown once: the popover closing clears them.
    func dismissMovedNotes() {
        if !movedNotes.isEmpty { movedNotes = [:] }
    }

    private func lastUploaded(_ providerId: String) -> Date? {
        let stored = UserDefaults.standard.dictionary(forKey: Keys.lastUploaded) as? [String: Double]
        return stored?[providerId].map { Date(timeIntervalSince1970: $0) }
    }

    private func setLastUploaded(_ providerId: String, _ date: Date) {
        var stored = UserDefaults.standard.dictionary(forKey: Keys.lastUploaded) as? [String: Double] ?? [:]
        stored[providerId] = date.timeIntervalSince1970
        UserDefaults.standard.set(stored, forKey: Keys.lastUploaded)
    }

    /// Reads the providers' own limits and uploads each weekly figure newer than the last one sent.
    /// Answers whether the server saved a new figure.
    private func readAndUploadLimits(base serverURL: URL, token: String) async -> Bool {
        var saved = false
        let readings = await LimitSources.readAll()
        sources = readings
        limits = Dictionary(
            uniqueKeysWithValues: [readings.claude.snapshot, readings.codex.snapshot].compactMap { $0 }.map { ($0.providerId, $0) }
        )
        for snapshot in limits.values.sorted(by: { $0.providerId < $1.providerId })
        where UploadPolicy.shouldUpload(snapshot, lastUploaded: lastUploaded(snapshot.providerId)) {
            do {
                switch try await reporter.send(snapshot, base: serverURL, token: token) {
                case .accepted(let wasSaved, let movedTo):
                    if wasSaved { saved = true }
                    setLastUploaded(snapshot.providerId, snapshot.observedAt)
                    uploadNotes[snapshot.providerId] = nil
                    if let movedTo { movedNotes[snapshot.providerId] = movedTo }
                case .refused(let refusal):
                    uploadNotes[snapshot.providerId] = refusal
                    // A stale reading will never be accepted: do not retry it every five minutes.
                    if refusal == .staleReading { setLastUploaded(snapshot.providerId, snapshot.observedAt) }
                }
            } catch {
                // Network or server trouble: the status lookup reports it; the next poll retries the upload.
            }
        }
        return saved
    }

    /// Saves the settings screen; returns the problem to show, or nil once saved.
    func save(serverText: String, token: String) -> String? {
        guard let url = normalizedServerURL(serverText) else { return strings.invalidURL }
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedToken.isEmpty {
            if !hasToken { return strings.missingToken }
        } else {
            guard Keychain.saveToken(trimmedToken) else { return strings.errorInvalid }
            hasToken = true
        }
        UserDefaults.standard.set(url.absoluteString, forKey: Keys.server)
        if url != serverURL { payload = nil }
        serverURL = url
        restart()
        return nil
    }

    /// One lookup; answers how long to wait before the next one.
    private func refresh() async -> TimeInterval {
        guard let serverURL, let token = Keychain.readToken() else {
            error = .notConfigured
            return Self.interval
        }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            payload = try await client.fetch(base: serverURL, token: token)
            // The uploads come after the lookup, so a slow server never delays its status; a saved
            // figure changes the card, so look once more.
            if await readAndUploadLimits(base: serverURL, token: token),
               let fresh = try? await client.fetch(base: serverURL, token: token) {
                payload = fresh
            }
            // A group or machine gone from the list (deleted, merged) reads as the whole provider: say so in the picker too.
            if selectedScope != .total, let provider = selectedProvider,
               Display.figure(of: provider, scope: selectedScope).name == nil {
                selectedScope = .total
            }
            lastSuccess = Date()
            now = Date()
            error = nil
            failures = 0
            return Self.interval
        } catch {
            self.error = error
            failures += 1
            switch error {
            case .rateLimited(let retryAfter):
                return max(60, retryAfter ?? Self.interval)
            case .unauthorized, .unsupportedVersion, .notConfigured:
                // Waiting does not fix these; the settings screen restarts the loop.
                return Self.maxBackoff
            default:
                return min(Self.maxBackoff, 30 * pow(2, Double(min(failures, 6))))
            }
        }
    }
}

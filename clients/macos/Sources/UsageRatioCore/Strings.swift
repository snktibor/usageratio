import Foundation

/// The app's wording in the dashboard's three languages (messages/*.json):
/// kept in code rather than in .strings resources, since a SwiftPM resource
/// bundle cannot sit where an ad-hoc signed .app expects it.
public struct Strings: Sendable {
    /// "weekly" / "monthly", after the provider's name
    public let weekly: String
    public let monthly: String
    /// percentage left
    public let remaining: @Sendable (String) -> String
    /// percentage over the limit
    public let over: @Sendable (String) -> String
    /// percentage of the cycle gone by, under its marker on the bar
    public let elapsed: @Sendable (String) -> String
    /// weekday and time
    public let runsOut: @Sendable (String) -> String
    public let lastsUntilReset: String
    public let tooEarly: String
    /// weekday and time
    public let reset: @Sendable (String) -> String
    public let sourceOfficial: String
    public let sourceEstimate: String
    public let noLimit: String
    /// how many more rows
    public let more: @Sendable (Int) -> String
    /// compact token count
    public let tokens: @Sendable (String) -> String
    /// relative time, shown when the figure is stale
    public let lastReport: @Sendable (String) -> String
    public let refreshing: String
    public let noProviders: String
    /// Section headings (shown in capitals).
    public let displaySection: String
    public let connectionSection: String
    public let generalSection: String

    public let errorNotConfigured: String
    public let errorUnauthorized: String
    public let errorRateLimited: String
    public let errorStorage: String
    /// HTTP status
    public let errorServer: @Sendable (Int) -> String
    public let errorUnsupported: String
    public let errorInvalid: String
    public let errorNetwork: String

    // Buttons and the settings screen.
    public let refresh: String
    public let settings: String
    public let done: String
    public let openDashboard: String
    public let quit: String
    public let provider: String
    public let menuBarShows: String
    public let wholeProvider: String
    public let groupsSection: String
    public let machinesSection: String
    public let serverLabel: String
    public let tokenLabel: String
    public let tokenSaved: String
    public let tokenHint: String
    public let launchAtLogin: String
    public let launchAtLoginFailed: String
    public let save: String
    public let saved: String
    public let invalidURL: String
    public let missingToken: String

    // The card.
    /// under the big percentage
    public let used: String
    /// "41.2M / 70M tokens": used and the limit, compact
    public let tokensOfLimit: @Sendable (String, String) -> String
    /// "Updated 5 min ago", in the footer
    public let updated: @Sendable (String) -> String
    /// The status badge in the header.
    public let statusGood: String
    public let statusWarning: String
    public let statusCritical: String
    /// The tooltip of the icon that marks what the menu bar shows.
    public let shownInMenuBar: String
    /// Above a provider's sub-limits, as the dashboard names them.
    public let subLimitsSection: String

    /// "en", "hu" or "de": the one the strings and the formatters use.
    public let languageCode: String

    public var locale: Locale { Locale(identifier: languageCode) }

    public func message(for error: StatusError) -> String {
        switch error {
        case .notConfigured: errorNotConfigured
        case .unauthorized: errorUnauthorized
        case .rateLimited: errorRateLimited
        case .server(status: 503): errorStorage
        case .server(let status): errorServer(status)
        case .unsupportedVersion: errorUnsupported
        case .invalidResponse: errorInvalid
        case .network: errorNetwork
        }
    }

    /// The first of the user's preferred languages this app speaks; English otherwise.
    public static func forPreferredLanguages(_ languages: [String] = Locale.preferredLanguages) -> Strings {
        for language in languages {
            switch Locale(identifier: language).language.languageCode?.identifier {
            case "hu": return .hu
            case "de": return .de
            case "en": return .en
            default: continue
            }
        }
        return .en
    }

    public static let en = Strings(
        weekly: "weekly",
        monthly: "monthly",
        remaining: { "\($0) left" },
        over: { "Over by \($0)" },
        elapsed: { "time elapsed \($0)" },
        runsOut: { "Runs out \($0)" },
        lastsUntilReset: "Lasts until the reset",
        tooEarly: "Too early for a pace",
        reset: { "Reset: \($0)" },
        sourceOfficial: "official",
        sourceEstimate: "estimate",
        noLimit: "No limit or official %",
        more: { "+\($0) more" },
        tokens: { "\($0) tokens" },
        lastReport: { "Last report \($0)" },
        refreshing: "Refreshing…",
        noProviders: "No provider has reported yet.",
        displaySection: "Display",
        connectionSection: "Connection",
        generalSection: "General",
        errorNotConfigured: "Set the server and a token in Settings.",
        errorUnauthorized: "The token was refused: wrong or revoked.",
        errorRateLimited: "Too many requests; trying again later.",
        errorStorage: "The server's store is unavailable right now.",
        errorServer: { "The server answered with an error (\($0))." },
        errorUnsupported: "This app is too old for the server; rebuild it.",
        errorInvalid: "The server sent an unexpected answer.",
        errorNetwork: "The server cannot be reached (offline?).",
        refresh: "Refresh",
        settings: "Settings",
        done: "Done",
        openDashboard: "Open the dashboard",
        quit: "Quit UsageRatio",
        provider: "Provider",
        menuBarShows: "Menu bar shows",
        wholeProvider: "Whole provider",
        groupsSection: "Groups",
        machinesSection: "Machines",
        serverLabel: "Server URL",
        tokenLabel: "Read token",
        tokenSaved: "A token is saved; leave this empty to keep it.",
        tokenHint: "Create one on the dashboard: Settings → Tokens, access “Read only (menu bar app)”.",
        launchAtLogin: "Open at login",
        launchAtLoginFailed: "The login item could not be changed.",
        save: "Save",
        saved: "Saved",
        invalidURL: "Enter an https:// address.",
        missingToken: "Paste a token.",
        used: "used",
        tokensOfLimit: { "\($0) / \($1) tokens" },
        updated: { "Updated \($0)" },
        statusGood: "On track",
        statusWarning: "Warning",
        statusCritical: "Critical",
        shownInMenuBar: "Shown in the menu bar",
        subLimitsSection: "Sub-limits",
        languageCode: "en"
    )

    public static let hu = Strings(
        weekly: "heti",
        monthly: "havi",
        remaining: { "\($0) maradt" },
        over: { "Túllépés: \($0)" },
        elapsed: { "eltelt idő \($0)" },
        runsOut: { "Elfogy: \($0)" },
        lastsUntilReset: "Kitart a resetig",
        tooEarly: "A tempóhoz még korai",
        reset: { "Reset: \($0)" },
        sourceOfficial: "hivatalos",
        sourceEstimate: "becsült",
        noLimit: "Nincs limit vagy hivatalos %",
        more: { "+\($0) további" },
        tokens: { "\($0) token" },
        lastReport: { "Utolsó jelentés: \($0)" },
        refreshing: "Frissítés…",
        noProviders: "Még egy szolgáltató sem jelentett.",
        displaySection: "Megjelenítés",
        connectionSection: "Kapcsolat",
        generalSection: "Általános",
        errorNotConfigured: "Add meg a szervert és egy tokent a beállításokban.",
        errorUnauthorized: "A szerver nem fogadta el a tokent: hibás vagy visszavont.",
        errorRateLimited: "Túl sok kérés; később újrapróbálom.",
        errorStorage: "A szerver adattára most nem érhető el.",
        errorServer: { "A szerver hibával válaszolt (\($0))." },
        errorUnsupported: "Ez az app túl régi a szerverhez; buildeld újra.",
        errorInvalid: "A szerver váratlan választ küldött.",
        errorNetwork: "A szerver nem érhető el (offline?).",
        refresh: "Frissítés",
        settings: "Beállítások",
        done: "Kész",
        openDashboard: "Dashboard megnyitása",
        quit: "Kilépés a UsageRatióból",
        provider: "Szolgáltató",
        menuBarShows: "Menüsávban",
        wholeProvider: "Összesen",
        groupsSection: "Csoportok",
        machinesSection: "Gépek",
        serverLabel: "Szerver címe",
        tokenLabel: "Olvasó token",
        tokenSaved: "Van elmentett token; hagyd üresen, ha marad.",
        tokenHint: "A dashboardon hozd létre: Beállítások → Tokenek, jogosultság: „Csak olvasás (menüsáv app)”.",
        launchAtLogin: "Indítás bejelentkezéskor",
        launchAtLoginFailed: "Nem sikerült módosítani az indítási elemet.",
        save: "Mentés",
        saved: "Elmentve",
        invalidURL: "Adj meg egy https:// címet.",
        missingToken: "Illessz be egy tokent.",
        used: "felhasználva",
        tokensOfLimit: { "\($0) / \($1) token" },
        updated: { "Frissítve: \($0)" },
        statusGood: "Rendben",
        statusWarning: "Figyelem",
        statusCritical: "Kritikus",
        shownInMenuBar: "Ez látszik a menüsávban",
        subLimitsSection: "Alkeretek",
        languageCode: "hu"
    )

    public static let de = Strings(
        weekly: "wöchentlich",
        monthly: "monatlich",
        remaining: { "\($0) übrig" },
        over: { "Überschritten: \($0)" },
        elapsed: { "Zeit vergangen \($0)" },
        runsOut: { "Aufgebraucht \($0)" },
        lastsUntilReset: "Reicht bis zum Reset",
        tooEarly: "Für ein Tempo noch zu früh",
        reset: { "Reset: \($0)" },
        sourceOfficial: "offiziell",
        sourceEstimate: "geschätzt",
        noLimit: "Kein Limit oder offizieller Wert",
        more: { "+\($0) weitere" },
        tokens: { "\($0) Tokens" },
        lastReport: { "Letzter Bericht \($0)" },
        refreshing: "Aktualisiere…",
        noProviders: "Noch hat kein Anbieter berichtet.",
        displaySection: "Anzeige",
        connectionSection: "Verbindung",
        generalSection: "Allgemein",
        errorNotConfigured: "Lege Server und Token in den Einstellungen fest.",
        errorUnauthorized: "Der Token wurde abgelehnt: falsch oder widerrufen.",
        errorRateLimited: "Zu viele Anfragen; später erneut.",
        errorStorage: "Der Speicher des Servers ist gerade nicht erreichbar.",
        errorServer: { "Der Server antwortete mit einem Fehler (\($0))." },
        errorUnsupported: "Diese App ist zu alt für den Server; baue sie neu.",
        errorInvalid: "Der Server sandte eine unerwartete Antwort.",
        errorNetwork: "Der Server ist nicht erreichbar (offline?).",
        refresh: "Aktualisieren",
        settings: "Einstellungen",
        done: "Fertig",
        openDashboard: "Dashboard öffnen",
        quit: "UsageRatio beenden",
        provider: "Anbieter",
        menuBarShows: "Menüleiste zeigt",
        wholeProvider: "Gesamter Anbieter",
        groupsSection: "Gruppen",
        machinesSection: "Maschinen",
        serverLabel: "Server-URL",
        tokenLabel: "Lese-Token",
        tokenSaved: "Ein Token ist gespeichert; leer lassen, um ihn zu behalten.",
        tokenHint: "Im Dashboard erstellen: Einstellungen → Tokens, Berechtigung „Nur lesen (Menüleisten-App)“.",
        launchAtLogin: "Beim Anmelden öffnen",
        launchAtLoginFailed: "Das Anmeldeobjekt ließ sich nicht ändern.",
        save: "Sichern",
        saved: "Gesichert",
        invalidURL: "Gib eine https://-Adresse ein.",
        missingToken: "Füge einen Token ein.",
        used: "verbraucht",
        tokensOfLimit: { "\($0) / \($1) Tokens" },
        updated: { "Aktualisiert \($0)" },
        statusGood: "Im Rahmen",
        statusWarning: "Warnung",
        statusCritical: "Kritisch",
        shownInMenuBar: "In der Menüleiste",
        subLimitsSection: "Unterkontingente",
        languageCode: "de"
    )
}

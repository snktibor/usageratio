import Foundation

/// The app's wording in the dashboard's three languages (messages/*.json):
/// kept in code rather than in .strings resources, since a SwiftPM resource
/// bundle cannot sit where an ad-hoc signed .app expects it.
public struct Strings: Sendable {
    public let weeklyCycle: String
    public let monthlyCycle: String
    /// countdown, reset date
    public let resetsIn: @Sendable (String, String) -> String
    public let official: String
    public let estimate: String
    public let noLimit: String
    /// compact token count
    public let tokens: @Sendable (String) -> String
    /// projected percentage, run-out date
    public let paceRunsOut: @Sendable (String, String) -> String
    /// projected percentage
    public let paceProjection: @Sendable (String) -> String
    public let paceTooEarly: String
    /// relative time
    public let lastReport: @Sendable (String) -> String
    public let noReport: String
    /// relative time
    public let updated: @Sendable (String) -> String
    public let refreshing: String
    public let noProviders: String
    public let selectHint: String

    public let errorNotConfigured: String
    public let errorUnauthorized: String
    public let errorRateLimited: String
    public let errorStorage: String
    /// HTTP status
    public let errorServer: @Sendable (Int) -> String
    public let errorUnsupported: String
    public let errorInvalid: String
    public let errorNetwork: String

    public let refresh: String
    public let dashboard: String
    public let openDashboard: String
    public let settings: String
    public let quit: String

    public let serverLabel: String
    public let tokenLabel: String
    public let tokenSaved: String
    public let tokenHint: String
    public let launchAtLogin: String
    public let launchAtLoginFailed: String
    public let save: String
    public let cancel: String
    public let invalidURL: String
    public let missingToken: String

    /// "en", "hu" or "de": the one the strings and the formatters below use.
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
        weeklyCycle: "Weekly cycle",
        monthlyCycle: "Monthly cycle",
        resetsIn: { "Resets in \($0) (\($1))" },
        official: "official",
        estimate: "estimate",
        noLimit: "No limit or official % set",
        tokens: { "\($0) tokens" },
        paceRunsOut: { "At this pace ~\($0) by the reset; runs out \($1)" },
        paceProjection: { "At this pace ~\($0) by the reset" },
        paceTooEarly: "Too early to project the pace",
        lastReport: { "Last report \($0)" },
        noReport: "No report this cycle yet",
        updated: { "Updated \($0)" },
        refreshing: "Refreshing…",
        noProviders: "No provider has reported yet.",
        selectHint: "Click a provider to show it in the menu bar.",
        errorNotConfigured: "Set the server and a token in Settings.",
        errorUnauthorized: "The token was refused: wrong or revoked.",
        errorRateLimited: "Too many requests; trying again later.",
        errorStorage: "The server's store is unavailable right now.",
        errorServer: { "The server answered with an error (\($0))." },
        errorUnsupported: "This app is too old for the server; rebuild it.",
        errorInvalid: "The server sent an unexpected answer.",
        errorNetwork: "The server cannot be reached (offline?).",
        refresh: "Refresh",
        dashboard: "Dashboard",
        openDashboard: "Open the dashboard in the browser",
        settings: "Settings",
        quit: "Quit",
        serverLabel: "Server URL",
        tokenLabel: "Read token",
        tokenSaved: "A token is saved; leave this empty to keep it.",
        tokenHint: "Create one on the dashboard: Settings → Tokens, access “Read only (menu bar app)”.",
        launchAtLogin: "Open at login",
        launchAtLoginFailed: "The login item could not be changed.",
        save: "Save",
        cancel: "Cancel",
        invalidURL: "Enter an https:// address.",
        missingToken: "Paste a token.",
        languageCode: "en"
    )

    public static let hu = Strings(
        weeklyCycle: "Heti ciklus",
        monthlyCycle: "Havi ciklus",
        resetsIn: { "Reset \($0) múlva (\($1))" },
        official: "hivatalos",
        estimate: "becsült",
        noLimit: "Nincs limit vagy hivatalos %",
        tokens: { "\($0) token" },
        paceRunsOut: { "Ezzel a tempóval ~\($0) a resetig; elfogy: \($1)" },
        paceProjection: { "Ezzel a tempóval ~\($0) a resetig" },
        paceTooEarly: "Még korai a tempót előrejelezni",
        lastReport: { "Utolsó jelentés: \($0)" },
        noReport: "Ebben a ciklusban még nincs jelentés",
        updated: { "Frissítve: \($0)" },
        refreshing: "Frissítés…",
        noProviders: "Még egy szolgáltató sem jelentett.",
        selectHint: "Kattints egy szolgáltatóra, hogy az látszódjon a menüsávban.",
        errorNotConfigured: "Add meg a szervert és egy tokent a beállításokban.",
        errorUnauthorized: "A szerver nem fogadta el a tokent: hibás vagy visszavont.",
        errorRateLimited: "Túl sok kérés; később újrapróbálom.",
        errorStorage: "A szerver adattára most nem érhető el.",
        errorServer: { "A szerver hibával válaszolt (\($0))." },
        errorUnsupported: "Ez az app túl régi a szerverhez; buildeld újra.",
        errorInvalid: "A szerver váratlan választ küldött.",
        errorNetwork: "A szerver nem érhető el (offline?).",
        refresh: "Frissítés",
        dashboard: "Dashboard",
        openDashboard: "A dashboard megnyitása a böngészőben",
        settings: "Beállítások",
        quit: "Kilépés",
        serverLabel: "Szerver címe",
        tokenLabel: "Olvasó token",
        tokenSaved: "Van elmentett token; hagyd üresen, ha marad.",
        tokenHint: "A dashboardon hozd létre: Beállítások → Tokenek, jogosultság: „Csak olvasás (menüsáv app)”.",
        launchAtLogin: "Indítás bejelentkezéskor",
        launchAtLoginFailed: "Nem sikerült módosítani az indítási elemet.",
        save: "Mentés",
        cancel: "Mégse",
        invalidURL: "Adj meg egy https:// címet.",
        missingToken: "Illessz be egy tokent.",
        languageCode: "hu"
    )

    public static let de = Strings(
        weeklyCycle: "Wöchentlicher Zyklus",
        monthlyCycle: "Monatlicher Zyklus",
        resetsIn: { "Reset in \($0) (\($1))" },
        official: "offiziell",
        estimate: "geschätzt",
        noLimit: "Kein Limit oder offizieller Wert",
        tokens: { "\($0) Tokens" },
        paceRunsOut: { "In diesem Tempo ~\($0) bis zum Reset; aufgebraucht \($1)" },
        paceProjection: { "In diesem Tempo ~\($0) bis zum Reset" },
        paceTooEarly: "Für eine Tempo-Prognose noch zu früh",
        lastReport: { "Letzter Bericht \($0)" },
        noReport: "In diesem Zyklus noch kein Bericht",
        updated: { "Aktualisiert \($0)" },
        refreshing: "Aktualisiere…",
        noProviders: "Noch hat kein Anbieter berichtet.",
        selectHint: "Klicke auf einen Anbieter, um ihn in der Menüleiste zu zeigen.",
        errorNotConfigured: "Lege Server und Token in den Einstellungen fest.",
        errorUnauthorized: "Der Token wurde abgelehnt: falsch oder widerrufen.",
        errorRateLimited: "Zu viele Anfragen; später erneut.",
        errorStorage: "Der Speicher des Servers ist gerade nicht erreichbar.",
        errorServer: { "Der Server antwortete mit einem Fehler (\($0))." },
        errorUnsupported: "Diese App ist zu alt für den Server; baue sie neu.",
        errorInvalid: "Der Server sandte eine unerwartete Antwort.",
        errorNetwork: "Der Server ist nicht erreichbar (offline?).",
        refresh: "Aktualisieren",
        dashboard: "Dashboard",
        openDashboard: "Das Dashboard im Browser öffnen",
        settings: "Einstellungen",
        quit: "Beenden",
        serverLabel: "Server-URL",
        tokenLabel: "Lese-Token",
        tokenSaved: "Ein Token ist gespeichert; leer lassen, um ihn zu behalten.",
        tokenHint: "Im Dashboard erstellen: Einstellungen → Tokens, Berechtigung „Nur lesen (Menüleisten-App)“.",
        launchAtLogin: "Beim Anmelden öffnen",
        launchAtLoginFailed: "Das Anmeldeobjekt ließ sich nicht ändern.",
        save: "Sichern",
        cancel: "Abbrechen",
        invalidURL: "Gib eine https://-Adresse ein.",
        missingToken: "Füge einen Token ein.",
        languageCode: "de"
    )
}

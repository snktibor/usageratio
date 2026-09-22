/**
 * The clients' API token as the dashboard keeps it: what a valid one looks
 * like, the status the settings panel and the setup page show, and the audit
 * trail of the browsers that saved or fetched it. Pure and browser-safe: the
 * encryption is in lib/secret-box.ts, the Redis side in lib/token-vault.ts.
 */

/** The same floor as the Bearer check of /api/usage. */
export const MIN_TOKEN_LENGTH = 16;
export const MAX_TOKEN_LENGTH = 512;

/** The audit trail keeps this many of the newest entries. */
export const AUDIT_LIMIT = 500;

export type ApiTokenStatus =
  /** TOKEN_ENCRYPTION_KEY is missing or malformed: nothing can be stored or read. */
  | { state: "no_key" }
  | { state: "empty" }
  /** Stored, but it does not decrypt: the key changed, or the value was damaged. */
  | { state: "unreadable"; updatedAt: number | null }
  /** `matchesServer`: whether it equals the server's USAGE_API_TOKEN; null when that is not set. */
  | { state: "stored"; updatedAt: number | null; matchesServer: boolean | null };

export type AuditAction = "created" | "updated" | "revealed";

export const AUDIT_ACTIONS: readonly AuditAction[] = ["created", "updated", "revealed"];

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  created: "Hozzáadás",
  updated: "Módosítás",
  revealed: "Lekérés",
};

/** The requesting browser, as the request described it. */
export interface AuditClient {
  userAgent: string;
  /** The Sec-CH-UA client hint (Chromium browsers only). */
  brands: string;
  /** The Sec-CH-UA-Platform client hint. */
  platform: string;
  ip: string;
  /** A short hash of the session id (never the id), telling browsers apart. */
  session: string | null;
}

/**
 * One stored entry. It keeps the raw request details, and the browser is only
 * named when read, so a better reading below applies to old entries as well.
 */
export interface AuditRecord extends AuditClient {
  at: number;
  action: AuditAction;
}

/** One entry as the audit popup gets it. */
export interface AuditEntry {
  at: number;
  action: AuditAction;
  /** "Chrome 140" */
  browser: string;
  /** "macOS"; null when the request does not tell. */
  os: string | null;
  userAgent: string;
  ip: string;
  session: string | null;
}

/** Printable ASCII without spaces: anything else could not travel in an `Authorization: Bearer` header. */
const TOKEN_PATTERN = /^[\x21-\x7e]+$/;

export function isValidApiToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= MIN_TOKEN_LENGTH &&
    value.length <= MAX_TOKEN_LENGTH &&
    TOKEN_PATTERN.test(value)
  );
}

/** Why `value` (already trimmed) cannot be saved as the token; null when it can. */
export function apiTokenProblem(value: string): string | null {
  if (value === "") return "Írd vagy illeszd be a tokent.";
  if (!TOKEN_PATTERN.test(value)) {
    return "A token nem tartalmazhat szóközt, ékezetes vagy más nem ASCII karaktert.";
  }
  if (value.length < MIN_TOKEN_LENGTH) {
    return `A token legalább ${MIN_TOKEN_LENGTH} karakter, mint a szerver USAGE_API_TOKEN-je.`;
  }
  if (value.length > MAX_TOKEN_LENGTH) return `A token legfeljebb ${MAX_TOKEN_LENGTH} karakter lehet.`;
  return null;
}

// ── Audit records ────────────────────────────────────────────────────────────

export function serializeAuditRecord(record: AuditRecord): string {
  return JSON.stringify({
    at: record.at,
    a: record.action,
    ua: record.userAgent,
    ch: record.brands,
    pf: record.platform,
    ip: record.ip,
    s: record.session,
  });
}

/** One list item of the audit trail; null when it is not a readable entry. */
export function parseAuditRecord(raw: string): AuditRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) return null;
  if (!(AUDIT_ACTIONS as readonly unknown[]).includes(entry.a)) return null;
  const text = (field: unknown) => (typeof field === "string" ? field : "");
  return {
    at: entry.at,
    action: entry.a as AuditAction,
    userAgent: text(entry.ua),
    brands: text(entry.ch),
    platform: text(entry.pf),
    ip: text(entry.ip) || "unknown",
    session: typeof entry.s === "string" && entry.s !== "" ? entry.s : null,
  };
}

export function toAuditEntry(record: AuditRecord): AuditEntry {
  const { browser, os } = describeClient(record.userAgent, record.brands, record.platform);
  return {
    at: record.at,
    action: record.action,
    browser,
    os,
    userAgent: record.userAgent,
    ip: record.ip,
    session: record.session,
  };
}

// ── Naming the browser ───────────────────────────────────────────────────────

/** Brands every Chromium browser lists: they name the engine, or are there to be ignored. */
const GREASE_BRAND = /not.a.brand/i;

const BRAND_NAMES: Record<string, string> = {
  "Google Chrome": "Chrome",
  "Microsoft Edge": "Edge",
  "Opera GX": "Opera GX",
};

/** User-Agent markers, most specific first: Edge and Opera also say "Chrome", Chrome also says "Safari". */
const UA_BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\/(\d+)/, "Edge"],
  [/\b(?:OPR|OPiOS)\/(\d+)/, "Opera"],
  [/\bVivaldi\/(\d+)/, "Vivaldi"],
  [/\bSamsungBrowser\/(\d+)/, "Samsung Internet"],
  [/\bYaBrowser\/(\d+)/, "Yandex"],
  [/\b(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
  [/\bHeadlessChrome\/(\d+)/, "Headless Chrome"],
  [/\bCriOS\/(\d+)/, "Chrome"],
  [/\bChrome\/(\d+)/, "Chrome"],
  [/\bVersion\/(\d+)[\d.]*(?: Mobile\/\w+)? Safari\//, "Safari"],
];

const UA_SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, "iOS"],
  [/\biPad\b/, "iPadOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac(?:intosh| OS X)\b/, "macOS"],
  [/\bLinux\b/, "Linux"],
];

const PLATFORM_NAMES: Record<string, string> = {
  "Chrome OS": "ChromeOS",
  "Chromium OS": "ChromeOS",
};

function brandFromHints(brands: string): string | null {
  const listed = [...brands.matchAll(/"([^"]*)"\s*;\s*v="(\d+)[^"]*"/g)]
    .map(([, name, version]) => ({ name: name!.trim(), version: version! }))
    .filter((brand) => brand.name !== "" && !GREASE_BRAND.test(brand.name));
  // "Chromium" is the engine; a browser built on it lists its own name next to it.
  const brand = listed.find((candidate) => candidate.name !== "Chromium") ?? listed[0];
  return brand ? `${BRAND_NAMES[brand.name] ?? brand.name} ${brand.version}` : null;
}

function browserFromUserAgent(userAgent: string): string {
  for (const [pattern, name] of UA_BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) return `${name} ${match[1]}`;
  }
  // Not a browser (curl, a script): its own first product token says what it is.
  const product = /^([A-Za-z][\w.-]*)\/([\w.]+)/.exec(userAgent);
  if (product && product[1] !== "Mozilla") return `${product[1]} ${product[2]}`;
  return userAgent ? "Ismeretlen böngésző" : "Ismeretlen kliens";
}

/** "Chrome 140" and "macOS", from the User-Agent and, where a Chromium browser sends them, its client hints. */
export function describeClient(
  userAgent: string,
  brands = "",
  platform = "",
): { browser: string; os: string | null } {
  const hinted = platform.replace(/"/g, "").trim();
  const os =
    hinted && hinted !== "Unknown"
      ? (PLATFORM_NAMES[hinted] ?? hinted)
      : (UA_SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null);
  return { browser: brandFromHints(brands) ?? browserFromUserAgent(userAgent), os };
}

// ── What the panel and the setup page say ────────────────────────────────────

export type StatusTone = "good" | "warning" | "problem" | "neutral";

/** The status in one sentence, for the settings panel and the setup page. */
export function apiTokenStatusNote(status: ApiTokenStatus): { tone: StatusTone; text: string } {
  switch (status.state) {
    case "no_key":
      return {
        tone: "problem",
        text:
          "A szerveren nincs érvényes TOKEN_ENCRYPTION_KEY (32 bájt, például openssl rand -base64 32), " +
          "ezért a token nem tárolható.",
      };
    case "empty":
      return { tone: "neutral", text: "Még nincs tárolt token." };
    case "unreadable":
      return {
        tone: "problem",
        text:
          "A tárolt token nem fejthető vissza: megváltozott a TOKEN_ENCRYPTION_KEY, vagy sérült az érték. " +
          "Add meg újra.",
      };
    case "stored":
      if (status.matchesServer === false) {
        return {
          tone: "warning",
          text: "A tárolt token nem egyezik a szerver USAGE_API_TOKEN-jével: a telepítő el fogja utasítani.",
        };
      }
      return {
        tone: "good",
        text:
          status.matchesServer === true
            ? "Titkosítva tárolva, és egyezik a szerver USAGE_API_TOKEN-jével."
            : "Titkosítva tárolva.",
      };
  }
}

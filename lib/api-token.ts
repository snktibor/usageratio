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
  /**
   * `matchesServer`: whether it equals the server's USAGE_API_TOKEN; null when that is not set.
   * `keyId`: the fingerprint of the current TOKEN_ENCRYPTION_KEY (see lib/secret-box.ts).
   * `needsReseal`: true while the stored value is not yet sealed with the current key (a rotation
   * in progress); the vault re-seals it in the background as soon as it is read.
   */
  | {
      state: "stored";
      updatedAt: number | null;
      matchesServer: boolean | null;
      keyId: string | null;
      needsReseal: boolean;
    };

export type AuditAction = "created" | "updated" | "revealed";

export const AUDIT_ACTIONS: readonly AuditAction[] = ["created", "updated", "revealed"];

/** The requesting browser, as the request described it. `ip` is the raw address (lib/request-context.ts `clientIp`). */
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
 *
 * The address is never stored in full unless AUDIT_RAW_IP=1: `ip` carries the
 * raw address only for that opt-in, or for a record written before hashing
 * existed; a current record instead carries `ipHash` (sha256(salt + ip),
 * truncated) and `ipPrefix` (its /24 for IPv4, /48 for IPv6), so the trail
 * still tells two visits from the same network apart without keeping the
 * address itself. Exactly one of the two schemes is populated at a time.
 */
export interface AuditRecord {
  at: number;
  action: AuditAction;
  userAgent: string;
  brands: string;
  platform: string;
  ip: string | null;
  ipHash: string | null;
  ipPrefix: string | null;
  session: string | null;
}

/** One entry as the audit popup gets it. */
export interface AuditEntry {
  at: number;
  action: AuditAction;
  /** "Chrome 140"; null when the request named no known browser (the UI then says so, in its language). */
  browser: string | null;
  /** "macOS"; null when the request does not tell. */
  os: string | null;
  userAgent: string;
  /** One display string: "203.0.113.0/24 · 3fa9c1a2b91c", the raw address (AUDIT_RAW_IP=1 or a legacy record), or "unknown". */
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

/** Why a token cannot be saved; the UI shows `Settings.token_problem_<code>` with {min} and {max}. */
export type TokenProblemCode = "empty" | "not_ascii" | "too_short" | "too_long";

/** Why `value` (already trimmed) cannot be saved as the token; null when it can. */
export function apiTokenProblem(value: string): TokenProblemCode | null {
  if (value === "") return "empty";
  if (!TOKEN_PATTERN.test(value)) return "not_ascii";
  if (value.length < MIN_TOKEN_LENGTH) return "too_short";
  if (value.length > MAX_TOKEN_LENGTH) return "too_long";
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
    ...(record.ip !== null && { ip: record.ip }),
    ...(record.ipHash !== null && { iph: record.ipHash }),
    ...(record.ipPrefix !== null && { ipp: record.ipPrefix }),
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
  const optionalText = (field: unknown): string | null => (typeof field === "string" && field !== "" ? field : null);
  return {
    at: entry.at,
    action: entry.a as AuditAction,
    userAgent: text(entry.ua),
    brands: text(entry.ch),
    platform: text(entry.pf),
    ip: optionalText(entry.ip),
    ipHash: optionalText(entry.iph),
    ipPrefix: optionalText(entry.ipp),
    session: optionalText(entry.s),
  };
}

/** The address as the audit popup shows it: the raw one when kept, else its hash/prefix pair, else "unknown". */
function displayIp(record: Pick<AuditRecord, "ip" | "ipHash" | "ipPrefix">): string {
  if (record.ip !== null) return record.ip;
  if (record.ipPrefix !== null && record.ipHash !== null) return `${record.ipPrefix} · ${record.ipHash}`;
  return record.ipPrefix ?? record.ipHash ?? "unknown";
}

export function toAuditEntry(record: AuditRecord): AuditEntry {
  const { browser, os } = describeClient(record.userAgent, record.brands, record.platform);
  return {
    at: record.at,
    action: record.action,
    browser,
    os,
    userAgent: record.userAgent,
    ip: displayIp(record),
    session: record.session,
  };
}

/** A raw IPv4/IPv6 address's network prefix for the audit trail: "203.0.113.0/24", or the /48 for IPv6; null otherwise. */
export function networkPrefix(ip: string): string | null {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const octets = v4.slice(1, 5).map(Number);
    return octets.some((n) => n < 0 || n > 255) ? null : `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
  }
  if (ip.includes(":")) {
    const groups = expandIPv6(ip.split("%")[0] ?? "");
    if (!groups) return null;
    return `${groups
      .slice(0, 3)
      .map((group) => Number.parseInt(group, 16).toString(16))
      .join(":")}::/48`;
  }
  return null;
}

/** "2001:db8::1" (and every other valid textual form) to its 8 hextets, zero-padded; null when it does not parse. */
function expandIPv6(ip: string): string[] | null {
  if (!/^[0-9a-fA-F:]+$/.test(ip)) return null;
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const parts = ip.split(":");
    return parts.length === 8 && parts.every((part) => part.length > 0)
      ? parts.map((part) => part.padStart(4, "0"))
      : null;
  }
  const head = halves[0] ? halves[0].split(":").filter(Boolean) : [];
  const tail = halves[1] ? halves[1].split(":").filter(Boolean) : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  return [...head, ...Array(missing).fill("0"), ...tail].map((part) => part.padStart(4, "0"));
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

function browserFromUserAgent(userAgent: string): string | null {
  for (const [pattern, name] of UA_BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) return `${name} ${match[1]}`;
  }
  // Not a browser (curl, a script): its own first product token says what it is.
  const product = /^([A-Za-z][\w.-]*)\/([\w.]+)/.exec(userAgent);
  if (product && product[1] !== "Mozilla") return `${product[1]} ${product[2]}`;
  return null;
}

/**
 * "Chrome 140" and "macOS", from the User-Agent and, where a Chromium browser
 * sends them, its client hints. `browser` is null when neither names one; the
 * UI tells an unknown browser (a User-Agent it cannot read) from an unknown
 * client (no User-Agent at all) by `userAgent`.
 */
export function describeClient(
  userAgent: string,
  brands = "",
  platform = "",
): { browser: string | null; os: string | null } {
  const hinted = platform.replace(/"/g, "").trim();
  const os =
    hinted && hinted !== "Unknown"
      ? (PLATFORM_NAMES[hinted] ?? hinted)
      : (UA_SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null);
  return { browser: brandFromHints(brands) ?? browserFromUserAgent(userAgent), os };
}

// ── What the panel and the setup page say ────────────────────────────────────

export type StatusTone = "good" | "warning" | "problem" | "neutral";

/** The sentence's key in the `Settings` namespace (`token_status_*`). */
export type TokenStatusKey =
  | "token_status_no_key"
  | "token_status_empty"
  | "token_status_unreadable"
  | "token_status_mismatch"
  | "token_status_stored_matches"
  | "token_status_stored";

/** The status as a tone and a message key, for the settings panel and the setup page. */
export function apiTokenStatusNote(status: ApiTokenStatus): { tone: StatusTone; key: TokenStatusKey } {
  switch (status.state) {
    case "no_key":
      return { tone: "problem", key: "token_status_no_key" };
    case "empty":
      return { tone: "neutral", key: "token_status_empty" };
    case "unreadable":
      return { tone: "problem", key: "token_status_unreadable" };
    case "stored":
      if (status.matchesServer === false) return { tone: "warning", key: "token_status_mismatch" };
      return {
        tone: "good",
        key: status.matchesServer === true ? "token_status_stored_matches" : "token_status_stored",
      };
  }
}

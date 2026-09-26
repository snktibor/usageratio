import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AuditRecord,
  apiTokenProblem,
  apiTokenStatusNote,
  describeClient,
  isValidApiToken,
  networkPrefix,
  parseAuditRecord,
  serializeAuditRecord,
  toAuditEntry,
} from "@/lib/api-token";
import { keyFingerprint, openSecret, parseEncryptionKey, sealSecret } from "@/lib/secret-box";

const KEY = randomBytes(32);
const CONTEXT = "usageratio/usage-api-token/v1";
const TOKEN = "3f9a0c1e5b7d2f4a6c8e0b1d3f5a7c9e1b3d5f7a9c0e2b4d6f8a0c2e4b6d8f0a";

const UA = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  vivaldi:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Vivaldi/7.6.3797.52",
};

describe("the encryption key", () => {
  it("is read from 64 hex digits or from base64 / base64url of 32 bytes", () => {
    expect(parseEncryptionKey(KEY.toString("hex"))).toEqual(KEY);
    expect(parseEncryptionKey(KEY.toString("base64"))).toEqual(KEY);
    expect(parseEncryptionKey(`  ${KEY.toString("base64url")}\n`)).toEqual(KEY);
  });

  it("is refused when missing, short, long or mistyped, never stretched", () => {
    expect(parseEncryptionKey(undefined)).toBeNull();
    expect(parseEncryptionKey("   ")).toBeNull();
    expect(parseEncryptionKey("correct horse battery staple")).toBeNull();
    expect(parseEncryptionKey(randomBytes(16).toString("hex"))).toBeNull();
    expect(parseEncryptionKey(randomBytes(48).toString("base64"))).toBeNull();
    expect(parseEncryptionKey(`${KEY.toString("hex").slice(0, 63)}g`)).toBeNull();
  });
});

describe("a key fingerprint", () => {
  it("is short, stable and tells different keys apart", () => {
    const other = randomBytes(32);
    expect(keyFingerprint(KEY)).toHaveLength(8);
    expect(keyFingerprint(KEY)).toBe(keyFingerprint(KEY));
    expect(keyFingerprint(KEY)).not.toBe(keyFingerprint(other));
  });
});

describe("a sealed secret", () => {
  it("opens to the plaintext, and never holds it", () => {
    const sealed = sealSecret(TOKEN, KEY, CONTEXT);
    expect(JSON.stringify(sealed)).not.toContain(TOKEN);
    expect(Buffer.from(sealed.iv, "base64url")).toHaveLength(12);
    expect(Buffer.from(sealed.tag, "base64url")).toHaveLength(16);
    expect(openSecret(JSON.parse(JSON.stringify(sealed)), KEY, CONTEXT)).toBe(TOKEN);
  });

  it("gets a fresh IV every time", () => {
    const first = sealSecret(TOKEN, KEY, CONTEXT);
    const second = sealSecret(TOKEN, KEY, CONTEXT);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ct).not.toBe(second.ct);
  });

  it("carries its key's fingerprint as `kid` when asked to, and none otherwise", () => {
    const withKid = sealSecret(TOKEN, KEY, CONTEXT, keyFingerprint(KEY));
    expect(withKid.kid).toBe(keyFingerprint(KEY));
    expect(withKid.v).toBe(1);
    const withoutKid = sealSecret(TOKEN, KEY, CONTEXT);
    expect(withoutKid.kid).toBeUndefined();
    // `kid` is only ever an extra field: a build that does not know about it still opens the value.
    expect(openSecret(withKid, KEY, CONTEXT)).toBe(TOKEN);
  });

  it("does not open with another key or for another purpose", () => {
    const sealed = sealSecret(TOKEN, KEY, CONTEXT);
    expect(() => openSecret(sealed, randomBytes(32), CONTEXT)).toThrow();
    expect(() => openSecret(sealed, KEY, "usageratio/something-else/v1")).toThrow();
  });

  it("does not open once any part is changed", () => {
    const sealed = sealSecret(TOKEN, KEY, CONTEXT);
    const flip = (text: string) => {
      const bytes = Buffer.from(text, "base64url");
      bytes[0] = bytes[0]! ^ 1;
      return bytes.toString("base64url");
    };
    expect(() => openSecret({ ...sealed, ct: flip(sealed.ct) }, KEY, CONTEXT)).toThrow();
    expect(() => openSecret({ ...sealed, iv: flip(sealed.iv) }, KEY, CONTEXT)).toThrow();
    expect(() => openSecret({ ...sealed, tag: flip(sealed.tag) }, KEY, CONTEXT)).toThrow();
    expect(() => openSecret({ ...sealed, tag: sealed.tag.slice(0, 8) }, KEY, CONTEXT)).toThrow();
    expect(() => openSecret({ ...sealed, v: 2 }, KEY, CONTEXT)).toThrow();
    expect(() => openSecret(null, KEY, CONTEXT)).toThrow();
    expect(() => openSecret({ v: 1, iv: sealed.iv, tag: sealed.tag }, KEY, CONTEXT)).toThrow();
  });
});

describe("a token to store", () => {
  it("is 16 to 512 printable ASCII characters without spaces", () => {
    expect(isValidApiToken(TOKEN)).toBe(true);
    expect(isValidApiToken("a".repeat(16))).toBe(true);
    expect(isValidApiToken("a".repeat(512))).toBe(true);
    expect(isValidApiToken("a".repeat(15))).toBe(false);
    expect(isValidApiToken("a".repeat(513))).toBe(false);
    expect(isValidApiToken("abcdefgh ijklmnopq")).toBe(false);
    expect(isValidApiToken("árvíztűrőtükörfúrógép")).toBe(false);
    expect(isValidApiToken(1234567890123456)).toBe(false);
    expect(isValidApiToken(null)).toBe(false);
  });

  it("gets a reason in Hungarian when it cannot be saved", () => {
    expect(apiTokenProblem(TOKEN)).toBeNull();
    expect(apiTokenProblem("")).toBe("empty");
    expect(apiTokenProblem("short")).toBe("too_short");
    expect(apiTokenProblem("with a space inside it")).toBe("not_ascii");
    expect(apiTokenProblem("a".repeat(513))).toBe("too_long");
  });
});

describe("naming the browser", () => {
  it("prefers the Chromium client hints", () => {
    expect(
      describeClient(UA.chromeMac, '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"', '"macOS"'),
    ).toEqual({ browser: "Chrome 140", os: "macOS" });
    expect(
      describeClient(UA.edgeWindows, '"Microsoft Edge";v="140", "Not)A;Brand";v="8", "Chromium";v="140"', '"Windows"'),
    ).toEqual({ browser: "Edge 140", os: "Windows" });
    expect(
      describeClient(UA.chromeMac, '"Brave";v="140", "Chromium";v="140", "Not_A Brand";v="24"', '"Chrome OS"'),
    ).toEqual({ browser: "Brave 140", os: "ChromeOS" });
    // A browser that only names the engine is still named.
    expect(describeClient("", '"Chromium";v="139", "Not/A)Brand";v="99"', '"Linux"')).toEqual({
      browser: "Chromium 139",
      os: "Linux",
    });
  });

  it("falls back to the User-Agent", () => {
    expect(describeClient(UA.chromeMac)).toEqual({ browser: "Chrome 140", os: "macOS" });
    expect(describeClient(UA.edgeWindows)).toEqual({ browser: "Edge 140", os: "Windows" });
    expect(describeClient(UA.safariMac)).toEqual({ browser: "Safari 18", os: "macOS" });
    expect(describeClient(UA.safariIphone)).toEqual({ browser: "Safari 18", os: "iOS" });
    expect(describeClient(UA.firefoxLinux)).toEqual({ browser: "Firefox 143", os: "Linux" });
    expect(describeClient(UA.chromeAndroid)).toEqual({ browser: "Chrome 140", os: "Android" });
    expect(describeClient(UA.vivaldi)).toEqual({ browser: "Vivaldi 7", os: "macOS" });
    // An "Unknown" platform hint does not hide what the User-Agent says.
    expect(describeClient(UA.firefoxLinux, "", '"Unknown"').os).toBe("Linux");
  });

  it("names a non-browser client by its product token", () => {
    expect(describeClient("curl/8.7.1")).toEqual({ browser: "curl 8.7.1", os: null });
    // Unknown browser and unknown client alike: the UI tells them apart by the User-Agent being empty.
    expect(describeClient("Mozilla/5.0 (compatible)")).toEqual({ browser: null, os: null });
    expect(describeClient("")).toEqual({ browser: null, os: null });
  });
});

describe("an address's network prefix", () => {
  it("is the /24 for IPv4", () => {
    expect(networkPrefix("203.0.113.7")).toBe("203.0.113.0/24");
    expect(networkPrefix("10.20.30.40")).toBe("10.20.30.0/24");
    expect(networkPrefix("999.0.0.1")).toBeNull();
  });

  it("is the /48 for IPv6, compressed forms included", () => {
    expect(networkPrefix("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
    expect(networkPrefix("::1")).toBe("0:0:0::/48");
    expect(networkPrefix("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe("2001:db8:0::/48");
  });

  it("is null for anything else", () => {
    expect(networkPrefix("unknown")).toBeNull();
    expect(networkPrefix("not-an-address")).toBeNull();
    expect(networkPrefix("")).toBeNull();
  });
});

describe("an audit record", () => {
  const record: AuditRecord = {
    at: 1_790_000_000_000,
    action: "revealed",
    userAgent: UA.safariMac,
    brands: "",
    platform: "",
    ip: null,
    ipHash: "3fa9c1a2b91c",
    ipPrefix: "203.0.113.0/24",
    session: "1a2b3c4d",
  };

  it("survives a round trip through Redis", () => {
    expect(parseAuditRecord(serializeAuditRecord(record))).toEqual(record);
    expect(parseAuditRecord(serializeAuditRecord({ ...record, session: null }))?.session).toBeNull();
  });

  it("keeps a legacy raw-IP record readable, with no hash or prefix", () => {
    const legacy: AuditRecord = { ...record, ip: "203.0.113.7", ipHash: null, ipPrefix: null };
    expect(parseAuditRecord(serializeAuditRecord(legacy))).toEqual(legacy);
    expect(toAuditEntry(legacy).ip).toBe("203.0.113.7");
  });

  it("is named for the popup when read: hash and prefix combine into one display string", () => {
    expect(toAuditEntry(record)).toEqual({
      at: record.at,
      action: "revealed",
      browser: "Safari 18",
      os: "macOS",
      userAgent: UA.safariMac,
      ip: "203.0.113.0/24 · 3fa9c1a2b91c",
      session: "1a2b3c4d",
    });
  });

  it("falls back to just the prefix, just the hash, or 'unknown'", () => {
    expect(toAuditEntry({ ...record, ipHash: null }).ip).toBe("203.0.113.0/24");
    expect(toAuditEntry({ ...record, ipPrefix: null }).ip).toBe("3fa9c1a2b91c");
    expect(toAuditEntry({ ...record, ipHash: null, ipPrefix: null }).ip).toBe("unknown");
  });

  it("is skipped when damaged, and read leniently when fields are missing", () => {
    expect(parseAuditRecord("not json")).toBeNull();
    expect(parseAuditRecord("[]")).toBeNull();
    expect(parseAuditRecord('{"at":"yesterday","a":"revealed"}')).toBeNull();
    expect(parseAuditRecord('{"at":1,"a":"deleted"}')).toBeNull();
    expect(parseAuditRecord('{"at":1,"a":"created"}')).toEqual({
      at: 1,
      action: "created",
      userAgent: "",
      brands: "",
      platform: "",
      ip: null,
      ipHash: null,
      ipPrefix: null,
      session: null,
    });
  });
});

describe("the status note", () => {
  const stored = (matchesServer: boolean | null) =>
    ({ state: "stored", updatedAt: 1, matchesServer, keyId: "abcd1234", needsReseal: false }) as const;

  it("warns when the stored token is not the server's", () => {
    expect(apiTokenStatusNote(stored(false)).tone).toBe("warning");
    expect(apiTokenStatusNote(stored(true)).tone).toBe("good");
    expect(apiTokenStatusNote(stored(null)).tone).toBe("good");
    expect(apiTokenStatusNote({ state: "unreadable", updatedAt: 1 }).tone).toBe("problem");
    expect(apiTokenStatusNote({ state: "no_key" }).key).toBe("token_status_no_key");
    expect(apiTokenStatusNote(stored(false)).key).toBe("token_status_mismatch");
    expect(apiTokenStatusNote(stored(null)).key).toBe("token_status_stored");
    expect(apiTokenStatusNote({ state: "empty" }).tone).toBe("neutral");
  });
});

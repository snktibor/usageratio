import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AuditRecord,
  apiTokenProblem,
  apiTokenStatusNote,
  describeClient,
  isValidApiToken,
  parseAuditRecord,
  serializeAuditRecord,
  toAuditEntry,
} from "@/lib/api-token";
import { openSecret, parseEncryptionKey, sealSecret } from "@/lib/secret-box";

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
    expect(apiTokenProblem("")).toMatch(/Írd vagy illeszd be/);
    expect(apiTokenProblem("short")).toMatch(/legalább 16/);
    expect(apiTokenProblem("with a space inside it")).toMatch(/szóközt/);
    expect(apiTokenProblem("a".repeat(513))).toMatch(/legfeljebb 512/);
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
    expect(describeClient("Mozilla/5.0 (compatible)")).toEqual({ browser: "Ismeretlen böngésző", os: null });
    expect(describeClient("")).toEqual({ browser: "Ismeretlen kliens", os: null });
  });
});

describe("an audit record", () => {
  const record: AuditRecord = {
    at: 1_790_000_000_000,
    action: "revealed",
    userAgent: UA.safariMac,
    brands: "",
    platform: "",
    ip: "203.0.113.7",
    session: "1a2b3c4d",
  };

  it("survives a round trip through Redis", () => {
    expect(parseAuditRecord(serializeAuditRecord(record))).toEqual(record);
    expect(parseAuditRecord(serializeAuditRecord({ ...record, session: null }))?.session).toBeNull();
  });

  it("is named for the popup when read", () => {
    expect(toAuditEntry(record)).toEqual({
      at: record.at,
      action: "revealed",
      browser: "Safari 18",
      os: "macOS",
      userAgent: UA.safariMac,
      ip: "203.0.113.7",
      session: "1a2b3c4d",
    });
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
      ip: "unknown",
      session: null,
    });
  });
});

describe("the status note", () => {
  it("warns when the stored token is not the server's", () => {
    expect(apiTokenStatusNote({ state: "stored", updatedAt: 1, matchesServer: false }).tone).toBe("warning");
    expect(apiTokenStatusNote({ state: "stored", updatedAt: 1, matchesServer: true }).tone).toBe("good");
    expect(apiTokenStatusNote({ state: "stored", updatedAt: 1, matchesServer: null }).tone).toBe("good");
    expect(apiTokenStatusNote({ state: "unreadable", updatedAt: 1 }).tone).toBe("problem");
    expect(apiTokenStatusNote({ state: "no_key" }).text).toMatch(/TOKEN_ENCRYPTION_KEY/);
    expect(apiTokenStatusNote({ state: "empty" }).tone).toBe("neutral");
  });
});

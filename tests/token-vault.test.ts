import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_LIMIT, serializeAuditRecord } from "@/lib/api-token";
import { getRedis } from "@/lib/redis";
import { sha256Hex } from "@/lib/security";
import { encryptionKey, loadApiTokenStatus, loadAuditTrail, revealApiToken, saveApiToken } from "@/lib/token-vault";
import { useRedis } from "./helpers/redis-fixture";
import { fakeCookieJar, withRequest } from "./helpers/request";

/**
 * Characterization tests for lib/token-vault.ts as it is today (one key, raw
 * client IP on the audit trail), pinned so M2's key rotation and hashed
 * addresses change it knowingly.
 */

const KEY_B64 = Buffer.alloc(32, 7).toString("base64");
const OTHER_KEY = Buffer.alloc(32, 9);
const SERVER_TOKEN = "0123456789abcdef0123456789abcdef";
const TOKEN_KEY = "usage:api-token";
const AUDIT_KEY = "usage:api-token:audit";
const NOW = new Date("2026-09-26T10:00:00Z");

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const BROWSER_HEADERS = {
  "user-agent": CHROME_UA,
  "sec-ch-ua": '"Chromium";v="140", "Google Chrome";v="140", "Not.A/Brand";v="24"',
  "sec-ch-ua-platform": '"macOS"',
  "x-forwarded-for": "203.0.113.9",
};
const SESSION_ID = "a".repeat(43);

function key(): Buffer {
  const parsed = encryptionKey();
  if (!parsed) throw new Error("the test key did not parse");
  return parsed;
}

describe("the token vault", () => {
  const redis = useRedis();

  beforeEach(() => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", KEY_B64);
    vi.stubEnv("USAGE_API_TOKEN", SERVER_TOKEN);
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_PROXY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  describe("the encryption key", () => {
    it("comes from TOKEN_ENCRYPTION_KEY as base64 or hex, and is null when missing or malformed", () => {
      expect(encryptionKey()?.equals(Buffer.alloc(32, 7))).toBe(true);
      expect(encryptionKey({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("hex") })?.length).toBe(32);
      expect(encryptionKey({})).toBeNull();
      expect(encryptionKey({ TOKEN_ENCRYPTION_KEY: "" })).toBeNull();
      expect(encryptionKey({ TOKEN_ENCRYPTION_KEY: "too-short" })).toBeNull();
      expect(encryptionKey({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") })).toBeNull();
    });

    it("without a key nothing can be stored or read: the status says no_key", async () => {
      vi.stubEnv("TOKEN_ENCRYPTION_KEY", "");
      expect(await loadApiTokenStatus()).toEqual({ state: "no_key" });
      vi.stubEnv("TOKEN_ENCRYPTION_KEY", "not a key");
      expect(await loadApiTokenStatus()).toEqual({ state: "no_key" });
      // saveApiToken takes the key as a parameter: without one it cannot even be called.
    });
  });

  describe("saving", () => {
    it("is empty at first, then stored and compared with the server's token", async () => {
      expect(await loadApiTokenStatus()).toEqual({ state: "empty" });

      const saved = await withRequest(() => saveApiToken(SERVER_TOKEN, key(), NOW), { headers: BROWSER_HEADERS });
      expect(saved).toEqual({
        action: "created",
        status: { state: "stored", updatedAt: NOW.getTime(), matchesServer: true },
      });
      expect(await loadApiTokenStatus()).toEqual({ state: "stored", updatedAt: NOW.getTime(), matchesServer: true });

      // The store holds ciphertext, never the token.
      const raw = String(await getRedis().get(TOKEN_KEY));
      expect(raw).not.toContain(SERVER_TOKEN);
      const document = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(document).sort()).toEqual(["ct", "iv", "tag", "updatedAt", "v"]);
      expect(document.v).toBe(1);
      expect(document.updatedAt).toBe(NOW.getTime());
      expect(redis.store?.ttl(TOKEN_KEY) ?? -1).toBe(-1);
    });

    it("a second save is an update, and a different value shows up as a mismatch", async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, key(), NOW));
      const later = new Date(NOW.getTime() + 60_000);
      const saved = await withRequest(() => saveApiToken("another-token-of-16-chars", key(), later));
      expect(saved).toEqual({
        action: "updated",
        status: { state: "stored", updatedAt: later.getTime(), matchesServer: false },
      });
      expect(await loadApiTokenStatus()).toEqual({ state: "stored", updatedAt: later.getTime(), matchesServer: false });

      // Without USAGE_API_TOKEN there is nothing to compare with.
      vi.stubEnv("USAGE_API_TOKEN", "");
      expect(await loadApiTokenStatus()).toMatchObject({ state: "stored", matchesServer: null });
    });

    it("puts the save on the audit trail with the browser's details", async () => {
      const jar = fakeCookieJar({ usageratio_session: SESSION_ID });
      await withRequest(() => saveApiToken(SERVER_TOKEN, key(), NOW), { headers: BROWSER_HEADERS, cookies: jar });
      const trail = await loadAuditTrail();
      expect(trail).toEqual([
        {
          at: NOW.getTime(),
          action: "created",
          browser: "Chrome 140",
          os: "macOS",
          userAgent: CHROME_UA,
          ip: "203.0.113.9", // raw today; M2 hashes it
          session: sha256Hex(SESSION_ID).slice(0, 8),
        },
      ]);
    });
  });

  describe("revealing", () => {
    it("answers empty before a save", async () => {
      expect(await withRequest(() => revealApiToken(key(), NOW))).toEqual({ state: "empty" });
      expect(await loadAuditTrail()).toEqual([]);
    });

    it("hands the token out only after the request is on the audit trail, newest first", async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, key(), NOW), { headers: BROWSER_HEADERS });
      const later = new Date(NOW.getTime() + 5_000);
      const revealed = await withRequest(() => revealApiToken(key(), later), {
        headers: { ...BROWSER_HEADERS, "x-forwarded-for": "198.51.100.7" },
        cookies: fakeCookieJar({ usageratio_session: SESSION_ID }),
      });
      expect(revealed).toEqual({ state: "stored", token: SERVER_TOKEN });

      const trail = await loadAuditTrail();
      expect(trail.map((entry) => [entry.action, entry.at, entry.ip, entry.session])).toEqual([
        ["revealed", later.getTime(), "198.51.100.7", sha256Hex(SESSION_ID).slice(0, 8)],
        ["created", NOW.getTime(), "203.0.113.9", null],
      ]);
    });

    it("records an anonymous client as 'unknown' with no session", async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, key(), NOW));
      await withRequest(() => revealApiToken(key(), NOW));
      const [entry] = await loadAuditTrail();
      expect(entry).toMatchObject({ action: "revealed", ip: "unknown", session: null, userAgent: "", os: null });
      expect(entry?.browser).toBe("Ismeretlen kliens"); // hardcoded Hungarian, M1 moves it to the messages
    });

    it("keeps the token back when the audit write fails", async ({ skip }) => {
      if (redis.real) skip();
      await withRequest(() => saveApiToken(SERVER_TOKEN, key(), NOW));
      redis.store?.failNext("LPUSH", "injected: audit list unavailable");
      await expect(withRequest(() => revealApiToken(key(), NOW))).rejects.toThrow();
      // Nothing was appended: the trail still holds the save alone.
      expect((await loadAuditTrail()).map((entry) => entry.action)).toEqual(["created"]);
    });

    it(`keeps at most ${AUDIT_LIMIT} entries, dropping the oldest`, async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, key(), NOW));
      const old = Array.from({ length: AUDIT_LIMIT + 20 }, (_, index) =>
        serializeAuditRecord({
          at: NOW.getTime() - (index + 1) * 1000,
          action: "revealed",
          userAgent: "curl/8.0",
          brands: "",
          platform: "",
          ip: "203.0.113.9",
          session: null,
        }),
      );
      // Newest first: the list already has the "created" entry at the head.
      await getRedis().rpush(AUDIT_KEY, ...old);
      expect(await getRedis().llen(AUDIT_KEY)).toBe(AUDIT_LIMIT + 21);

      const revealedAt = new Date(NOW.getTime() + 1000);
      await withRequest(() => revealApiToken(key(), revealedAt));
      const trail = await loadAuditTrail();
      expect(trail).toHaveLength(AUDIT_LIMIT);
      expect(await getRedis().llen(AUDIT_KEY)).toBe(AUDIT_LIMIT);
      expect(trail[0]).toMatchObject({ action: "revealed", at: revealedAt.getTime() });
      expect(trail[1]).toMatchObject({ action: "created", at: NOW.getTime() });
      // The oldest entries fell off the end.
      expect(trail.at(-1)?.at).toBe(NOW.getTime() - (AUDIT_LIMIT - 2) * 1000);
    });

    it("skips entries on the trail that do not parse", async () => {
      await getRedis().lpush(
        AUDIT_KEY,
        "not json",
        JSON.stringify({ at: "x", a: "revealed" }),
        JSON.stringify({ a: "nope" }),
      );
      expect(await loadAuditTrail()).toEqual([]);
    });
  });

  describe("a stored copy that does not open", () => {
    it("is unreadable after the ciphertext was damaged, keeping its timestamp", async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, key(), NOW));
      const document = JSON.parse(String(await getRedis().get(TOKEN_KEY))) as Record<string, string>;
      const ct = document.ct!;
      document.ct = `${ct.slice(0, -2)}${ct.endsWith("AA") ? "BB" : "AA"}`;
      await getRedis().set(TOKEN_KEY, JSON.stringify(document));

      expect(await loadApiTokenStatus()).toEqual({ state: "unreadable", updatedAt: NOW.getTime() });
      expect(await withRequest(() => revealApiToken(key(), NOW))).toEqual({ state: "unreadable" });
      // A refused reveal leaves no trace on the trail.
      expect((await loadAuditTrail()).map((entry) => entry.action)).toEqual(["created"]);
    });

    it("is unreadable under another key (there is no rotation path today)", async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, key(), NOW));
      expect(await loadApiTokenStatus(OTHER_KEY)).toEqual({ state: "unreadable", updatedAt: NOW.getTime() });
      expect(await withRequest(() => revealApiToken(OTHER_KEY, NOW))).toEqual({ state: "unreadable" });
      vi.stubEnv("TOKEN_ENCRYPTION_KEY", OTHER_KEY.toString("base64"));
      expect(await loadApiTokenStatus()).toEqual({ state: "unreadable", updatedAt: NOW.getTime() });
    });

    it("is unreadable, without a timestamp, when the stored value is not even JSON", async () => {
      await getRedis().set(TOKEN_KEY, "garbage");
      expect(await loadApiTokenStatus()).toEqual({ state: "unreadable", updatedAt: null });
      await getRedis().set(TOKEN_KEY, JSON.stringify({ v: 2, iv: "", ct: "", tag: "", updatedAt: 5 }));
      expect(await loadApiTokenStatus()).toEqual({ state: "unreadable", updatedAt: 5 });
    });

    it("a re-save replaces the damaged copy and reads as an update", async () => {
      await getRedis().set(TOKEN_KEY, "garbage");
      const saved = await withRequest(() => saveApiToken(SERVER_TOKEN, key(), NOW));
      expect(saved.action).toBe("updated");
      expect(await loadApiTokenStatus()).toEqual({ state: "stored", updatedAt: NOW.getTime(), matchesServer: true });
    });
  });
});

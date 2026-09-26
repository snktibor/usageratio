import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUDIT_LIMIT, serializeAuditRecord } from "@/lib/api-token";
import { getRedis } from "@/lib/redis";
import { flushDeferred } from "@/lib/request-context";
import { keyFingerprint, sealSecret } from "@/lib/secret-box";
import { sha256Hex } from "@/lib/security";
import {
  encryptionKey,
  encryptionKeys,
  loadApiTokenStatus,
  loadAuditTrail,
  revealApiToken,
  saveApiToken,
} from "@/lib/token-vault";
import { useRedis } from "./helpers/redis-fixture";
import { fakeCookieJar, withRequest } from "./helpers/request";

/**
 * lib/token-vault.ts as M2 leaves it: key rotation (TOKEN_ENCRYPTION_KEY_PREVIOUS,
 * `kid`, background re-sealing) and a hashed, prefix-only audit trail
 * (raw addresses only with AUDIT_RAW_IP=1, or on a record from before hashing existed).
 */

const KEY = Buffer.alloc(32, 7);
const KEY_B64 = KEY.toString("base64");
const PREVIOUS_KEY = Buffer.alloc(32, 3);
const OTHER_KEY = Buffer.alloc(32, 9);
const SERVER_TOKEN = "0123456789abcdef0123456789abcdef";
const TOKEN_KEY = "usage:api-token";
const AUDIT_KEY = "usage:api-token:audit";
const CONTEXT = "usageratio/usage-api-token/v1";
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

function ipFields(ip: string, salt = sha256Hex(KEY_B64)) {
  return { ipHash: sha256Hex(`${salt}${ip}`).slice(0, 12), ipPrefix: `${ip.split(".").slice(0, 3).join(".")}.0/24` };
}

describe("the token vault", () => {
  const redis = useRedis();

  beforeEach(() => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", KEY_B64);
    vi.stubEnv("TOKEN_ENCRYPTION_KEY_PREVIOUS", "");
    vi.stubEnv("USAGE_API_TOKEN", SERVER_TOKEN);
    vi.stubEnv("AUDIT_SALT", "");
    vi.stubEnv("AUDIT_RAW_IP", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUST_PROXY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  describe("the encryption keys", () => {
    it("comes from TOKEN_ENCRYPTION_KEY as base64 or hex, and is null when missing or malformed", () => {
      expect(encryptionKey()?.equals(KEY)).toBe(true);
      expect(encryptionKey({ TOKEN_ENCRYPTION_KEY: KEY.toString("hex") })?.length).toBe(32);
      expect(encryptionKey({})).toBeNull();
      expect(encryptionKey({ TOKEN_ENCRYPTION_KEY: "" })).toBeNull();
      expect(encryptionKey({ TOKEN_ENCRYPTION_KEY: "too-short" })).toBeNull();
      expect(encryptionKey({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(16, 1).toString("base64") })).toBeNull();
    });

    it("reports the current key's fingerprint, and the previous key only when set", () => {
      expect(encryptionKeys()).toEqual({ current: KEY, previous: null, currentKid: keyFingerprint(KEY) });
      vi.stubEnv("TOKEN_ENCRYPTION_KEY_PREVIOUS", PREVIOUS_KEY.toString("base64"));
      expect(encryptionKeys()).toEqual({ current: KEY, previous: PREVIOUS_KEY, currentKid: keyFingerprint(KEY) });
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

      const saved = await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW), { headers: BROWSER_HEADERS });
      expect(saved).toEqual({
        action: "created",
        status: {
          state: "stored",
          updatedAt: NOW.getTime(),
          matchesServer: true,
          keyId: keyFingerprint(KEY),
          needsReseal: false,
        },
      });
      expect(await loadApiTokenStatus()).toEqual({
        state: "stored",
        updatedAt: NOW.getTime(),
        matchesServer: true,
        keyId: keyFingerprint(KEY),
        needsReseal: false,
      });

      // The store holds ciphertext, never the token.
      const raw = String(await getRedis().get(TOKEN_KEY));
      expect(raw).not.toContain(SERVER_TOKEN);
      const document = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(document).sort()).toEqual(["ct", "iv", "kid", "tag", "updatedAt", "v"]);
      expect(document.v).toBe(1);
      expect(document.kid).toBe(keyFingerprint(KEY));
      expect(document.updatedAt).toBe(NOW.getTime());
      expect(redis.store?.ttl(TOKEN_KEY) ?? -1).toBe(-1);
    });

    it("a second save is an update, and a different value shows up as a mismatch", async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW));
      const later = new Date(NOW.getTime() + 60_000);
      const saved = await withRequest(() => saveApiToken("another-token-of-16-chars", KEY, later));
      expect(saved).toMatchObject({ action: "updated", status: { updatedAt: later.getTime(), matchesServer: false } });
      expect(await loadApiTokenStatus()).toMatchObject({
        state: "stored",
        updatedAt: later.getTime(),
        matchesServer: false,
      });

      // Without USAGE_API_TOKEN there is nothing to compare with.
      vi.stubEnv("USAGE_API_TOKEN", "");
      expect(await loadApiTokenStatus()).toMatchObject({ state: "stored", matchesServer: null });
    });

    it("puts the save on the audit trail with the browser's details, IP hashed rather than kept", async () => {
      const jar = fakeCookieJar({ usageratio_session: SESSION_ID });
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW), { headers: BROWSER_HEADERS, cookies: jar });
      const trail = await loadAuditTrail();
      const { ipHash, ipPrefix } = ipFields("203.0.113.9");
      expect(trail).toEqual([
        {
          at: NOW.getTime(),
          action: "created",
          browser: "Chrome 140",
          os: "macOS",
          userAgent: CHROME_UA,
          ip: `${ipPrefix} · ${ipHash}`,
          session: sha256Hex(SESSION_ID).slice(0, 8),
        },
      ]);

      // Nothing in the stored record carries the address itself.
      const [raw] = await getRedis().lrange<string>(AUDIT_KEY, 0, 0);
      expect(String(raw)).not.toContain("203.0.113.9");
    });

    it("keeps the raw address when AUDIT_RAW_IP=1", async () => {
      vi.stubEnv("AUDIT_RAW_IP", "1");
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW), { headers: BROWSER_HEADERS });
      const [entry] = await loadAuditTrail();
      expect(entry?.ip).toBe("203.0.113.9");
    });

    it("hashes with AUDIT_SALT when it is set, instead of TOKEN_ENCRYPTION_KEY", async () => {
      vi.stubEnv("AUDIT_SALT", "a-fixed-salt");
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW), { headers: BROWSER_HEADERS });
      const [entry] = await loadAuditTrail();
      const { ipHash, ipPrefix } = ipFields("203.0.113.9", "a-fixed-salt");
      expect(entry?.ip).toBe(`${ipPrefix} · ${ipHash}`);
    });

    it("caps the User-Agent at 256 characters", async () => {
      const longUa = `Mozilla/5.0 ${"x".repeat(400)}`;
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW), { headers: { "user-agent": longUa } });
      const [entry] = await loadAuditTrail();
      expect(entry?.userAgent).toHaveLength(256);
      expect(entry?.userAgent).toBe(longUa.slice(0, 256));
    });
  });

  describe("revealing", () => {
    it("answers empty before a save", async () => {
      expect(await withRequest(() => revealApiToken(KEY, NOW))).toEqual({ state: "empty" });
      expect(await loadAuditTrail()).toEqual([]);
    });

    it("hands the token out only after the request is on the audit trail, newest first", async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW), { headers: BROWSER_HEADERS });
      const later = new Date(NOW.getTime() + 5_000);
      const revealed = await withRequest(() => revealApiToken(KEY, later), {
        headers: { ...BROWSER_HEADERS, "x-forwarded-for": "198.51.100.7" },
        cookies: fakeCookieJar({ usageratio_session: SESSION_ID }),
      });
      expect(revealed).toEqual({ state: "stored", token: SERVER_TOKEN });

      const trail = await loadAuditTrail();
      const revealIp = ipFields("198.51.100.7");
      const saveIp = ipFields("203.0.113.9");
      expect(trail.map((entry) => [entry.action, entry.at, entry.ip, entry.session])).toEqual([
        ["revealed", later.getTime(), `${revealIp.ipPrefix} · ${revealIp.ipHash}`, sha256Hex(SESSION_ID).slice(0, 8)],
        ["created", NOW.getTime(), `${saveIp.ipPrefix} · ${saveIp.ipHash}`, null],
      ]);
    });

    it("records an anonymous client as 'unknown' with no session", async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW));
      await withRequest(() => revealApiToken(KEY, NOW));
      const [entry] = await loadAuditTrail();
      expect(entry).toMatchObject({ action: "revealed", ip: "unknown", session: null, userAgent: "", os: null });
      expect(entry?.browser).toBeNull(); // the UI says "unknown client" in its own language
    });

    it("keeps the token back when the audit write fails", async ({ skip }) => {
      if (redis.real) skip();
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW));
      redis.store?.failNext("LPUSH", "injected: audit list unavailable");
      await expect(withRequest(() => revealApiToken(KEY, NOW))).rejects.toThrow();
      // Nothing was appended: the trail still holds the save alone.
      expect((await loadAuditTrail()).map((entry) => entry.action)).toEqual(["created"]);
    });

    it(`keeps at most ${AUDIT_LIMIT} entries, dropping the oldest`, async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW));
      const old = Array.from({ length: AUDIT_LIMIT + 20 }, (_, index) =>
        serializeAuditRecord({
          at: NOW.getTime() - (index + 1) * 1000,
          action: "revealed",
          userAgent: "curl/8.0",
          brands: "",
          platform: "",
          ip: "203.0.113.9",
          ipHash: null,
          ipPrefix: null,
          session: null,
        }),
      );
      // Newest first: the list already has the "created" entry at the head.
      await getRedis().rpush(AUDIT_KEY, ...old);
      expect(await getRedis().llen(AUDIT_KEY)).toBe(AUDIT_LIMIT + 21);

      const revealedAt = new Date(NOW.getTime() + 1000);
      await withRequest(() => revealApiToken(KEY, revealedAt));
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
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW));
      const document = JSON.parse(String(await getRedis().get(TOKEN_KEY))) as Record<string, string>;
      const ct = document.ct!;
      document.ct = `${ct.slice(0, -2)}${ct.endsWith("AA") ? "BB" : "AA"}`;
      await getRedis().set(TOKEN_KEY, JSON.stringify(document));

      expect(await loadApiTokenStatus()).toEqual({ state: "unreadable", updatedAt: NOW.getTime() });
      expect(await withRequest(() => revealApiToken(KEY, NOW))).toEqual({ state: "unreadable" });
      // A refused reveal leaves no trace on the trail.
      expect((await loadAuditTrail()).map((entry) => entry.action)).toEqual(["created"]);
    });

    it("is unreadable under an unrelated key with no rotation set up", async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW));
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
      const saved = await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW));
      expect(saved.action).toBe("updated");
      expect(await loadApiTokenStatus()).toMatchObject({
        state: "stored",
        updatedAt: NOW.getTime(),
        matchesServer: true,
      });
    });
  });

  describe("key rotation", () => {
    beforeEach(() => {
      vi.stubEnv("TOKEN_ENCRYPTION_KEY_PREVIOUS", PREVIOUS_KEY.toString("base64"));
    });

    it("opens a document sealed with the previous key, flags it, and re-seals it with the current one", async () => {
      const sealed = sealSecret(SERVER_TOKEN, PREVIOUS_KEY, CONTEXT, keyFingerprint(PREVIOUS_KEY));
      await getRedis().set(TOKEN_KEY, JSON.stringify({ ...sealed, updatedAt: NOW.getTime() }));

      const status = await withRequest(() => loadApiTokenStatus(KEY));
      expect(status).toEqual({
        state: "stored",
        updatedAt: NOW.getTime(),
        matchesServer: true,
        keyId: keyFingerprint(KEY),
        needsReseal: true,
      });
      await flushDeferred();

      const resealed = JSON.parse(String(await getRedis().get(TOKEN_KEY))) as Record<string, unknown>;
      expect(resealed.kid).toBe(keyFingerprint(KEY));
      // Re-sealed, but the content is unchanged and the timestamp is kept.
      expect(resealed.updatedAt).toBe(NOW.getTime());
      const rereadStatus = await withRequest(() => loadApiTokenStatus(KEY));
      expect(rereadStatus).toMatchObject({ needsReseal: false });
    });

    it("still opens a document from before `kid` existed, and adds one", async () => {
      const sealed = sealSecret(SERVER_TOKEN, KEY, CONTEXT);
      expect(sealed.kid).toBeUndefined();
      await getRedis().set(TOKEN_KEY, JSON.stringify({ ...sealed, updatedAt: NOW.getTime() }));

      const status = await withRequest(() => loadApiTokenStatus(KEY));
      expect(status).toMatchObject({ state: "stored", needsReseal: true });
      await flushDeferred();
      const resealed = JSON.parse(String(await getRedis().get(TOKEN_KEY))) as Record<string, unknown>;
      expect(resealed.kid).toBe(keyFingerprint(KEY));
    });

    it("opens a document tagged with a kid that matches neither key, by trying both", async () => {
      const sealed = sealSecret(SERVER_TOKEN, KEY, CONTEXT, "ffffffff");
      await getRedis().set(TOKEN_KEY, JSON.stringify({ ...sealed, updatedAt: NOW.getTime() }));

      const revealed = await withRequest(() => revealApiToken(KEY, NOW));
      expect(revealed).toEqual({ state: "stored", token: SERVER_TOKEN });
    });

    it("does not re-seal a document already sealed with the current key", async () => {
      await withRequest(() => saveApiToken(SERVER_TOKEN, KEY, NOW));
      const before = String(await getRedis().get(TOKEN_KEY));
      expect(await withRequest(() => loadApiTokenStatus(KEY))).toMatchObject({ needsReseal: false });
      await flushDeferred();
      expect(String(await getRedis().get(TOKEN_KEY))).toBe(before);
    });

    it("is unreadable when it opens with neither the current nor the previous key", async () => {
      const sealed = sealSecret(SERVER_TOKEN, OTHER_KEY, CONTEXT, keyFingerprint(OTHER_KEY));
      await getRedis().set(TOKEN_KEY, JSON.stringify({ ...sealed, updatedAt: NOW.getTime() }));
      expect(await withRequest(() => loadApiTokenStatus(KEY))).toEqual({
        state: "unreadable",
        updatedAt: NOW.getTime(),
      });
    });
  });
});

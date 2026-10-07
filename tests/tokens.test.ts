import { describe, expect, it } from "vitest";
import { getRedis, toStringRecord } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { flushDeferred } from "@/lib/request-context";
import { sha256Hex } from "@/lib/security";
import {
  authenticateToken,
  createToken,
  generatePlainToken,
  generateTokenId,
  hashToken,
  ID_PREFIX,
  LAST_USED_REFRESH_MS,
  labelProblem,
  listTokens,
  MAX_LABEL_LENGTH,
  MAX_TOKENS,
  pruneRevokedTokens,
  revokeToken,
  TOKEN_PREFIX,
} from "@/lib/tokens";
import { useRedis } from "./helpers/redis-fixture";
import { withRequest } from "./helpers/request";

/**
 * lib/tokens.ts: per-machine API tokens, an alternative to the shared
 * USAGE_API_TOKEN that can be individually revoked. Storage: `usage:tokens`
 * HASH, field = sha256(token), value = the token's own JSON (never the
 * plaintext, and never the token's own hash inside its value).
 */

describe("generatePlainToken / generateTokenId", () => {
  it("mints a token with the ur_ prefix and 256 bits of base64url entropy", () => {
    const token = generatePlainToken();
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    // base64url of 32 bytes is 43 characters, no padding.
    expect(token.slice(TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("mints an id with the tk_ prefix and 8 base32 characters", () => {
    const id = generateTokenId();
    expect(id.startsWith(ID_PREFIX)).toBe(true);
    expect(id.slice(ID_PREFIX.length)).toMatch(/^[A-Z2-7]{8}$/);
  });

  it("never repeats across many draws (statistically)", () => {
    const tokens = new Set(Array.from({ length: 200 }, generatePlainToken));
    const ids = new Set(Array.from({ length: 200 }, generateTokenId));
    expect(tokens.size).toBe(200);
    expect(ids.size).toBe(200);
  });
});

describe("labelProblem", () => {
  it("flags an empty or over-long label; accepts everything in between", () => {
    expect(labelProblem("")).toBe("empty");
    expect(labelProblem("a".repeat(MAX_LABEL_LENGTH + 1))).toBe("too_long");
    expect(labelProblem("a")).toBeNull();
    expect(labelProblem("a".repeat(MAX_LABEL_LENGTH))).toBeNull();
  });
});

describe("createToken / listTokens", () => {
  useRedis();

  it("stores only the hash: the plaintext never appears in the hash's value", async () => {
    const now = new Date("2026-09-26T00:00:00Z");
    const result = await createToken("Mac Studio", null, now);
    if (!result.ok) throw new Error("unreachable");

    expect(result.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(result.id.startsWith(ID_PREFIX)).toBe(true);

    const stored = toStringRecord(await getRedis().hgetall(KEYS.tokens));
    const raw = Object.values(stored);
    expect(raw).toHaveLength(1);
    expect(raw[0]).not.toContain(result.token);
    expect(Object.keys(stored)).toEqual([hashToken(result.token)]);

    const parsed = JSON.parse(raw[0]!) as Record<string, unknown>;
    expect(parsed).toEqual({
      id: result.id,
      label: "Mac Studio",
      machineId: null,
      scope: "ingest",
      createdAt: now.getTime(),
      lastUsedAt: null,
      revokedAt: null,
    });
  });

  it("keeps a machine binding when one is given", async () => {
    const result = await createToken("Desktop", "mac-studio", new Date());
    if (!result.ok) throw new Error("unreachable");
    const [token] = await listTokens();
    expect(token?.machineId).toBe("mac-studio");
  });

  it("lists newest first, and skips an entry that does not parse", async () => {
    const t1 = await createToken("first", null, new Date(1000));
    const t2 = await createToken("second", null, new Date(2000));
    if (!t1.ok || !t2.ok) throw new Error("unreachable");
    await getRedis().hset(KEYS.tokens, { garbage: "not json" });

    const tokens = await listTokens();
    expect(tokens.map((token) => token.label)).toEqual(["second", "first"]);
  });

  it("refuses a new token once MAX_TOKENS is reached", async () => {
    await getRedis().hset(
      KEYS.tokens,
      Object.fromEntries(
        Array.from({ length: MAX_TOKENS }, (_, i) => [
          `hash-${i}`,
          JSON.stringify({
            id: `tk_seed${i}`,
            label: `seed ${i}`,
            machineId: null,
            createdAt: 0,
            lastUsedAt: null,
            revokedAt: null,
          }),
        ]),
      ),
    );
    const result = await createToken("one too many", null, new Date());
    expect(result).toEqual({ ok: false, reason: "too_many" });
  });
});

describe("revokeToken", () => {
  useRedis();

  it("sets revokedAt, and is idempotent on a second call", async () => {
    const created = await createToken("laptop", null, new Date(0));
    if (!created.ok) throw new Error("unreachable");

    const now = new Date("2026-09-26T00:00:00Z");
    expect(await revokeToken(created.id, now)).toEqual({ ok: true });
    const [token] = await listTokens();
    expect(token?.revokedAt).toBe(now.getTime());

    // A second revoke of the same token is a no-op, not an error, and keeps the first timestamp.
    const later = new Date(now.getTime() + 60_000);
    expect(await revokeToken(created.id, later)).toEqual({ ok: true });
    const [stillFirst] = await listTokens();
    expect(stillFirst?.revokedAt).toBe(now.getTime());
  });

  it("answers not_found for an id nothing was ever issued with", async () => {
    expect(await revokeToken("tk_ghost001", new Date())).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("authenticateToken", () => {
  useRedis();

  it("accepts a live token, rejects an unknown one and a revoked one", async () => {
    const created = await createToken("laptop", null, new Date(0));
    if (!created.ok) throw new Error("unreachable");

    await withRequest(async () => {
      expect(await authenticateToken(created.token, new Date())).toEqual({
        ok: true,
        tokenId: created.id,
        machineId: null,
        scope: "ingest",
      });
    });

    expect(await authenticateToken("ur_not-a-real-token", new Date())).toEqual({ ok: false, reason: "not_found" });

    await revokeToken(created.id, new Date());
    expect(await authenticateToken(created.token, new Date())).toEqual({ ok: false, reason: "revoked" });
  });

  it("hands back the bound machineId when the token has one", async () => {
    const created = await createToken("desktop", "mac-studio", new Date(0));
    if (!created.ok) throw new Error("unreachable");
    await withRequest(async () => {
      expect(await authenticateToken(created.token, new Date())).toEqual({
        ok: true,
        tokenId: created.id,
        machineId: "mac-studio",
        scope: "ingest",
      });
    });
  });

  it("issues a read token unbound, even when a machine is passed", async () => {
    const created = await createToken("menu bar", "mac-studio", new Date(0), "read");
    if (!created.ok) throw new Error("unreachable");
    const [token] = await listTokens();
    expect(token).toMatchObject({ scope: "read", machineId: null });
  });

  it("reads an entry stored before scopes existed as an ingest token", async () => {
    await getRedis().hset(KEYS.tokens, {
      [hashToken("ur_legacy")]: JSON.stringify({ id: "tk_LEGACY01", label: "old", machineId: null, createdAt: 1 }),
    });
    const [token] = await listTokens();
    expect(token?.scope).toBe("ingest");
  });

  it("refreshes lastUsedAt at most once an hour", async () => {
    const created = await createToken("laptop", null, new Date(0));
    if (!created.ok) throw new Error("unreachable");

    const first = new Date(1_000_000);
    await withRequest(() => authenticateToken(created.token, first));
    await flushDeferred();
    expect((await listTokens())[0]?.lastUsedAt).toBe(first.getTime());

    // Well inside the hour: no write.
    const soonAfter = new Date(first.getTime() + 5_000);
    await withRequest(() => authenticateToken(created.token, soonAfter));
    await flushDeferred();
    expect((await listTokens())[0]?.lastUsedAt).toBe(first.getTime());

    // Past the refresh interval: writes again.
    const muchLater = new Date(first.getTime() + LAST_USED_REFRESH_MS + 1);
    await withRequest(() => authenticateToken(created.token, muchLater));
    await flushDeferred();
    expect((await listTokens())[0]?.lastUsedAt).toBe(muchLater.getTime());
  });
});

describe("pruneRevokedTokens", () => {
  useRedis();

  it("removes only tokens revoked past the retention window, keeping live ones and recent revocations", async () => {
    const now = new Date("2026-09-26T00:00:00Z");
    const day = 86_400_000;

    const live = await createToken("live", null, new Date(0));
    const revokedRecently = await createToken("recent", null, new Date(0));
    const revokedLongAgo = await createToken("old", null, new Date(0));
    if (!live.ok || !revokedRecently.ok || !revokedLongAgo.ok) throw new Error("unreachable");

    await revokeToken(revokedRecently.id, new Date(now.getTime() - 5 * day));
    await revokeToken(revokedLongAgo.id, new Date(now.getTime() - 100 * day));

    const result = await pruneRevokedTokens(now);
    expect(result).toEqual({ removed: 1, ids: [revokedLongAgo.id] });

    const remaining = (await listTokens()).map((token) => token.id).sort();
    expect(remaining).toEqual([live.id, revokedRecently.id].sort());
  });

  it("dryRun reports what would be removed without deleting anything", async () => {
    const now = new Date("2026-09-26T00:00:00Z");
    const day = 86_400_000;
    const created = await createToken("old", null, new Date(0));
    if (!created.ok) throw new Error("unreachable");
    await revokeToken(created.id, new Date(now.getTime() - 100 * day));

    const result = await pruneRevokedTokens(now, { dryRun: true });
    expect(result).toEqual({ removed: 1, ids: [created.id] });
    expect(await listTokens()).toHaveLength(1);
  });

  it("respects a custom retentionDays", async () => {
    const now = new Date("2026-09-26T00:00:00Z");
    const day = 86_400_000;
    const created = await createToken("old", null, new Date(0));
    if (!created.ok) throw new Error("unreachable");
    await revokeToken(created.id, new Date(now.getTime() - 20 * day));

    expect(await pruneRevokedTokens(now, { retentionDays: 30 })).toEqual({ removed: 0, ids: [] });
    expect(await pruneRevokedTokens(now, { retentionDays: 10 })).toEqual({ removed: 1, ids: [created.id] });
  });
});

describe("hashToken", () => {
  it("is sha256Hex of the plaintext", () => {
    expect(hashToken("abc")).toBe(sha256Hex("abc"));
  });
});

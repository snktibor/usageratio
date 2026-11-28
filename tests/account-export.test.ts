import { describe, expect, it } from "vitest";
import { acceptsGzip, accountExportFilename, exportWorkspaceKeys, tenantKeyType } from "@/lib/account-export";
import { getRedis, toStringRecord } from "@/lib/redis";
import { fixedTenantKeys, GLOBAL_KEYS, tenantKeys } from "@/lib/redis-keys";
import { forgetSignupCodeUser } from "@/lib/signup-codes";
import { tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { useRedis } from "./helpers/redis-fixture";

/** The account export's pieces that the route test does not reach (tests/integration/account-export.test.ts). */

const TENANT = "AAAAAAAAAAAAAAAAAAAAAA" as TenantId;

describe("tenantKeyType", () => {
  const keys = tenantKeys(TENANT);
  it("knows every fixed key, every dynamic key, and nothing else", () => {
    expect(tenantKeyType(keys, keys.settings)).toBe("string");
    expect(tenantKeyType(keys, keys.tokensAudit)).toBe("list");
    expect(tenantKeyType(keys, keys.trash)).toBe("zset");
    expect(tenantKeyType(keys, keys.events("claude", "Work"))).toBe("zset");
    expect(tenantKeyType(keys, keys.history("claude"))).toBe("zset");
    expect(tenantKeyType(keys, keys.allTime("claude"))).toBe("hash");
    expect(tenantKeyType(keys, keys.alert("claude", 1, 80))).toBe("string");
    expect(tenantKeyType(keys, keys.trashEntry("x"))).toBe("string");
    expect(tenantKeyType(keys, keys.trashEvents("x", "claude", "Work"))).toBe("zset");
    expect(tenantKeyType(keys, keys.registry)).toBeNull();
    expect(tenantKeyType(keys, `${keys.prefix}something-new`)).toBeNull();
    expect(tenantKeyType(keys, tenantKeys("BBBBBBBBBBBBBBBBBBBBBB" as TenantId).events("claude", "Work"))).toBeNull();
  });

  it("has a type for every fixed key but the registry, so an export never drops one", () => {
    const untyped = fixedTenantKeys(keys).filter((key) => tenantKeyType(keys, key) === null);
    expect(untyped).toEqual([keys.registry]);
  });
});

describe("acceptsGzip", () => {
  it("reads Accept-Encoding, including q=0 and the wildcard", () => {
    expect(acceptsGzip(null)).toBe(false);
    expect(acceptsGzip("")).toBe(false);
    expect(acceptsGzip("br")).toBe(false);
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("GZIP;q=0.5")).toBe(true);
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("*")).toBe(true);
    expect(acceptsGzip("identity, *;q=0")).toBe(false);
  });
});

describe("accountExportFilename", () => {
  it("names the login only when it is a plain GitHub login", () => {
    const now = new Date("2026-11-25T10:00:00Z");
    expect(accountExportFilename("alice-1", now)).toBe("usageratio-export-alice-1-2026-11-25.json");
    expect(accountExportFilename('a"b', now)).toBe("usageratio-export-2026-11-25.json");
    expect(accountExportFilename("", now)).toBe("usageratio-export-2026-11-25.json");
  });
});

describe("exporting a workspace's keys", () => {
  useRedis();
  it("names a token hash it has no record for, and leaves a plain text value as it is", async () => {
    const store = tenantStore(TENANT);
    await getRedis().hset(store.keys.tokensLastUsed, { ["f".repeat(64)]: "1700000000000" });
    await getRedis().set(store.keys.housekeepingLast, "not json");
    await getRedis().set(store.keys.settings, JSON.stringify({ v: 1 }));
    expect(await exportWorkspaceKeys(store)).toEqual({
      "housekeeping:last": "not json",
      settings: { v: 1 },
      "tokens:lastused": { "unknown-1": 1700000000000 },
    });
  });
});

describe("forgetSignupCodeUser", () => {
  useRedis();
  it("drops the user from the codes they used, and leaves the rest alone", async () => {
    await getRedis().hset(GLOBAL_KEYS.signupCodes, {
      sc_one: JSON.stringify({ hash: "h1", createdAt: 1, usedAt: 2, usedBy: "u_alice" }),
      sc_two: JSON.stringify({ hash: "h2", createdAt: 1, usedAt: 3, usedBy: "u_bob" }),
      sc_bad: "{not json",
    });
    expect(await forgetSignupCodeUser("u_alice")).toBe(1);
    expect(await forgetSignupCodeUser("u_nobody")).toBe(0);
    const stored = toStringRecord(await getRedis().hgetall(GLOBAL_KEYS.signupCodes));
    expect(JSON.parse(stored.sc_one!)).toEqual({ hash: "h1", createdAt: 1, usedAt: 2 });
    expect(JSON.parse(stored.sc_two!)).toMatchObject({ usedBy: "u_bob" });
    expect(stored.sc_bad).toBe("{not json");
  });
});

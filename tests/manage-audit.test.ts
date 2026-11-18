import { describe, expect, it } from "vitest";
import { AUDIT_LIMIT } from "@/lib/api-token";
import {
  loadManageAudit,
  MANAGE_ACTIONS,
  type ManageAuditRecord,
  manageAudit,
  parseManageAuditRecord,
  queueManageAudit,
  serializeManageAuditRecord,
  toManageAuditEntry,
} from "@/lib/manage-audit";
import { getRedis } from "@/lib/redis";
import { findOrCreateGithubUser } from "@/lib/users";
import { useRedis } from "./helpers/redis-fixture";
import { withRequest } from "./helpers/request";
import { KEYS, tenant } from "./helpers/tenant";

const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const FULL: ManageAuditRecord = {
  at: 1_758_000_000_000,
  action: "machine_merged",
  userAgent: CHROME_UA,
  brands: '"Chromium";v="140", "Google Chrome";v="140"',
  platform: '"macOS"',
  ip: null,
  ipHash: "3fa9c1a2b91c",
  ipPrefix: "203.0.113.0/24",
  session: "1a2b3c4d",
  subject: { kind: "machine", id: "mac", providerId: "claude", target: "laptop" },
  affected: { events: 12, machines: 2, groups: 1 },
  trashId: "t1",
  rederived: 2,
  by: "octocat",
};

const MINIMAL: ManageAuditRecord = {
  at: 5,
  action: "restart_recorded",
  userAgent: "",
  brands: "",
  platform: "",
  ip: null,
  ipHash: null,
  ipPrefix: null,
  session: null,
  subject: { kind: "provider", id: "openai" },
  affected: null,
  trashId: null,
  by: null,
};

describe("the manage audit record", () => {
  it("round-trips with every optional field", () => {
    expect(parseManageAuditRecord(serializeManageAuditRecord(FULL))).toEqual(FULL);
  });

  it("round-trips without the optional fields, and leaves them out of the stored JSON", () => {
    const json = serializeManageAuditRecord(MINIMAL);
    expect(parseManageAuditRecord(json)).toEqual(MINIMAL);
    expect(Object.keys(JSON.parse(json))).toEqual(["at", "a", "ua", "ch", "pf", "s", "k", "id"]);
  });

  it("stores the raw address only when there is one", () => {
    const raw = { ...MINIMAL, ip: "203.0.113.9" };
    expect(JSON.parse(serializeManageAuditRecord(raw)).ip).toBe("203.0.113.9");
    expect(parseManageAuditRecord(serializeManageAuditRecord(raw))).toEqual(raw);
  });

  it("knows every action it can serialize", () => {
    for (const action of MANAGE_ACTIONS) {
      expect(parseManageAuditRecord(serializeManageAuditRecord({ ...MINIMAL, action }))?.action).toBe(action);
    }
  });

  it.each([
    ["bad JSON", "{"],
    ["a non-object", "[1]"],
    ["null", "null"],
    ["a missing at", JSON.stringify({ a: "group_deleted", k: "group", id: "g" })],
    ["a non-finite at", '{"at":null,"a":"group_deleted","k":"group","id":"g"}'],
    ["an unknown action", JSON.stringify({ at: 1, a: "trash_emptied", k: "group", id: "g" })],
    ["a token action", JSON.stringify({ at: 1, a: "token_created", k: "group", id: "g" })],
    ["an unknown subject kind", JSON.stringify({ at: 1, a: "group_deleted", k: "tenant", id: "g" })],
    ["a missing subject id", JSON.stringify({ at: 1, a: "group_deleted", k: "group" })],
  ])("rejects %s", (_name, raw) => {
    expect(parseManageAuditRecord(raw)).toBeNull();
  });

  it("reads a damaged count as none, and tolerates missing request fields", () => {
    const base = { at: 1, a: "group_deleted", k: "group", id: "g" };
    expect(parseManageAuditRecord(JSON.stringify({ ...base, n: { e: 1, m: "x", g: 0 } }))?.affected).toBeNull();
    expect(parseManageAuditRecord(JSON.stringify({ ...base, n: [1] }))?.affected).toBeNull();
    expect(parseManageAuditRecord(JSON.stringify(base))).toMatchObject({ userAgent: "", ip: null, session: null });
    // A restore's count of rewritten summaries: kept when it is a number, dropped when it is not.
    expect(parseManageAuditRecord(JSON.stringify({ ...base, rc: 3 }))?.rederived).toBe(3);
    expect(parseManageAuditRecord(JSON.stringify({ ...base, rc: "3" }))).not.toHaveProperty("rederived");
  });
});

describe("toManageAuditEntry", () => {
  it("names the browser and shows the hashed address with its prefix", () => {
    expect(toManageAuditEntry(FULL)).toMatchObject({
      browser: "Chrome 140",
      os: "macOS",
      ip: "203.0.113.0/24 · 3fa9c1a2b91c",
      subject: FULL.subject,
      affected: FULL.affected,
      trashId: "t1",
      by: "octocat",
      session: "1a2b3c4d",
    });
  });

  it("shows a raw address as it is, and an absent one as unknown", () => {
    expect(toManageAuditEntry({ ...FULL, ip: "203.0.113.9", ipHash: null, ipPrefix: null }).ip).toBe("203.0.113.9");
    expect(toManageAuditEntry(MINIMAL)).toMatchObject({ ip: "unknown", browser: null, os: null });
  });
});

describe("queueManageAudit and loadManageAudit", () => {
  useRedis();

  it("caps the list at AUDIT_LIMIT, newest first", async () => {
    for (let i = 0; i < AUDIT_LIMIT + 1; i++) {
      const tx = tenant.redis.multi();
      queueManageAudit(tx, tenant, serializeManageAuditRecord({ ...MINIMAL, at: i + 1 }));
      await tx.exec();
    }
    expect(await getRedis().llen(KEYS.manageAudit)).toBe(AUDIT_LIMIT);
    const entries = await loadManageAudit(tenant);
    expect(entries).toHaveLength(AUDIT_LIMIT);
    expect(entries[0]!.at).toBe(AUDIT_LIMIT + 1);
    expect(entries.at(-1)!.at).toBe(2);
  });

  it("leaves out an entry that does not parse", async () => {
    await getRedis().lpush(KEYS.manageAudit, serializeManageAuditRecord(MINIMAL), "not json");
    expect(await loadManageAudit(tenant)).toHaveLength(1);
  });
});

describe("manageAudit", () => {
  useRedis();
  const now = new Date("2026-11-18T10:00:00Z");
  const headers = { "user-agent": CHROME_UA, "x-forwarded-for": "203.0.113.9" };

  it("builds the request's fields once and adds each change's own", async () => {
    const write = manageAudit({ userId: null }, now);
    const [first, second] = await withRequest(
      async () => [
        await write({
          action: "group_deleted",
          subject: { kind: "group", id: "Work" },
          affected: { events: 3, machines: 1, groups: 1 },
        }),
        await write({
          action: "trash_restored",
          subject: { kind: "group", id: "Work" },
          trashId: "tr1",
          rederived: 2,
        }),
      ],
      { headers },
    );
    const one = parseManageAuditRecord(first!)!;
    const two = parseManageAuditRecord(second!)!;
    expect(one).toMatchObject({
      at: now.getTime(),
      action: "group_deleted",
      by: null,
      affected: { events: 3, machines: 1, groups: 1 },
    });
    expect(one.userAgent).toBe(CHROME_UA);
    expect(one.ipPrefix).toBe("203.0.113.0/24");
    expect(two).toMatchObject({ action: "trash_restored", affected: null, trashId: "tr1", rederived: 2 });
    expect(two.ipHash).toBe(one.ipHash);
  });

  it("names the signed-in user in multi-tenant mode, and nobody for an unknown one", async () => {
    const user = await findOrCreateGithubUser({ id: 42, login: "octocat" }, now);
    const known = await withRequest(
      () => manageAudit({ userId: user.userId }, now)({ action: "group_deleted", subject: { kind: "group", id: "g" } }),
      { headers },
    );
    expect(parseManageAuditRecord(known)?.by).toBe("octocat");
    const unknown = await withRequest(
      () =>
        manageAudit(
          { userId: `u_${"x".repeat(22)}` },
          now,
        )({ action: "group_deleted", subject: { kind: "group", id: "g" } }),
      { headers },
    );
    expect(parseManageAuditRecord(unknown)?.by).toBeNull();
  });
});

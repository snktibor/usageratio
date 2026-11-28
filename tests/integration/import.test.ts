import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as importRoute } from "@/app/api/import/route";
import { GET as getMachines } from "@/app/api/machines/route";
import { buildAccountExport } from "@/lib/account-export";
import {
  IMPORT_MAX_INFLATED_BYTES,
  importIntoEmptyStore,
  planImport,
  workspaceIsEmpty as workspaceEmpty,
} from "@/lib/account-import";
import { WORKSPACE_QUOTAS } from "@/lib/config";
import { HISTORY_RETENTION } from "@/lib/history";
import { ingestReport } from "@/lib/ingest";
import { addMember, ownedWorkspaceCount } from "@/lib/members";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { sha256Hex } from "@/lib/security";
import { defaultTenantStore, type TenantStore, tenantStore } from "@/lib/tenant";
import { deleteTenant } from "@/lib/tenant-deletion";
import type { TenantId } from "@/lib/tenant-id";
import { archiveCycle, saveOfficialUsage } from "@/lib/usage-store";
import { startUserSession } from "@/lib/user-session";
import { createTenantFor, findOrCreateGithubUser } from "@/lib/users";
import { REAL_REDIS, useRedis } from "../helpers/redis-fixture";
import { withRequest } from "../helpers/request";
import { seedSession } from "../helpers/session";

/**
 * POST /api/import: an export loaded back. In multi-tenant mode into a new
 * workspace of the user's, whose usage then matches the exported one key for
 * key; on a single-user instance into the instance, while it is empty. And
 * what it refuses: a damaged or foreign file, a key it cannot validate, more
 * than the quotas allow, and an encoding it does not know.
 */

const DAY = 86_400_000;
const PIN = "24680";
const IMPORTED = ["settings", "providers", "groups", "machines", "official"];

function post(body: unknown, init: { cookie?: string; gzip?: boolean; encoding?: string } = {}): Request {
  const text = JSON.stringify(body);
  return new Request("http://localhost/api/import", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      host: "localhost",
      "x-forwarded-for": "203.0.113.5",
      "content-type": "application/json",
      ...(init.cookie && { cookie: init.cookie }),
      ...(init.gzip && { "content-encoding": "gzip" }),
      ...(init.encoding && { "content-encoding": init.encoding }),
    },
    body: init.gzip ? gzipSync(text) : text,
  });
}

function filed(keys: Record<string, unknown>, name = "Home") {
  return { format: "usageratio-account-export", version: 1, workspace: { name, keys } };
}

async function fill(store: TenantStore, now: Date): Promise<void> {
  for (const [machineId, groupId] of [
    ["laptop", "Work"],
    ["desk", "Home"],
  ] as const) {
    const report = { machineId, groupId, providers: { claude: 100, openai: 5 }, timestamp: now.toISOString() };
    if (!(await ingestReport(store, report, now)).ok) throw new Error("report refused");
  }
  for (let i = 1; i <= 3; i++) {
    await archiveCycle(store, "claude", {
      v: 1,
      start: now.getTime() - (i + 1) * 7 * DAY,
      end: now.getTime() - i * 7 * DAY,
      total: 1000 * i,
      limit: null,
      official: 10 * i,
      groups: { Work: 1000 * i },
      machines: 1,
      models: {},
      subLimits: {},
      archivedAt: now.getTime(),
    });
  }
  await saveOfficialUsage(store, { providerId: "claude", subLimitId: null, raw: "40", cycleStartMs: 0 }, now);
  await getRedis().set(
    store.keys.settings,
    JSON.stringify({ v: 1, period: "weekly", alerts: { webhookUrl: "https://hooks.example.com/x", thresholds: [80] } }),
  );
}

async function person(githubId: number, login: string) {
  const now = new Date();
  const { userId } = await findOrCreateGithubUser({ id: githubId, login }, now);
  const tenantId = await createTenantFor(userId, `${login}'s`, now);
  const cookie = (await withRequest(() => startUserSession(userId, tenantId, now))).split(";")[0]!;
  return { userId, tenantId, cookie };
}

/** The workspace's own keys as an export shows them. */
async function exportedKeys(userId: string, tenantId: TenantId): Promise<Record<string, unknown>> {
  const document = await buildAccountExport(userId, new Date());
  return document!.workspaces.find((workspace) => workspace.tenantId === tenantId)!.data!.keys;
}

describe.skipIf(REAL_REDIS)("POST /api/import, multi-tenant mode", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("REGISTRATION", "invite"));
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a user who owns no workspace unless registration is open", async () => {
    const alice = await person(1, "alice");
    const now = new Date();
    // Bob came in through an invite: a member of alice's workspace, with none of his own.
    const { userId } = await findOrCreateGithubUser({ id: 2, login: "bob" }, now);
    await addMember(alice.tenantId, userId, alice.userId, now);
    const cookie = (await withRequest(() => startUserSession(userId, alice.tenantId, now))).split(";")[0]!;
    const empty = filed({}, "x");

    const refused = await importRoute(post(empty, { cookie }));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("registration_closed");
    expect(await ownedWorkspaceCount(userId)).toBe(0);

    vi.stubEnv("REGISTRATION", "open");
    expect((await importRoute(post(empty, { cookie }))).status).toBe(201);
    expect(await ownedWorkspaceCount(userId)).toBe(1);
  });

  it("loads an export into a new workspace whose usage matches the exported one", async () => {
    const alice = await person(1, "alice");
    const now = new Date();
    await fill(tenantStore(alice.tenantId), now);
    const original = await exportedKeys(alice.userId, alice.tenantId);

    const response = await importRoute(post(filed(original, "alice's"), { cookie: alice.cookie, gzip: true }));
    expect(response.status).toBe(201);
    const body = (await response.json()) as { tenantId: TenantId; imported: Record<string, number>; skipped: string[] };
    expect(body.imported).toEqual({ providers: 2, groups: 2, machines: 2, reports: 4, cycles: 3 });
    expect(body.skipped).toEqual(expect.arrayContaining(["tokens:audit"].filter((key) => key in original)));
    expect(body.tenantId).not.toBe(alice.tenantId);

    const copy = await exportedKeys(alice.userId, body.tenantId);
    const usage = (keys: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(keys).filter(([name]) => IMPORTED.includes(name) || /^(events|history|alltime):/.test(name)),
      );
    const { settings: copiedSettings, ...copiedRest } = usage(copy);
    const { settings: originalSettings, ...originalRest } = usage(original);
    expect(copiedRest).toEqual(originalRest);
    expect(copiedSettings).toEqual({
      ...(originalSettings as object),
      alerts: { webhookUrl: null, thresholds: [80] },
    });

    // The new workspace is a workspace like any other: named, owned by Alice, and its machines show.
    const record = JSON.parse(String(await getRedis().get(GLOBAL_KEYS.tenantRecord(body.tenantId))));
    expect(record.name).toBe("alice's (import)");
    const header = await withRequest(() => startUserSession(alice.userId, body.tenantId, new Date()));
    const machines = (await (
      await getMachines(new Request("http://localhost/api/machines", { headers: { cookie: header.split(";")[0]! } }))
    ).json()) as { machines: { machineId: string }[] };
    expect([...new Set(machines.machines.map((machine) => machine.machineId))].sort()).toEqual(["desk", "laptop"]);

    // Its registry lists what was written: deleting it leaves nothing.
    await deleteTenant(body.tenantId, new Date());
    const prefix = tenantStore(body.tenantId).keys.prefix;
    expect(
      getMemoryStoreForTests()!
        .keys()
        .filter((key) => key.startsWith(prefix)),
    ).toEqual([]);
  });

  it("drops reports past the retention window and keeps the newest cycles only", async () => {
    const alice = await person(1, "alice");
    const now = Date.now();
    const event = (ts: number) => ({ member: { m: "laptop", t: 1, ts }, score: ts });
    const summary = (i: number) => ({
      member: {
        v: 1,
        start: i * DAY,
        end: (i + 1) * DAY,
        total: i,
        limit: null,
        official: null,
        groups: {},
        machines: 1,
        models: {},
        subLimits: {},
        archivedAt: 1,
      },
      score: i * DAY,
    });
    const keys = {
      "events:claude:Work": [event(now - 100 * DAY), event(now - DAY)],
      "history:claude": Array.from({ length: HISTORY_RETENTION + 5 }, (_, i) => summary(i + 1)),
    };
    const response = await importRoute(post(filed(keys), { cookie: alice.cookie }));
    expect(response.status).toBe(201);
    const { tenantId } = (await response.json()) as { tenantId: TenantId };
    const store = tenantStore(tenantId);
    expect(await getRedis().zcard(store.keys.events("claude", "Work"))).toBe(1);
    expect(await getRedis().zcard(store.keys.history("claude"))).toBe(HISTORY_RETENTION);
    expect(getMemoryStoreForTests()!.dump()[store.keys.events("claude", "Work")]!.ttl).toBeGreaterThan(70 * 86_400);
  });

  it("refuses a file that is not an export, a key it cannot validate, and a damaged value", async () => {
    const alice = await person(1, "alice");
    const refused = async (body: unknown) => {
      const response = await importRoute(post(body, { cookie: alice.cookie }));
      return { status: response.status, body: (await response.json()) as { error: string; details?: string[] } };
    };
    expect((await refused({ format: "something-else", version: 1, workspace: { name: "x", keys: {} } })).status).toBe(
      400,
    );
    expect((await refused(filed({}, "   "))).body.details).toEqual(["workspace.name must be 1-64 characters"]);
    expect((await refused(filed({ machines: { "claude:laptop": { nope: 1 } } }))).status).toBe(400);
    expect((await refused(filed({ providers: { "Not A Provider": 1 } }))).status).toBe(400);
    expect((await refused(filed({ "events:claude:Work": [{ member: { m: "x" }, score: 1 }] }))).status).toBe(400);
    expect((await refused(filed({ "history:claude": "not a list" }))).status).toBe(400);
    expect((await refused(filed({ settings: "not an object" }))).status).toBe(400);

    // A name that is not one of the importable keys is skipped, never written as given.
    const sneaky = await importRoute(
      post(filed({ "../usage:tenant:x": { a: "1" }, "events:claude:Work:extra": [], "api-token": "x" }), {
        cookie: alice.cookie,
      }),
    );
    expect(sneaky.status).toBe(201);
    expect(((await sneaky.json()) as { skipped: string[] }).skipped).toEqual([
      "../usage:tenant:x",
      "api-token",
      "events:claude:Work:extra",
    ]);
    // Random workspace ids are in key names too, so look for the exact names the file tried.
    const keys = getMemoryStoreForTests()!.keys();
    expect(
      keys.filter((key) => key.includes("..") || key.endsWith(":usage:tenant:x") || key.endsWith(":extra")),
    ).toEqual([]);
  });

  it("holds the quotas: providers, and the workspaces one person owns", async () => {
    const alice = await person(1, "alice");
    const providers = Object.fromEntries(
      Array.from({ length: WORKSPACE_QUOTAS.providers + 1 }, (_, i) => [`p${i}`, 1]),
    );
    const tooMany = await importRoute(post(filed({ providers }), { cookie: alice.cookie }));
    expect(tooMany.status).toBe(422);
    expect(await tooMany.json()).toMatchObject({ error: "too_many_providers", limit: WORKSPACE_QUOTAS.providers });

    for (let i = 1; i < WORKSPACE_QUOTAS.ownedWorkspaces; i++) {
      expect((await importRoute(post(filed({}), { cookie: alice.cookie }))).status).toBe(201);
    }
    const full = await importRoute(post(filed({}), { cookie: alice.cookie }));
    expect(full.status).toBe(422);
    expect(((await full.json()) as { error: string }).error).toBe("too_many_workspaces");
  });

  it("refuses an encoding other than gzip, a body that inflates past the cap, and no session", async () => {
    const alice = await person(1, "alice");
    expect((await importRoute(post(filed({}), { cookie: alice.cookie, encoding: "br" }))).status).toBe(415);
    const huge = filed({ settings: { pad: "x".repeat(IMPORT_MAX_INFLATED_BYTES) } });
    expect((await importRoute(post(huge, { cookie: alice.cookie, gzip: true }))).status).toBe(413);
    expect((await importRoute(post(filed({})))).status).toBe(401);
  });
});

describe.skipIf(REAL_REDIS)("POST /api/import, single-user instance", () => {
  useRedis();
  beforeEach(() => {
    vi.stubEnv("REGISTRATION", "closed");
    vi.stubEnv("DASHBOARD_PIN", PIN);
  });
  afterEach(() => vi.unstubAllEnvs());

  async function sudoSession(): Promise<string> {
    const cookie = await seedSession(PIN);
    await getRedis().set(`${GLOBAL_KEYS.pinSession(sha256Hex(`${cookie.split("=")[1]}:${PIN}`))}:sudo`, "1", {
      ex: 300,
    });
    return cookie;
  }

  it("loads into the instance while it is empty, behind sudo", async () => {
    const now = new Date();
    const source = tenantStore("AAAAAAAAAAAAAAAAAAAAAA" as TenantId);
    await fill(source, now);
    const { exportWorkspaceKeys } = await import("@/lib/account-export");
    const keys = await exportWorkspaceKeys(source);

    const plain = await seedSession(PIN);
    expect((await importRoute(post(filed(keys), { cookie: plain }))).status).toBe(403);

    const cookie = await sudoSession();
    const response = await importRoute(post(filed(keys), { cookie }));
    expect(response.status).toBe(201);
    expect(((await response.json()) as { tenantId: string }).tenantId).toBe("default");
    const store = defaultTenantStore();
    expect(await getRedis().hlen(store.keys.machines)).toBe(4);

    const again = await importRoute(post(filed(keys), { cookie }));
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("workspace_not_empty");
  });

  it("undoes a write that fails partway, so the import can be tried again", async () => {
    const now = new Date();
    const source = tenantStore("AAAAAAAAAAAAAAAAAAAAAA" as TenantId);
    await fill(source, now);
    const { exportWorkspaceKeys } = await import("@/lib/account-export");
    const planned = planImport(filed(await exportWorkspaceKeys(source)), now, WORKSPACE_QUOTAS, "entries");
    if (!planned.ok) throw new Error("plan refused");

    const store = defaultTenantStore();
    const before = JSON.stringify({ v: 1, period: "monthly" });
    await getRedis().set(store.keys.settings, before);
    const redis = getRedis();
    const multi = redis.multi.bind(redis);
    // The first transaction lands, then the connection drops: a partial write.
    vi.spyOn(redis, "multi").mockImplementationOnce(() => {
      const tx = multi();
      const exec = tx.exec.bind(tx);
      tx.exec = (async () => {
        await exec();
        throw new Error("connection reset");
      }) as typeof tx.exec;
      return tx;
    });
    await expect(importIntoEmptyStore(store, planned.plan)).rejects.toThrow("connection reset");
    vi.restoreAllMocks();

    expect(await getRedis().get(store.keys.settings)).toBe(before);
    expect(await getRedis().hlen(store.keys.machines)).toBe(0);
    expect(await getRedis().scard(store.keys.registry)).toBe(0);
    expect(await getRedis().hlen(store.keys.officialUsage)).toBe(0);
    expect(await workspaceEmpty(store)).toBe(true);
  });
});

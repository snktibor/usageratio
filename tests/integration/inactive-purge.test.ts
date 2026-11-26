import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordTenantActivity } from "@/lib/activity";
import { INACTIVE_ACCOUNT_DAYS } from "@/lib/config";
import { runScheduledHousekeeping } from "@/lib/housekeeping";
import { ingestReport } from "@/lib/ingest";
import { addMember } from "@/lib/members";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { flushDeferred } from "@/lib/request-context";
import { tenantStore } from "@/lib/tenant";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";
import { setTenantStatus } from "@/lib/tenants";
import { authenticateToken, createToken } from "@/lib/tokens";
import { saveOfficialUsage } from "@/lib/usage-store";
import { currentUserSession, startUserSession } from "@/lib/user-session";
import { addOwner, createTenantFor, findOrCreateGithubUser, loadUser } from "@/lib/users";
import { REAL_REDIS, useRedis } from "../helpers/redis-fixture";
import { fakeCookieJar, withRequest } from "../helpers/request";

/** Runs between the purge loading its plan and carrying it out: a request racing the cron run. */
let afterPlanLoad: (() => Promise<unknown>) | null = null;
vi.mock("@/lib/tenants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tenants")>();
  return {
    ...actual,
    // The housekeeping order calls it inside lib/tenants.ts, unhooked; lib/inactive-purge.ts gets this one.
    listTenantIds: async () => {
      const ids = await actual.listTenantIds();
      await afterPlanLoad?.();
      return ids;
    },
  };
});

/**
 * The 12-month purge of inactive workspaces and accounts (lib/inactive-purge.ts), run by the
 * daily housekeeping. Time is passed in explicitly: `T0` is when tracking begins (the first cron
 * run of the build), and every run is a whole number of days after it.
 */

const DAY = 86_400_000;
const T0 = Date.parse("2027-01-04T03:00:00Z");
const at = (days: number) => new Date(T0 + days * DAY);
const LIMIT = INACTIVE_ACCOUNT_DAYS;

let nextGithubId = 1000;
async function user(login: string, days = 0): Promise<string> {
  return (await findOrCreateGithubUser({ id: nextGithubId++, login }, at(days))).userId;
}
async function signIn(userId: string, days: number): Promise<void> {
  const record = await loadUser(userId);
  const githubId = Number(String(await getRedis().smembers(GLOBAL_KEYS.userIdentities(userId))).split(":")[1]);
  await findOrCreateGithubUser({ id: githubId, login: record!.login }, at(days));
}
/** A client request with one of the workspace's tokens, on `days`. */
async function clientRequest(tenantId: TenantId, days: number): Promise<void> {
  const store = tenantStore(tenantId);
  const created = await createToken(store, "pc", null, at(days));
  if (!created.ok) throw new Error("token");
  expect((await authenticateToken(store, created.token, at(days))).ok).toBe(true);
  await flushDeferred();
}
async function purge(days: number, dryRun = false) {
  return (await runScheduledHousekeeping(at(days), { dryRun })).inactive;
}
const exists = async (key: string) => Number(await getRedis().exists(key)) === 1;
const tenantExists = (tenantId: TenantId) => exists(GLOBAL_KEYS.tenantRecord(tenantId));
const userExists = (userId: string) => exists(GLOBAL_KEYS.user(userId));
const memberOf = async (tenantId: TenantId, userId: string) =>
  Number(await getRedis().hexists(GLOBAL_KEYS.tenantMembers(tenantId), userId)) === 1;

describe.skipIf(REAL_REDIS)("the inactive-account purge", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("REGISTRATION", "invite"));
  afterEach(() => vi.unstubAllEnvs());

  it("keeps a workspace and its owner one day inside the limit, and deletes them one day past it", async () => {
    await purge(0);
    const alice = await user("alice");
    const tenant = await createTenantFor(alice, "Alice's", at(0));

    expect(await purge(LIMIT - 1)).toEqual({ tenantsDeleted: 0, usersDeleted: 0, skipped: 0, pending: 0 });
    expect(await tenantExists(tenant)).toBe(true);
    expect(await userExists(alice)).toBe(true);

    expect(await purge(LIMIT + 1)).toEqual({ tenantsDeleted: 1, usersDeleted: 1, skipped: 0, pending: 0 });
    expect(await tenantExists(tenant)).toBe(false);
    expect(await userExists(alice)).toBe(false);
  });

  it("counts a sign-in as activity", async () => {
    await purge(0);
    const alice = await user("alice");
    const tenant = await createTenantFor(alice, "Alice's", at(0));
    await signIn(alice, 200);

    await purge(LIMIT + 1);
    expect(await userExists(alice)).toBe(true);
    expect(await tenantExists(tenant)).toBe(true);
    await purge(200 + LIMIT + 1);
    expect(await userExists(alice)).toBe(false);
    expect(await tenantExists(tenant)).toBe(false);
  });

  it("counts a live session's first request of a UTC day as activity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(at(0));
      await purge(0);
      const alice = await user("alice");
      const [pair] = (await withRequest(() => startUserSession(alice, null, at(0)))).split(";");
      const [name, value] = pair!.split("=");
      const visit = async (ms: number) => {
        vi.setSystemTime(ms);
        expect(
          (await withRequest(() => currentUserSession(), { cookies: fakeCookieJar({ [name!]: value! }) }))?.userId,
        ).toBe(alice);
        await flushDeferred();
        return Number(await getRedis().zscore(GLOBAL_KEYS.users, alice));
      };
      // Two hours later, the same UTC day: the session is refreshed, the marker is not.
      expect(await visit(at(0).getTime() + 2 * 3_600_000)).toBe(at(0).getTime());
      expect(await visit(at(1).getTime())).toBe(at(1).getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs a purge that fails, and still answers with the housekeeping result", async () => {
    getMemoryStoreForTests()!.failNext("SCAN");
    const { tenants, inactive } = await runScheduledHousekeeping(at(0), { dryRun: false });
    expect(tenants.processed).toBe(1);
    expect(inactive).toBeNull();
    expect(await exists(GLOBAL_KEYS.activitySince)).toBe(false);
  });

  it("keeps an owner who never signs in while their machines report, and their workspace", async () => {
    await purge(0);
    const alice = await user("alice");
    const tenant = await createTenantFor(alice, "Alice's", at(0));
    await clientRequest(tenant, 300);

    await purge(LIMIT + 1);
    expect(await tenantExists(tenant)).toBe(true);
    expect(await userExists(alice)).toBe(true);
    await purge(300 + LIMIT + 1);
    expect(await tenantExists(tenant)).toBe(false);
    expect(await userExists(alice)).toBe(false);
  });

  it("marks a tenant's activity at most once a UTC day per token, with the hourly last-used refresh", async () => {
    await purge(0);
    const tenant = await createTenantFor(await user("alice"), "Alice's", at(0));
    const store = tenantStore(tenant);
    const created = await createToken(store, "pc", null, at(1));
    if (!created.ok) throw new Error("token");
    const zadds = () => getRedis().zscore(GLOBAL_KEYS.tenantsActive, tenant);
    await authenticateToken(store, created.token, at(1));
    await flushDeferred();
    expect(Number(await zadds())).toBe(at(1).getTime());
    // Two hours later the same day: last-used is refreshed, the marker is not.
    await authenticateToken(store, created.token, new Date(at(1).getTime() + 2 * 3_600_000));
    await flushDeferred();
    expect(Number(await zadds())).toBe(at(1).getTime());
    await authenticateToken(store, created.token, at(2));
    await flushDeferred();
    expect(Number(await zadds())).toBe(at(2).getTime());
  });

  it("never deletes data that has no marker yet: its months start when tracking does", async () => {
    // A user and a workspace from long before this build: no marker, no tracking start.
    const old = await user("old", -1000);
    const tenant = await createTenantFor(old, "Old", at(-1000));
    await getRedis().zrem(GLOBAL_KEYS.users, old);
    expect(await exists(GLOBAL_KEYS.activitySince)).toBe(false);

    // A dry run before tracking starts it not, and deletes nothing.
    const before = JSON.stringify(getMemoryStoreForTests()!.dump());
    expect(await purge(0, true)).toEqual({ tenantsDeleted: 0, usersDeleted: 0, skipped: 0, pending: 0 });
    expect(JSON.stringify(getMemoryStoreForTests()!.dump())).toBe(before);

    // The first real run starts tracking, and indexes the user as active now.
    await purge(0);
    expect(Number(await getRedis().get(GLOBAL_KEYS.activitySince))).toBe(T0);
    expect(Number(await getRedis().zscore(GLOBAL_KEYS.users, old))).toBe(T0);
    expect(await tenantExists(tenant)).toBe(true);

    await purge(LIMIT - 1);
    expect(await tenantExists(tenant)).toBe(true);
    expect(await userExists(old)).toBe(true);
    await purge(LIMIT + 1);
    expect(await tenantExists(tenant)).toBe(false);
    expect(await userExists(old)).toBe(false);
  });

  it("indexes, and in time deletes, a user without any workspace", async () => {
    const loner = await user("loner", -50);
    await getRedis().zrem(GLOBAL_KEYS.users, loner);
    await purge(0);
    expect(await getRedis().zscore(GLOBAL_KEYS.users, loner)).not.toBeNull();
    await purge(LIMIT + 1);
    expect(await userExists(loner)).toBe(false);
    expect(await getRedis().zscore(GLOBAL_KEYS.users, loner)).toBeNull();
  });

  describe("a shared workspace", () => {
    it("stays, with its inactive owner, while a member is active", async () => {
      await purge(0);
      const owner = await user("owner");
      const member = await user("member");
      const tenant = await createTenantFor(owner, "Shared", at(0));
      await addMember(tenant, member, owner, at(0));
      await signIn(member, 300);

      expect(await purge(LIMIT + 1)).toEqual({ tenantsDeleted: 0, usersDeleted: 0, skipped: 0, pending: 0 });
      expect(await tenantExists(tenant)).toBe(true);
      expect(await userExists(owner)).toBe(true);
      expect(await memberOf(tenant, member)).toBe(true);
    });

    it("loses an inactive member, who is deleted, while the workspace stays", async () => {
      await purge(0);
      const owner = await user("owner");
      const member = await user("member");
      const tenant = await createTenantFor(owner, "Shared", at(0));
      await addMember(tenant, member, owner, at(0));
      await signIn(owner, 300);

      expect(await purge(LIMIT + 1)).toEqual({ tenantsDeleted: 0, usersDeleted: 1, skipped: 0, pending: 0 });
      expect(await tenantExists(tenant)).toBe(true);
      expect(await memberOf(tenant, member)).toBe(false);
      expect(await userExists(member)).toBe(false);
      expect(await memberOf(tenant, owner)).toBe(true);
    });

    it("goes, with every member, once all of them are inactive", async () => {
      await purge(0);
      const owner = await user("owner");
      const member = await user("member");
      const tenant = await createTenantFor(owner, "Shared", at(0));
      await addMember(tenant, member, owner, at(0));

      expect(await purge(LIMIT + 1)).toEqual({ tenantsDeleted: 1, usersDeleted: 2, skipped: 0, pending: 0 });
      expect(await tenantExists(tenant)).toBe(false);
      expect(await userExists(owner)).toBe(false);
      expect(await userExists(member)).toBe(false);
    });
  });

  it("deletes a disabled workspace a year after its disabling, though its owner is active, and keeps the owner", async () => {
    await purge(0);
    const owner = await user("owner");
    const tenant = await createTenantFor(owner, "Disabled", at(0));
    expect(await setTenantStatus(tenant, "disabled", at(10))).toBe(true);
    await signIn(owner, 300);

    await purge(LIMIT + 1);
    expect(await tenantExists(tenant)).toBe(true);
    await purge(10 + LIMIT + 1);
    expect(await tenantExists(tenant)).toBe(false);
    expect(await userExists(owner)).toBe(true);
  });

  it("never touches the default tenant, nor anyone who belongs to it", async () => {
    await purge(0);
    const owner = await user("owner");
    await addOwner(DEFAULT_TENANT, owner, at(0));
    await ingestReport(
      tenantStore(DEFAULT_TENANT),
      { machineId: "box", groupId: "Home", providers: { claude: 10 }, timestamp: at(0).toISOString() },
      at(0),
    );
    const defaultKeys = () =>
      Object.keys(getMemoryStoreForTests()!.dump()).filter((key) => key.startsWith("usage:events:"));
    const eventKeys = defaultKeys();
    expect(eventKeys.length).toBeGreaterThan(0);

    expect(await purge(LIMIT * 3)).toEqual({ tenantsDeleted: 0, usersDeleted: 0, skipped: 0, pending: 0 });
    expect(await userExists(owner)).toBe(true);
    expect(await memberOf(DEFAULT_TENANT, owner)).toBe(true);
    expect(defaultKeys()).toEqual(eventKeys);
  });

  it("does nothing on a single-user instance", async () => {
    vi.stubEnv("REGISTRATION", "closed");
    await getRedis().set(GLOBAL_KEYS.activitySince, String(T0));
    const alice = await user("alice");
    const tenant = await createTenantFor(alice, "Alice's", at(0));
    expect(await purge(LIMIT * 3)).toBeNull();
    expect(await tenantExists(tenant)).toBe(true);
    expect(await userExists(alice)).toBe(true);
  });

  it("counts on a dry run, and writes nothing", async () => {
    await purge(0);
    const alice = await user("alice");
    await createTenantFor(alice, "Alice's", at(0));
    // The default tenant's own housekeeping would stamp it on a real run; a dry run stamps nothing.
    const before = JSON.stringify(getMemoryStoreForTests()!.dump());
    expect(await purge(LIMIT + 1, true)).toEqual({ tenantsDeleted: 1, usersDeleted: 1, skipped: 0, pending: 0 });
    expect(JSON.stringify(getMemoryStoreForTests()!.dump())).toBe(before);
  });

  it("leaves the rest for the next run once the time budget is spent", async () => {
    await purge(0);
    await createTenantFor(await user("alice"), "Alice's", at(0));
    const { inactive } = await runScheduledHousekeeping(at(LIMIT + 1), {
      dryRun: false,
      budgetMs: 100,
      elapsedMs: () => 1_000,
    });
    expect(inactive).toEqual({ tenantsDeleted: 0, usersDeleted: 0, skipped: 0, pending: 2 });
  });

  describe("between the plan and the deletion", () => {
    afterEach(() => {
      afterPlanLoad = null;
    });

    it("skips a workspace whose machines report meanwhile, and its owner with it", async () => {
      await purge(0);
      const alice = await user("alice");
      const tenant = await createTenantFor(alice, "Alice's", at(0));
      afterPlanLoad = () => recordTenantActivity(tenant, at(LIMIT + 1).getTime());
      expect(await purge(LIMIT + 1)).toEqual({ tenantsDeleted: 0, usersDeleted: 0, skipped: 2, pending: 0 });
      expect(await tenantExists(tenant)).toBe(true);
      expect(await userExists(alice)).toBe(true);
    });

    it("skips a workspace one of whose members signs in meanwhile", async () => {
      await purge(0);
      const owner = await user("owner");
      const member = await user("member");
      const tenant = await createTenantFor(owner, "Shared", at(0));
      await addMember(tenant, member, owner, at(0));
      afterPlanLoad = () => signIn(member, LIMIT + 1);
      expect(await purge(LIMIT + 1)).toEqual({ tenantsDeleted: 0, usersDeleted: 0, skipped: 3, pending: 0 });
      expect(await tenantExists(tenant)).toBe(true);
    });

    it("skips an account that signs in meanwhile", async () => {
      await purge(0);
      const loner = await user("loner");
      afterPlanLoad = () => signIn(loner, LIMIT + 1);
      expect(await purge(LIMIT + 1)).toEqual({ tenantsDeleted: 0, usersDeleted: 0, skipped: 1, pending: 0 });
      expect(await userExists(loner)).toBe(true);
    });
  });

  it("skips an account whose workspace's members are being changed, until a later run", async () => {
    await purge(0);
    const owner = await user("owner");
    const member = await user("member");
    const tenant = await createTenantFor(owner, "Shared", at(0));
    await addMember(tenant, member, owner, at(0));
    await signIn(owner, 300);
    await getRedis().set(GLOBAL_KEYS.tenantLock(tenant), "someone else");
    expect(await purge(LIMIT + 1)).toEqual({ tenantsDeleted: 0, usersDeleted: 0, skipped: 1, pending: 0 });
    expect(await userExists(member)).toBe(true);
    await getRedis().del(GLOBAL_KEYS.tenantLock(tenant));
    expect(await purge(LIMIT + 2)).toEqual({ tenantsDeleted: 0, usersDeleted: 1, skipped: 0, pending: 0 });
  });

  it("drops index entries that name nothing any more", async () => {
    await purge(0);
    const ghostUser = "u_AAAAAAAAAAAAAAAAAAAAAA";
    const ghostTenant = "BBBBBBBBBBBBBBBBBBBBBB";
    await getRedis().zadd(GLOBAL_KEYS.users, { score: T0, member: ghostUser });
    await getRedis().zadd(GLOBAL_KEYS.tenantsActive, { score: T0, member: ghostTenant });
    expect(await purge(LIMIT + 1)).toEqual({ tenantsDeleted: 0, usersDeleted: 0, skipped: 0, pending: 0 });
    expect(await getRedis().zscore(GLOBAL_KEYS.users, ghostUser)).toBeNull();
    expect(await getRedis().zscore(GLOBAL_KEYS.tenantsActive, ghostTenant)).toBeNull();
  });

  it("leaves no key of a deleted account or workspace, and nothing of it in any other value", async () => {
    await purge(0);
    const bob = await user("bob");
    const bobTenant = await createTenantFor(bob, "Bob's", at(0));
    await clientRequest(bobTenant, 0);
    await purge(0);
    const before = new Set(Object.keys(getMemoryStoreForTests()!.dump()));

    const githubId = nextGithubId;
    const alice = await user("alicelogin");
    const tenant = await createTenantFor(alice, "Alice's", at(0));
    const own = tenantStore(tenant);
    await withRequest(() => startUserSession(alice, tenant, at(0)));
    await clientRequest(tenant, 0);
    await ingestReport(
      own,
      { machineId: "alice-laptop", groupId: "AliceWork", providers: { claude: 10 }, timestamp: at(0).toISOString() },
      at(0),
    );
    await saveOfficialUsage(own, { providerId: "claude", subLimitId: null, raw: "40", cycleStartMs: 0 }, at(0));
    await addMember(bobTenant, alice, bob, at(0));
    await signIn(bob, LIMIT);
    await clientRequest(bobTenant, LIMIT);

    expect(await purge(LIMIT + 1)).toEqual({ tenantsDeleted: 1, usersDeleted: 1, skipped: 0, pending: 0 });
    const after = getMemoryStoreForTests()!.dump();
    const bobPrefix = tenantStore(bobTenant).keys.prefix;
    expect(Object.keys(after).filter((key) => !before.has(key) && !key.startsWith(bobPrefix))).toEqual([]);
    const traces = [alice, tenant, "alicelogin", String(githubId), "alice-laptop", "AliceWork"];
    for (const [key, entry] of Object.entries(after)) {
      const flat = (value: unknown): unknown =>
        value instanceof Map ? [...value] : value instanceof Set ? [...value] : value;
      const text = JSON.stringify(flat(entry.value));
      expect(
        traces.filter((trace) => key.includes(trace) || text.includes(trace)),
        key,
      ).toEqual([]);
    }
    expect(await tenantExists(bobTenant)).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as deleteAccountRoute, GET as getAccount } from "@/app/api/account/route";
import { DELETE as endSessions } from "@/app/api/account/sessions/route";
import { GET as getAdmin } from "@/app/api/admin/route";
import { DELETE as revokeCode } from "@/app/api/admin/signup-codes/[id]/route";
import { POST as createCode } from "@/app/api/admin/signup-codes/route";
import { PATCH as patchTenant } from "@/app/api/admin/tenants/[id]/route";
import { GET as getMachines } from "@/app/api/machines/route";
import { GET as getStatus } from "@/app/api/status/route";
import { ingestReport } from "@/lib/ingest";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { tenantStore } from "@/lib/tenant";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";
import { createToken } from "@/lib/tokens";
import { startUserSession } from "@/lib/user-session";
import { addOwner, createTenantFor, findOrCreateGithubUser } from "@/lib/users";
import { useRedis } from "../helpers/redis-fixture";
import { withRequest } from "../helpers/request";

/**
 * The account and the instance admin, through their route handlers: who may
 * delete what, that a deleted account and its own workspaces leave no key
 * behind, that sign-out-everywhere ends every session, and that the admin
 * gets counts only, can disable a tenant (its people and machines are then
 * refused) and issue sign-up links; everyone else gets a 404.
 */

const ORIGIN = { origin: "http://localhost", host: "localhost" };
const ADMIN_GITHUB_ID = 9001;

interface Person {
  userId: string;
  tenantId: TenantId;
  cookie: string;
}

async function person(githubId: number, login: string, tenant?: TenantId): Promise<Person> {
  const now = new Date();
  const { userId } = await findOrCreateGithubUser({ id: githubId, login }, now);
  const tenantId = tenant ?? (await createTenantFor(userId, login, now));
  const header = await withRequest(() => startUserSession(userId, tenantId, now));
  return { userId, tenantId, cookie: header.split(";")[0]! };
}

async function report(tenantId: TenantId, machineId: string): Promise<void> {
  const now = new Date();
  const result = await ingestReport(
    tenantStore(tenantId),
    { machineId, groupId: "Personal", providers: { claude: 10 }, timestamp: now.toISOString() },
    now,
  );
  if (!result.ok) throw new Error("report refused");
}

function request(url: string, init: { method?: string; cookie?: string; body?: unknown; bearer?: string } = {}) {
  return new Request(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers: {
      ...ORIGIN,
      ...(init.cookie && { cookie: init.cookie }),
      ...(init.bearer && { authorization: `Bearer ${init.bearer}` }),
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

/** Takes the session's last GitHub sign-in out of the sudo window. */
async function expireSudo(cookie: string): Promise<void> {
  const { sha256Hex } = await import("@/lib/security");
  const key = GLOBAL_KEYS.userSession(sha256Hex(cookie.split("=")[1]!));
  const record = JSON.parse(String(await getRedis().get(key)));
  await getRedis().set(key, JSON.stringify({ ...record, a: 0 }), { keepTtl: true });
}

describe("the account and the instance admin", () => {
  useRedis();
  beforeEach(() => {
    vi.stubEnv("REGISTRATION", "invite");
    vi.stubEnv("ADMIN_GITHUB_IDS", `${ADMIN_GITHUB_ID}, not-a-number`);
    vi.stubEnv("USAGE_API_TOKEN", "0123456789abcdef0123");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("answers 404 on a single-user instance", async () => {
    vi.stubEnv("REGISTRATION", "closed");
    expect((await getAccount(request("/api/account"))).status).toBe(404);
    expect((await getAdmin(request("/api/admin"))).status).toBe(404);
  });

  it("shows the user their workspaces and sessions, and signs them out everywhere", async () => {
    const alice = await person(1, "alice");
    const second = await withRequest(() => startUserSession(alice.userId, alice.tenantId, new Date()));
    const body = (await (await getAccount(request("/api/account", { cookie: alice.cookie }))).json()) as {
      account: { login: string; workspaces: { role: string; current: boolean }[]; sessions: { current: boolean }[] };
    };
    expect(body.account.login).toBe("alice");
    expect(body.account.workspaces).toMatchObject([{ role: "owner", current: true }]);
    expect(body.account.sessions).toHaveLength(2);
    expect(body.account.sessions.filter((session) => session.current)).toHaveLength(1);

    const ended = await endSessions(request("/api/account/sessions", { method: "DELETE", cookie: alice.cookie }));
    expect(await ended.json()).toEqual({ ended: 2 });
    expect(ended.headers.get("set-cookie")).toMatch(/^ur_session=; Path=\/; Max-Age=0/);
    expect((await getAccount(request("/api/account", { cookie: alice.cookie }))).status).toBe(401);
    expect((await getAccount(request("/api/account", { cookie: second.split(";")[0]! }))).status).toBe(401);
  });

  it("deletes an account with sudo, and its own workspace with every key of it", async () => {
    const alice = await person(1, "alice");
    const bob = await person(2, "bob");
    await report(alice.tenantId, "alice-laptop");
    await report(bob.tenantId, "bob-desktop");
    const token = await createToken(tenantStore(alice.tenantId), "laptop", null, new Date());
    if (!token.ok) throw new Error("unreachable");

    await expireSudo(alice.cookie);
    const refused = await deleteAccountRoute(request("/api/account", { method: "DELETE", cookie: alice.cookie }));
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("sudo_required");

    const fresh = await person(1, "alice", alice.tenantId); // a fresh sign-in: sudo
    const deleted = await deleteAccountRoute(request("/api/account", { method: "DELETE", cookie: fresh.cookie }));
    expect(await deleted.json()).toEqual({ ok: true, workspacesDeleted: 1, workspacesLeft: 0 });

    const memory = getMemoryStoreForTests();
    if (memory) {
      const keys = memory.keys();
      expect(keys.filter((key) => key.startsWith(`t:${alice.tenantId}:`))).toEqual([]);
      expect(keys.filter((key) => key.includes(alice.userId) || key.includes(alice.tenantId))).toEqual([]);
      expect(keys).not.toContain(GLOBAL_KEYS.githubIdentity(1));
      const index = (memory.dump()[GLOBAL_KEYS.tokenIndex]?.value ?? {}) as Record<string, string>;
      expect(Object.values(index)).not.toContain(alice.tenantId);
    }
    // Bob's workspace is untouched.
    const bobMachines = (await (await getMachines(request("/api/machines", { cookie: bob.cookie }))).json()) as {
      machines: { machineId: string }[];
    };
    expect(bobMachines.machines.map((machine) => machine.machineId)).toEqual(["bob-desktop"]);
  });

  it("refuses to delete an owner of a shared workspace, or of the instance's original data", async () => {
    const alice = await person(1, "alice");
    await getRedis().hset(GLOBAL_KEYS.tenantMembers(alice.tenantId), {
      u_BBBBBBBBBBBBBBBBBBBBBB: JSON.stringify({ role: "member" }),
    });
    const shared = await deleteAccountRoute(request("/api/account", { method: "DELETE", cookie: alice.cookie }));
    expect(shared.status).toBe(409);
    expect(await shared.json()).toMatchObject({ error: "owns_shared_workspace", tenantIds: [alice.tenantId] });

    const maintainer = await person(3, "maintainer", DEFAULT_TENANT);
    await addOwner(DEFAULT_TENANT, maintainer.userId, new Date());
    const original = await deleteAccountRoute(request("/api/account", { method: "DELETE", cookie: maintainer.cookie }));
    expect(original.status).toBe(409);
    expect(((await original.json()) as { error: string }).error).toBe("owns_default_workspace");
  });

  it("gives the admin page to the admin only, with counts and never a tenant's data", async () => {
    const alice = await person(1, "alice");
    const admin = await person(ADMIN_GITHUB_ID, "the-admin");
    await report(alice.tenantId, "alice-secret-host");
    expect((await getAdmin(request("/api/admin", { cookie: alice.cookie }))).status).toBe(404);
    expect((await getAdmin(request("/api/admin"))).status).toBe(404);

    const response = await getAdmin(request("/api/admin", { cookie: admin.cookie }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("alice-secret-host");
    expect(text).not.toContain("Personal");
    const { overview } = JSON.parse(text) as {
      overview: { rows: { tenantId: string; owners: string[]; machines: number }[] };
    };
    expect(overview.rows.find((row) => row.tenantId === alice.tenantId)).toMatchObject({
      owners: ["alice"],
      machines: 1,
    });
  });

  it("lets the admin issue a sign-up link once and revoke it", async () => {
    vi.stubEnv("GITHUB_CLIENT_ID", "id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "secret");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.test");
    const admin = await person(ADMIN_GITHUB_ID, "the-admin");
    const alice = await person(1, "alice");
    expect(
      (await createCode(request("/api/admin/signup-codes", { method: "POST", cookie: alice.cookie }))).status,
    ).toBe(404);

    const created = await createCode(request("/api/admin/signup-codes", { method: "POST", cookie: admin.cookie }));
    expect(created.status).toBe(201);
    const { id, url } = (await created.json()) as { id: string; url: string };
    expect(url).toMatch(/^https:\/\/app\.example\.test\/signup#[A-Za-z0-9_-]{43}$/);
    const listed = (await (await getAdmin(request("/api/admin", { cookie: admin.cookie }))).text()) as string;
    expect(listed).not.toContain(url.split("#")[1]);

    const revoked = await revokeCode(
      request(`/api/admin/signup-codes/${id}`, { method: "DELETE", cookie: admin.cookie }),
      params({ id }),
    );
    expect(revoked.status).toBe(200);
    expect((await revokeCode(request("/x", { method: "DELETE", cookie: admin.cookie }), params({ id }))).status).toBe(
      404,
    );
  });

  it("disables a tenant: its members and machines are refused until it is enabled again", async () => {
    const admin = await person(ADMIN_GITHUB_ID, "the-admin");
    const alice = await person(1, "alice");
    const token = await createToken(tenantStore(alice.tenantId), "menu bar", null, new Date(), "read");
    if (!token.ok) throw new Error("unreachable");
    const status = () => getStatus(request("/api/status", { bearer: token.token }));
    expect((await status()).status).toBe(200);

    const patch = (status: string, tenantId: string = alice.tenantId) =>
      patchTenant(request("/x", { method: "PATCH", cookie: admin.cookie, body: { status } }), params({ id: tenantId }));
    expect((await patch("disabled")).status).toBe(200);
    expect((await getMachines(request("/api/machines", { cookie: alice.cookie }))).status).toBe(401);
    const refused = await status();
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("tenant_disabled");

    expect((await patch("active")).status).toBe(200);
    expect((await getMachines(request("/api/machines", { cookie: alice.cookie }))).status).toBe(200);
    expect((await status()).status).toBe(200);

    expect((await patch("disabled", DEFAULT_TENANT)).status).toBe(404);
    expect((await patch("whatever")).status).toBe(400);
    expect(
      (
        await patchTenant(
          request("/x", { method: "PATCH", cookie: alice.cookie, body: { status: "disabled" } }),
          params({ id: alice.tenantId }),
        )
      ).status,
    ).toBe(404);
  });
});

describe("tenant status, against races and stale states", () => {
  useRedis();
  beforeEach(() => {
    vi.stubEnv("REGISTRATION", "invite");
    vi.stubEnv("USAGE_API_TOKEN", "0123456789abcdef0123");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("refuses a disabled tenant's token before writing anything of the tenant", async () => {
    const alice = await person(1, "alice");
    const token = await createToken(tenantStore(alice.tenantId), "menu bar", null, new Date(), "read");
    if (!token.ok) throw new Error("unreachable");
    const { setTenantStatus } = await import("@/lib/tenants");
    await setTenantStatus(alice.tenantId, "disabled", new Date());
    const before = await getRedis().hgetall(tenantStore(alice.tenantId).keys.tokens);
    const response = await withRequest(() => getStatus(request("/api/status", { bearer: token.token })));
    expect(response.status).toBe(403);
    expect(await getRedis().hgetall(tenantStore(alice.tenantId).keys.tokens)).toEqual(before);
  });

  it("never undoes a deletion, never brings a deleted record back, and reads an unknown status as disabled", async () => {
    const { loadTenantRecord, parseTenantRecord, setTenantStatus } = await import("@/lib/tenants");
    const alice = await person(1, "alice");
    expect(await setTenantStatus(alice.tenantId, "deleting", new Date())).toBe(true);
    expect(await setTenantStatus(alice.tenantId, "active", new Date())).toBe(false);
    expect((await loadTenantRecord(alice.tenantId))?.status).toBe("deleting");

    await getRedis().del(GLOBAL_KEYS.tenantRecord(alice.tenantId));
    expect(await setTenantStatus(alice.tenantId, "active", new Date())).toBe(false);
    expect(await getRedis().exists(GLOBAL_KEYS.tenantRecord(alice.tenantId))).toBe(0);

    expect(parseTenantRecord(JSON.stringify({ v: 1, name: "x", createdAt: 1, status: "suspended" }))?.status).toBe(
      "disabled",
    );
    expect(parseTenantRecord(JSON.stringify({ v: 1, name: "x", createdAt: 1 }))?.status).toBe("active");
  });

  it("has housekeeping finish a deletion that was cut short, without writing to the tenant", async () => {
    const { setTenantStatus } = await import("@/lib/tenants");
    const { runScheduledHousekeeping } = await import("@/lib/housekeeping");
    const alice = await person(1, "alice");
    await report(alice.tenantId, "alice-laptop");
    await setTenantStatus(alice.tenantId, "deleting", new Date());
    await runScheduledHousekeeping(new Date(), { dryRun: false });
    const memory = getMemoryStoreForTests();
    if (memory) {
      expect(memory.keys().filter((key) => key.includes(alice.tenantId))).toEqual([]);
    }
  });

  it("lists only the sessions that still work on the account page", async () => {
    vi.stubEnv("SESSION_IDLE_DAYS", "1");
    const alice = await person(1, "alice");
    const { sha256Hex } = await import("@/lib/security");
    const stale = await withRequest(() => startUserSession(alice.userId, alice.tenantId, new Date()));
    const key = GLOBAL_KEYS.userSession(sha256Hex(stale.split(";")[0]!.split("=")[1]!));
    const record = JSON.parse(String(await getRedis().get(key)));
    await getRedis().set(key, JSON.stringify({ ...record, s: Date.now() - 3 * 86_400_000 }), { keepTtl: true });
    const body = (await (await getAccount(request("/api/account", { cookie: alice.cookie }))).json()) as {
      account: { sessions: unknown[] };
    };
    expect(body.account.sessions).toHaveLength(1);
  });
});

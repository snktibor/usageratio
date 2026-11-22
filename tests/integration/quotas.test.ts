import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PUT as putSettings } from "@/app/api/settings/route";
import { POST as createTokenRoute } from "@/app/api/tokens/route";
import { POST as restoreTrashRoute } from "@/app/api/trash/[id]/restore/route";
import { POST as postUsage } from "@/app/api/usage/route";
import { POST as createInviteRoute } from "@/app/api/workspace/invites/route";
import { POST as transferRoute } from "@/app/api/workspace/transfer/route";
import { WORKSPACE_QUOTAS } from "@/lib/config";
import { listInvites } from "@/lib/invites";
import { deleteGroup } from "@/lib/manage-store";
import { addMember, memberCount } from "@/lib/members";
import { loadQuotaRefusals } from "@/lib/quota-refusals";
import { loadQuotaUse } from "@/lib/quota-use";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { sha256Hex } from "@/lib/security";
import { serializeGroupEntry } from "@/lib/settings";
import { createSignupCode } from "@/lib/signup-codes";
import { tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { createToken } from "@/lib/tokens";
import { createTenantFor, findOrCreateGithubUser, userForGithub, userTenants } from "@/lib/users";
import { ACCOUNTS, ORIGIN, signIn, stubGithubInstance } from "../helpers/github";
import { useRedis } from "../helpers/redis-fixture";

/**
 * The F6 quotas (lib/quotas.ts) through the route handlers, in invite mode:
 * the abuse probe creates machines, groups, tokens and people until a quota
 * refuses, and checks every refusal is a stable `too_many_*` code with its
 * limit (never a silent drop); a workspace already over a limit keeps all of
 * its data and keeps reporting; one workspace's full quota never touches
 * another's; and a single-user instance keeps its instance-wide caps.
 */

ACCOUNTS.dave = { id: 4004, login: "dave" };

interface Person {
  userId: string;
  tenantId: TenantId;
  cookie: string;
}

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

function call(
  handler: Handler,
  path: string,
  init: { method?: string; as?: Person; bearer?: string; body?: unknown; params?: Record<string, string> } = {},
): Promise<Response> {
  const request = new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...ORIGIN,
      ...(init.as && { cookie: init.as.cookie, "x-usageratio-tenant": init.as.tenantId }),
      ...(init.bearer && { authorization: `Bearer ${init.bearer}` }),
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  return handler(request, { params: Promise.resolve(init.params ?? {}) });
}

async function owner(account: string): Promise<Person> {
  const { code } = await createSignupCode("admin", new Date());
  const result = await signIn(account, { purpose: "signup", code });
  const userId = (await userForGithub(ACCOUNTS[account]!.id))!;
  const [{ tenantId } = { tenantId: "" as TenantId }] = await userTenants(userId);
  return { userId, tenantId, cookie: result.session! };
}

async function ingestToken(tenantId: TenantId): Promise<string> {
  const created = await createToken(tenantStore(tenantId), "probe", null, new Date());
  if (!created.ok) throw new Error("no token");
  return created.token;
}

function report(
  token: string,
  machineId: string,
  groupId = "Personal",
  providers: Record<string, number> = { claude: 5 },
) {
  return call(postUsage as Handler, "/api/usage", {
    method: "POST",
    bearer: token,
    body: { machineId, groupId, providers, timestamp: new Date().toISOString() },
  });
}

async function setSudo(person: Person): Promise<void> {
  const key = GLOBAL_KEYS.userSession(sha256Hex(person.cookie.split("=")[1]!));
  const record = JSON.parse(String(await getRedis().get(key)));
  await getRedis().set(key, JSON.stringify({ ...record, a: Date.now() }), { keepTtl: true });
}

const SETTINGS = {
  period: "weekly",
  useTokenLimits: false,
  limits: { claude: 500_000 },
  reset: { weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
  resetOverrides: {},
  resetModes: {},
  showRemaining: true,
  costEstimate: false,
  hiddenProviders: [],
  excludedProviders: {},
  subLimits: {},
  alerts: { webhookUrl: null, thresholds: [50, 80, 100], perProvider: true, format: "generic", locale: "en" },
  groups: [] as { id: string; color: string }[],
  removedGroups: [] as string[],
};

describe("workspace quotas (multi-tenant mode)", () => {
  useRedis();
  beforeEach(() => stubGithubInstance("invite"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("abuse probe: machines until the 26th is refused, loudly, and the workspace is told why", async () => {
    const alice = await owner("alice");
    const token = await ingestToken(alice.tenantId);
    for (let i = 0; i < WORKSPACE_QUOTAS.machines; i += 1) {
      expect((await report(token, `box-${i}`)).status).toBe(201);
    }
    const refused = await report(token, "box-one-too-many", "Lab");
    expect(refused.status).toBe(422);
    const body = (await refused.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "too_many_machines", limit: 25 });
    expect(body.message).toMatch(/limit of 25 machines/);

    // Nothing of it was written: no machine, no group.
    const store = tenantStore(alice.tenantId);
    expect(await getRedis().hexists(store.keys.machines, "claude:box-one-too-many")).toBe(0);
    expect(await getRedis().hexists(store.keys.groups, "Lab")).toBe(0);
    expect(await loadQuotaRefusals(store, new Date())).toEqual([
      expect.objectContaining({ code: "too_many_machines", limit: 25, machineId: "box-one-too-many", groupId: "Lab" }),
    ]);

    // A machine already in keeps reporting, a new provider of its own included: one machine stays one.
    expect((await report(token, "box-0", "Personal", { claude: 9, openai: 3 })).status).toBe(201);
    const use = await loadQuotaUse(store, new Date());
    expect(use.machines).toEqual({ used: 25, limit: 25 });
    expect(use.providers).toEqual({ used: 2, limit: 20 });
  });

  it("counts machines, not provider:machine entries: one machine may report every provider", async () => {
    const alice = await owner("alice");
    const token = await ingestToken(alice.tenantId);
    const providers = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`prov-${i}`, i + 1]));
    expect((await report(token, "workstation", "Personal", providers)).status).toBe(201);
    // The 21st provider is the provider quota's.
    const refused = await report(token, "workstation", "Personal", { "prov-new": 1 });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: "too_many_providers", limit: 20 });
  });

  it("abuse probe: groups until the 21st is refused, from a report and from the settings page", async () => {
    const alice = await owner("alice");
    const token = await ingestToken(alice.tenantId);
    // One machine per group: a single machine may only report 12 times an hour here.
    for (let i = 0; i < WORKSPACE_QUOTAS.groups; i += 1) {
      expect((await report(token, `box-${i}`, `Group ${i}`, {})).status).toBe(201);
    }
    const refused = await report(token, "box-21", "Group 21", {});
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: "too_many_groups", limit: 20 });

    const save = (groups: { id: string; color: string }[]) =>
      call(putSettings as Handler, "/api/settings", { method: "PUT", as: alice, body: { ...SETTINGS, groups } });
    const added = await save([{ id: "From the panel", color: "#3987e5" }]);
    expect(added.status).toBe(422);
    expect(await added.json()).toMatchObject({ error: "too_many_groups", limit: 20 });
    // Recolouring the ones it has is no growth, so it saves.
    expect((await save([{ id: "Group 0", color: "#d95926" }])).status).toBe(200);
  });

  it("refuses a restore that would grow past a quota, and says which", async () => {
    const alice = await owner("alice");
    const token = await ingestToken(alice.tenantId);
    expect((await report(token, "box", "Gone")).status).toBe(201);
    const store = tenantStore(alice.tenantId);
    const deleted = await deleteGroup(store, "Gone", true, new Date());
    if (!deleted.ok || !deleted.trashId) throw new Error("not trashed");
    const { trashId } = deleted;
    for (let i = 0; i < WORKSPACE_QUOTAS.groups; i += 1) {
      await getRedis().hset(store.keys.groups, { [`filler-${i}`]: serializeGroupEntry("#3987e5", 1) });
    }
    await setSudo(alice);
    const response = await call(restoreTrashRoute as Handler, `/api/trash/${trashId}/restore`, {
      method: "POST",
      as: alice,
      params: { id: trashId },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "too_many_groups", limit: 20 });
  });

  it("abuse probe: tokens until the 51st is refused", async () => {
    const alice = await owner("alice");
    const store = tenantStore(alice.tenantId);
    for (let i = 0; i < WORKSPACE_QUOTAS.tokens; i += 1) {
      expect((await createToken(store, `t${i}`, null, new Date())).ok).toBe(true);
    }
    await setSudo(alice);
    const response = await call(createTokenRoute as Handler, "/api/tokens", {
      method: "POST",
      as: alice,
      body: { label: "one too many" },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "too_many_tokens", limit: 50 });
  });

  it("abuse probe: people until the workspace is full; an invite then waits instead of being spent", async () => {
    const alice = await owner("alice");
    const pending = await call(createInviteRoute as Handler, "/api/workspace/invites", {
      method: "POST",
      as: alice,
      body: {},
    });
    expect(pending.status).toBe(201);
    const code = ((await pending.json()) as { url: string }).url.split("#")[1]!;
    for (let i = 1; i < WORKSPACE_QUOTAS.members; i += 1) {
      const { userId } = await findOrCreateGithubUser({ id: 9000 + i, login: `filler-${i}` }, new Date());
      await addMember(alice.tenantId, userId, alice.userId, new Date());
    }
    expect(await memberCount(alice.tenantId)).toBe(10);

    const more = await call(createInviteRoute as Handler, "/api/workspace/invites", {
      method: "POST",
      as: alice,
      body: {},
    });
    expect(more.status).toBe(422);
    expect(await more.json()).toMatchObject({ error: "too_many_members", limit: 10 });

    // The invite from before the workspace filled up is refused at the door, and stays pending.
    const joined = await signIn("dave", { purpose: "join", code });
    expect(joined.session).toBeFalsy();
    expect(joined.location).toContain("signin_error=workspace_full");
    expect(await memberCount(alice.tenantId)).toBe(10);
    expect(await listInvites(alice.tenantId, new Date())).toHaveLength(1);
  });

  it("refuses to hand a workspace to someone who already owns as many as they may", async () => {
    const alice = await owner("alice");
    const { userId: bob } = await findOrCreateGithubUser({ id: 2002, login: "bob-dev" }, new Date());
    for (let i = 0; i < WORKSPACE_QUOTAS.ownedWorkspaces; i += 1) await createTenantFor(bob, `bob-${i}`, new Date());
    await addMember(alice.tenantId, bob, alice.userId, new Date());
    await setSudo(alice);
    const response = await call(transferRoute as Handler, "/api/workspace/transfer", {
      method: "POST",
      as: alice,
      body: { userId: bob },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: "too_many_workspaces", limit: 3 });
    expect((await userTenants(alice.userId)).find((entry) => entry.tenantId === alice.tenantId)?.role).toBe("owner");
  });

  it("never deletes or hides what a workspace already has over a quota, and keeps it reporting", async () => {
    const alice = await owner("alice");
    const store = tenantStore(alice.tenantId);
    // 30 machines and 25 groups from before the quotas.
    const entry = (groupId: string) => JSON.stringify({ g: groupId, ts: Date.now(), t: 1 });
    const machines = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`claude:old-${i}`, entry(`g-${i % 25}`)]),
    );
    await getRedis().hset(store.keys.machines, machines);
    await getRedis().hset(
      store.keys.groups,
      Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`g-${i}`, serializeGroupEntry("#3987e5", 1)])),
    );
    await getRedis().hset(store.keys.providers, { claude: "1" });

    const token = await ingestToken(alice.tenantId);
    expect((await report(token, "old-7", "g-7")).status).toBe(201);
    expect((await report(token, "brand-new", "g-7")).status).toBe(422);
    expect((await report(token, "old-8", "g-new")).status).toBe(422);

    expect(await getRedis().hlen(store.keys.machines)).toBe(30);
    expect(await getRedis().hlen(store.keys.groups)).toBe(25);
    const use = await loadQuotaUse(store, new Date());
    expect(use.machines).toEqual({ used: 30, limit: 25 });
    expect(use.groups).toEqual({ used: 25, limit: 20 });
  });

  it("keeps one workspace's quota and refusals to itself", async () => {
    const alice = await owner("alice");
    const bob = await owner("bob");
    const aliceToken = await ingestToken(alice.tenantId);
    const bobToken = await ingestToken(bob.tenantId);
    for (let i = 0; i < WORKSPACE_QUOTAS.machines; i += 1) await report(aliceToken, `a-${i}`);
    expect((await report(aliceToken, "a-full")).status).toBe(422);

    // Bob's workspace is empty: its first machine gets in, and it has no refusal to show.
    expect((await report(bobToken, "b-first")).status).toBe(201);
    expect(await loadQuotaRefusals(tenantStore(bob.tenantId), new Date())).toEqual([]);
    expect((await loadQuotaUse(tenantStore(bob.tenantId), new Date())).machines).toEqual({ used: 1, limit: 25 });

    const memory = getMemoryStoreForTests();
    if (memory) {
      // Alice's refusal is under her prefix only, and names nothing of Bob's.
      const refusalKey = tenantStore(alice.tenantId).keys.quotaRefusals;
      expect(memory.keys().filter((key) => key.endsWith("quota:refused"))).toEqual([refusalKey]);
      expect(JSON.stringify(memory.dump()[refusalKey])).not.toContain("b-first");
    }
  });
});

describe("a single-user instance (closed mode)", () => {
  useRedis();
  afterEach(() => vi.unstubAllEnvs());

  it("keeps its instance-wide caps: entries, not machines, and no refusal record", async () => {
    vi.stubEnv("REGISTRATION", "closed");
    vi.stubEnv("USAGE_API_TOKEN", "shared-token-of-the-instance");
    const store = tenantStore("default" as TenantId);
    const created = await createToken(store, "probe", null, new Date());
    if (!created.ok) throw new Error("no token");
    for (let i = 0; i < 30; i += 1) expect((await report(created.token, `box-${i}`)).status).toBe(201);
    const use = await loadQuotaUse(store, new Date());
    expect(use).toMatchObject({
      machines: { used: 30, limit: 200 },
      groups: { used: 1, limit: 50 },
      tokens: { used: 1, limit: 100 },
      members: null,
      pendingInvites: null,
    });

    const entries = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`claude:fill-${i}`, JSON.stringify({ g: "Personal", ts: 1, t: 1 })]),
    );
    await getRedis().hset(store.keys.machines, entries);
    const refused = await report(created.token, "one-more");
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: "too_many_machines", limit: 200 });
    expect(await loadQuotaRefusals(store, new Date())).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getExport } from "@/app/api/export/route";
import { GET as getMachines } from "@/app/api/machines/route";
import { POST as switchTenant } from "@/app/api/session/tenant/route";
import { POST as createTokenRoute } from "@/app/api/tokens/route";
import { DELETE as revokeInviteRoute } from "@/app/api/workspace/invites/[id]/route";
import { POST as createInviteRoute } from "@/app/api/workspace/invites/route";
import { POST as leave } from "@/app/api/workspace/leave/route";
import { DELETE as removeMemberRoute } from "@/app/api/workspace/members/[userId]/route";
import { GET as getWorkspace } from "@/app/api/workspace/route";
import { POST as transfer } from "@/app/api/workspace/transfer/route";
import { ingestReport } from "@/lib/ingest";
import { listInvites, pruneExpiredInvites } from "@/lib/invites";
import type { Member } from "@/lib/members";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { sha256Hex } from "@/lib/security";
import { createSignupCode } from "@/lib/signup-codes";
import { tenantStore } from "@/lib/tenant";
import { deleteTenant } from "@/lib/tenant-deletion";
import type { TenantId } from "@/lib/tenant-id";
import { setTenantStatus } from "@/lib/tenants";
import { listTokens } from "@/lib/tokens";
import { userForGithub, userTenants } from "@/lib/users";
import { ACCOUNTS, ORIGIN, SITE, signIn, startAttempt, stubGithubInstance } from "../helpers/github";
import { useRedis } from "../helpers/redis-fixture";

/**
 * Several people in one workspace, through the route handlers, with GitHub
 * played by the fetch stub (tests/helpers/github.ts): an owner invites, the
 * invitee joins through GitHub and sees the same data; the invite works once,
 * only for the login it names, and only within its week; a member cannot do
 * an owner's things, and someone outside the workspace cannot even find it;
 * removal, leaving and handing over keep exactly one owner; and a form left
 * open for one workspace cannot save into another after a switch.
 */

ACCOUNTS.carol = { id: 3003, login: "Carol" };

interface Person {
  userId: string;
  tenantId: TenantId;
  cookie: string;
}

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

function call(
  handler: Handler,
  path: string,
  init: { method?: string; as?: Person; tenant?: string | null; body?: unknown; params?: Record<string, string> } = {},
): Promise<Response> {
  const tenant = init.tenant === undefined ? init.as?.tenantId : init.tenant;
  const request = new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...ORIGIN,
      ...(init.as && { cookie: init.as.cookie }),
      ...(tenant && { "x-usageratio-tenant": tenant }),
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
  return handler(request, { params: Promise.resolve(init.params ?? {}) });
}

async function errorOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}

/** A new account with a workspace of its own (a sign-up code, as in invite mode). */
async function owner(account: string): Promise<Person> {
  const { code } = await createSignupCode("admin", new Date());
  const result = await signIn(account, { purpose: "signup", code });
  const userId = (await userForGithub(ACCOUNTS[account]!.id))!;
  const [{ tenantId } = { tenantId: "" as TenantId }] = await userTenants(userId);
  return { userId, tenantId, cookie: result.session! };
}

async function invite(by: Person, login?: string): Promise<{ id: string; code: string; url: string }> {
  const response = await call(createInviteRoute as Handler, "/api/workspace/invites", {
    method: "POST",
    as: by,
    body: login === undefined ? {} : { login },
  });
  expect(response.status).toBe(201);
  const { url, entry } = (await response.json()) as { url: string; entry: { id: string } };
  return { id: entry.id, code: url.split("#")[1]!, url };
}

/** Joins through GitHub as `account`; the person in the workspace, or the error the callback sent them to. */
async function join(account: string, code: string): Promise<Person | string> {
  const result = await signIn(account, { purpose: "join", code });
  if (!result.session) return result.location ?? "";
  const userId = (await userForGithub(ACCOUNTS[account]!.id))!;
  const tenantId = (await currentSessionTenant(result.session)) as TenantId;
  return { userId, tenantId, cookie: result.session };
}

async function currentSessionTenant(cookie: string): Promise<string | null> {
  const raw = await getRedis().get(GLOBAL_KEYS.userSession(sha256Hex(cookie.split("=")[1]!)));
  return (JSON.parse(String(raw)) as { t: string | null }).t;
}

async function machinesSeenBy(person: Person): Promise<string[]> {
  const response = await call(getMachines as Handler, "/api/machines", { as: person });
  if (response.status !== 200) return [`status ${response.status}`];
  const body = (await response.json()) as { machines: { machineId: string }[] };
  return body.machines.map((machine) => machine.machineId).sort();
}

async function members(person: Person): Promise<Pick<Member, "login" | "role">[]> {
  const response = await call(getWorkspace as Handler, "/api/workspace", { as: person });
  const body = (await response.json()) as { workspace: { members: Member[] } };
  return body.workspace.members.map(({ login, role }) => ({ login, role }));
}

async function report(tenantId: TenantId, machineId: string): Promise<void> {
  const now = new Date();
  const result = await ingestReport(
    tenantStore(tenantId),
    { machineId, groupId: "Personal", providers: { claude: 100 }, timestamp: now.toISOString() },
    now,
  );
  if (!result.ok) throw new Error("report refused");
}

async function setSudo(person: Person, fresh: boolean): Promise<void> {
  const key = GLOBAL_KEYS.userSession(sha256Hex(person.cookie.split("=")[1]!));
  const record = JSON.parse(String(await getRedis().get(key)));
  await getRedis().set(key, JSON.stringify({ ...record, a: fresh ? Date.now() : 0 }), { keepTtl: true });
}

function asPerson(value: Person | string): Person {
  if (typeof value === "string") throw new Error(`join failed: ${value}`);
  return value;
}

describe("workspace members and invites", () => {
  useRedis();
  beforeEach(() => stubGithubInstance("invite"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("lets two GitHub accounts into one workspace, where both see the same data", async () => {
    const alice = await owner("alice");
    await report(alice.tenantId, "alice-laptop");
    const { code, url } = await invite(alice);
    expect(url.startsWith(`${SITE}/join#`)).toBe(true);

    const bob = asPerson(await join("bob", code));
    expect(bob.tenantId).toBe(alice.tenantId);
    expect(await machinesSeenBy(bob)).toEqual(["alice-laptop"]);
    await report(alice.tenantId, "shared-server");
    expect(await machinesSeenBy(alice)).toEqual(["alice-laptop", "shared-server"]);
    expect(await machinesSeenBy(bob)).toEqual(["alice-laptop", "shared-server"]);

    // The invite made bob a member, and no workspace of his own.
    expect(await userTenants(bob.userId)).toEqual([{ tenantId: alice.tenantId, role: "member" }]);
    expect(await members(bob)).toEqual([
      { login: "alice", role: "owner" },
      { login: "bob-dev", role: "member" },
    ]);
    // Used once: the link is spent, and gone from the owner's list.
    expect((await startAttempt({ purpose: "join", code })).response.status).toBe(400);
    expect(await listInvites(alice.tenantId, new Date())).toEqual([]);
  });

  it("keeps only the invite's hash, for a week, at most ten at once, and revokes one", async () => {
    const alice = await owner("alice");
    const first = await invite(alice);
    const memory = getMemoryStoreForTests();
    if (memory) {
      expect(JSON.stringify(memory.dump())).not.toContain(first.code);
      expect(memory.ttl(GLOBAL_KEYS.invite(sha256Hex(first.code)))).toBe(7 * 86_400);
    }
    for (let i = 1; i < 10; i += 1) await invite(alice);
    const eleventh = await call(createInviteRoute as Handler, "/api/workspace/invites", {
      method: "POST",
      as: alice,
      body: {},
    });
    expect(eleventh.status).toBe(422);
    expect(await errorOf(eleventh)).toBe("too_many_invites");

    const revoke = () =>
      call(revokeInviteRoute as Handler, `/api/workspace/invites/${first.id}`, {
        method: "DELETE",
        as: alice,
        params: { id: first.id },
      });
    expect((await revoke()).status).toBe(200);
    expect((await startAttempt({ purpose: "join", code: first.code })).response.status).toBe(400);
    expect((await revoke()).status).toBe(404);

    // Past their week, housekeeping drops what is left of the list.
    const later = new Date(Date.now() + 8 * 86_400_000);
    expect(await pruneExpiredInvites(alice.tenantId, later)).toBe(9);
    expect(await getRedis().exists(GLOBAL_KEYS.tenantInvites(alice.tenantId))).toBe(0);
  });

  it("lets only the named login use a bound invite, and another account does not use it up", async () => {
    const alice = await owner("alice");
    const bound = await invite(alice, "@carol");
    expect(await join("bob", bound.code)).toBe("/en/join?signin_error=invite_wrong_account");
    expect(await userForGithub(ACCOUNTS.bob!.id)).toBeNull();
    // GitHub logins are case-insensitive: "Carol" is the "carol" the owner typed.
    const carol = asPerson(await join("carol", bound.code));
    expect(carol.tenantId).toBe(alice.tenantId);

    const refused = await call(createInviteRoute as Handler, "/api/workspace/invites", {
      method: "POST",
      as: alice,
      body: { login: "not a login" },
    });
    expect(refused.status).toBe(400);
  });

  it("gives one invite to one of two accounts racing for it", async () => {
    const alice = await owner("alice");
    const { code } = await invite(alice);
    const { finish } = await import("../helpers/github");
    const bobAttempt = await startAttempt({ purpose: "join", code });
    const carolAttempt = await startAttempt({ purpose: "join", code });
    const bob = await finish({ account: "bob", state: bobAttempt.state, nonce: bobAttempt.nonce });
    const carol = await finish({ account: "carol", state: carolAttempt.state, nonce: carolAttempt.nonce });
    expect(bob.session).not.toBeNull();
    expect(carol.location).toBe("/en/join?signin_error=invite_invalid");
    expect(await userForGithub(ACCOUNTS.carol!.id)).toBeNull();
  });

  it("just opens the workspace for someone already in it, and leaves the invite for its owner", async () => {
    const alice = await owner("alice");
    asPerson(await join("bob", (await invite(alice)).code));
    const spare = await invite(alice);
    const again = asPerson(await join("bob", spare.code));
    expect(again.tenantId).toBe(alice.tenantId);
    expect((await startAttempt({ purpose: "join", code: spare.code })).response.status).toBe(200);
    // And the owner following their own link stays the owner.
    asPerson(await join("alice", spare.code));
    expect(await members(alice)).toContainEqual({ login: "alice", role: "owner" });
  });

  it("refuses an invite into a switched-off workspace, without spending it", async () => {
    const alice = await owner("alice");
    const { code } = await invite(alice);
    await setTenantStatus(alice.tenantId, "disabled", new Date());
    expect(await join("bob", code)).toBe("/en/join?signin_error=invite_invalid");
    await setTenantStatus(alice.tenantId, "active", new Date());
    expect(asPerson(await join("bob", code)).tenantId).toBe(alice.tenantId);
  });

  it("keeps a member from the owner's actions, and someone outside from the workspace altogether", async () => {
    const alice = await owner("alice");
    const pending = await invite(alice);
    const bob = asPerson(await join("bob", (await invite(alice)).code));
    await setSudo(bob, true);

    const asBob = {
      invite: await call(createInviteRoute as Handler, "/api/workspace/invites", { method: "POST", as: bob, body: {} }),
      revoke: await call(revokeInviteRoute as Handler, "/api/workspace/invites/x", {
        method: "DELETE",
        as: bob,
        params: { id: pending.id },
      }),
      remove: await call(removeMemberRoute as Handler, "/api/workspace/members/x", {
        method: "DELETE",
        as: bob,
        params: { userId: alice.userId },
      }),
      transfer: await call(transfer as Handler, "/api/workspace/transfer", {
        method: "POST",
        as: bob,
        body: { userId: bob.userId },
      }),
      export: await call(getExport as Handler, "/api/export?format=json&cycle=current", { as: bob }),
    };
    for (const [action, response] of Object.entries(asBob)) {
      expect([action, response.status, await errorOf(response)]).toEqual([action, 403, "owner_only"]);
    }
    // A member sees who belongs, not the pending invites.
    const view = (await (await call(getWorkspace as Handler, "/api/workspace", { as: bob })).json()) as {
      workspace: { invites: unknown[]; role: string };
    };
    expect(view.workspace).toMatchObject({ role: "member", invites: [] });
    expect((await call(getExport as Handler, "/api/export?format=json&cycle=current", { as: alice })).status).toBe(200);

    // Carol owns a workspace of her own: alice's is nowhere to be found from there.
    const carol = await owner("carol");
    const switched = await call(switchTenant as Handler, "/api/session/tenant", {
      method: "POST",
      as: carol,
      tenant: null,
      body: { tenantId: alice.tenantId },
    });
    expect(switched.status).toBe(404);
    const removeFromHers = await call(removeMemberRoute as Handler, "/api/workspace/members/x", {
      method: "DELETE",
      as: carol,
      params: { userId: bob.userId },
    });
    expect(removeFromHers.status).toBe(404);
    const revokeAlices = await call(revokeInviteRoute as Handler, "/api/workspace/invites/x", {
      method: "DELETE",
      as: carol,
      params: { id: pending.id },
    });
    expect(revokeAlices.status).toBe(404);
    expect((await startAttempt({ purpose: "join", code: pending.code })).response.status).toBe(200);
    expect(await members(carol)).toEqual([{ login: "Carol", role: "owner" }]);
  });

  it("refuses a change from a tab still showing the workspace the session has left", async () => {
    const alice = await owner("alice");
    const carol = await owner("carol");
    asPerson(await join("alice", (await invite(carol)).code));
    // Joining moved alice's session to carol's workspace: switch it back.
    const back = await call(switchTenant as Handler, "/api/session/tenant", {
      method: "POST",
      as: alice,
      tenant: null,
      body: { tenantId: alice.tenantId },
    });
    expect(back.status).toBe(200);
    await report(alice.tenantId, "alice-laptop");
    await report(carol.tenantId, "carol-box");

    const create = (tenant: string | null) =>
      call(createInviteRoute as Handler, "/api/workspace/invites", { method: "POST", as: alice, tenant, body: {} });
    expect((await create(alice.tenantId)).status).toBe(201);
    for (const tenant of [null, carol.tenantId, "garbage"]) {
      const response = await create(tenant);
      expect([tenant, response.status, await errorOf(response)]).toEqual([tenant, 409, "tenant_changed"]);
    }

    // Switching in one tab: every tab now reads carol's workspace, and the old tab's form is refused.
    await call(switchTenant as Handler, "/api/session/tenant", {
      method: "POST",
      as: alice,
      tenant: null,
      body: { tenantId: carol.tenantId },
    });
    expect(await machinesSeenBy(alice)).toEqual(["carol-box"]);
    expect((await create(alice.tenantId)).status).toBe(409);
  });

  it("removes a member, with or without the tokens they created, and never the owner", async () => {
    const alice = await owner("alice");
    const bob = asPerson(await join("bob", (await invite(alice)).code));
    await setSudo(bob, true);
    const created = await call(createTokenRoute as Handler, "/api/tokens", {
      method: "POST",
      as: bob,
      body: { label: "bob's laptop", machineId: "bob-laptop" },
    });
    expect(created.status).toBe(201);
    const store = tenantStore(alice.tenantId);
    expect((await listTokens(store))[0]?.createdBy).toBe(bob.userId);

    const remove = (userId: string, revokeTokens: boolean) =>
      call(removeMemberRoute as Handler, `/api/workspace/members/${userId}${revokeTokens ? "?revokeTokens=1" : ""}`, {
        method: "DELETE",
        as: alice,
        params: { userId },
      });
    const self = await remove(alice.userId, true);
    expect([self.status, await errorOf(self)]).toEqual([409, "cannot_remove_owner"]);

    const removed = await remove(bob.userId, true);
    expect(await removed.json()).toEqual({ ok: true, tokensRevoked: 1 });
    expect((await listTokens(store))[0]?.revokedAt).not.toBeNull();
    // Gone on bob's very next request, from both sides of the membership.
    expect(await machinesSeenBy(bob)).toEqual(["status 401"]);
    expect(await userTenants(bob.userId)).toEqual([]);
    expect((await remove(bob.userId, true)).status).toBe(404);

    // Without the option, the machines keep reporting.
    const again = asPerson(await join("bob", (await invite(alice)).code));
    await setSudo(again, true);
    await call(createTokenRoute as Handler, "/api/tokens", {
      method: "POST",
      as: again,
      body: { label: "second", machineId: "bob-desktop" },
    });
    expect(await (await remove(bob.userId, false)).json()).toEqual({ ok: true, tokensRevoked: 0 });
    expect((await listTokens(store)).find((token) => token.label === "second")?.revokedAt).toBeNull();
  });

  it("lets a member leave, but not the owner, and moves the session on", async () => {
    const alice = await owner("alice");
    const bob = asPerson(await join("bob", (await invite(alice)).code));
    const ownerLeaves = await call(leave as Handler, "/api/workspace/leave", { method: "POST", as: alice });
    expect([ownerLeaves.status, await errorOf(ownerLeaves)]).toEqual([409, "owner_cannot_leave"]);

    const left = await call(leave as Handler, "/api/workspace/leave", { method: "POST", as: bob });
    expect(await left.json()).toEqual({ ok: true, tenantId: null });
    expect(await currentSessionTenant(bob.cookie)).toBeNull();
    expect(await machinesSeenBy(bob)).toEqual(["status 401"]);
    expect(await members(alice)).toEqual([{ login: "alice", role: "owner" }]);
  });

  it("hands the workspace over with sudo, to a member only, leaving exactly one owner", async () => {
    const alice = await owner("alice");
    const bob = asPerson(await join("bob", (await invite(alice)).code));
    const handOver = (userId: string) =>
      call(transfer as Handler, "/api/workspace/transfer", { method: "POST", as: alice, body: { userId } });

    await setSudo(alice, false);
    const noSudo = await handOver(bob.userId);
    expect([noSudo.status, await errorOf(noSudo)]).toEqual([403, "sudo_required"]);
    await setSudo(alice, true);
    expect((await handOver("u_CCCCCCCCCCCCCCCCCCCCCC")).status).toBe(404);
    expect((await handOver(alice.userId)).status).toBe(404);

    // While another change holds the members, it waits its turn.
    await getRedis().set(GLOBAL_KEYS.tenantLock(alice.tenantId), "someone", { ex: 10 });
    const busy = await handOver(bob.userId);
    expect([busy.status, await errorOf(busy)]).toEqual([409, "members_busy"]);
    await getRedis().del(GLOBAL_KEYS.tenantLock(alice.tenantId));

    expect((await handOver(bob.userId)).status).toBe(200);
    expect(await members(alice)).toEqual([
      { login: "bob-dev", role: "owner" },
      { login: "alice", role: "member" },
    ]);
    expect(await userTenants(bob.userId)).toEqual([{ tenantId: alice.tenantId, role: "owner" }]);
    expect(await userTenants(alice.userId)).toEqual([{ tenantId: alice.tenantId, role: "member" }]);
    // The roles follow at once: alice is a member now, and may leave.
    expect((await handOver(bob.userId)).status).toBe(403);
    expect((await call(leave as Handler, "/api/workspace/leave", { method: "POST", as: alice })).status).toBe(200);
  });

  it("answers 404 on a single-user instance", async () => {
    const alice = await owner("alice");
    vi.stubEnv("REGISTRATION", "closed");
    for (const response of [
      await call(getWorkspace as Handler, "/api/workspace", { as: alice }),
      await call(createInviteRoute as Handler, "/api/workspace/invites", { method: "POST", as: alice, body: {} }),
      await call(leave as Handler, "/api/workspace/leave", { method: "POST", as: alice }),
      await call(switchTenant as Handler, "/api/session/tenant", {
        method: "POST",
        as: alice,
        body: { tenantId: alice.tenantId },
      }),
    ]) {
      expect(response.status).toBe(404);
    }
  });

  it("deletes a workspace's invites with it", async () => {
    const alice = await owner("alice");
    const { code } = await invite(alice);
    await invite(alice, "carol");
    expect((await deleteTenant(alice.tenantId, new Date())).ok).toBe(true);
    const memory = getMemoryStoreForTests();
    if (memory) {
      const left = memory.keys().filter((key) => key.includes(alice.tenantId) || key.startsWith("usage:invite:"));
      expect(left).toEqual([]);
    }
    expect((await startAttempt({ purpose: "join", code })).response.status).toBe(400);
  });
});

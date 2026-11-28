import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as exportAccount } from "@/app/api/account/export/route";
import { DELETE as deleteAccountRoute } from "@/app/api/account/route";
import { GET as exportCycle } from "@/app/api/export/route";
import { DELETE as deleteGroupRoute } from "@/app/api/groups/[group]/route";
import { POST as switchTenant } from "@/app/api/session/tenant/route";
import { POST as createTokenRoute } from "@/app/api/tokens/route";
import { POST as postUsage } from "@/app/api/usage/route";
import { createInvite } from "@/lib/invites";
import { addMember } from "@/lib/members";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { consumeSignupCode, createSignupCode, signupCodeHash } from "@/lib/signup-codes";
import { tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { archiveCycle, saveOfficialUsage } from "@/lib/usage-store";
import { startUserSession } from "@/lib/user-session";
import { createTenantFor, findOrCreateGithubUser } from "@/lib/users";
import { REAL_REDIS, useRedis } from "../helpers/redis-fixture";
import { withRequest } from "../helpers/request";

/**
 * Deleting an account leaves nothing of it behind (GDPR Art. 17). Alice uses
 * everything there is: her own workspace (reports from two machines, tokens,
 * an official reading, an archived cycle, a force-deleted group in the trash,
 * a webhook, a pending invite, the exports), a sign-up code, and a workspace
 * of Bob's that she is a member of, where she adds a token and deletes a
 * group. After she deletes her account, the store is compared key by key with
 * how it was before she signed up.
 *
 * What may remain is exactly what lib/account.ts says: in Bob's workspace the
 * record of what she did there, and the short-lived security counters. Of
 * her own workspace, her account and her sessions: not a key, and not her
 * login, ids, machines or groups in any value.
 */

const ORIGIN = { origin: "http://localhost", host: "localhost", "x-forwarded-for": "203.0.113.7" };
const DAY = 86_400_000;
const ALICE_GITHUB_ID = 7_314_159_265;

interface RequestInit {
  method?: string;
  cookie?: string;
  tenant?: TenantId;
  bearer?: string;
  body?: unknown;
}

function request(url: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: init.method ?? "GET",
    headers: {
      ...ORIGIN,
      ...(init.cookie && { cookie: init.cookie }),
      ...(init.tenant && { "x-usageratio-tenant": init.tenant }),
      ...(init.bearer && { authorization: `Bearer ${init.bearer}` }),
      ...(init.body !== undefined && { "content-type": "application/json" }),
    },
    ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
  });
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

/** Every live key, its value as text (hashes, sets and sorted sets with their members) and its TTL in seconds. */
function snapshot(): Map<string, { text: string; ttl: number }> {
  const dump = getMemoryStoreForTests()!.dump();
  const flat = (value: unknown): unknown =>
    value instanceof Map ? [...value] : value instanceof Set ? [...value] : value;
  return new Map(
    Object.entries(dump).map(([key, entry]) => [key, { text: JSON.stringify(flat(entry.value)), ttl: entry.ttl }]),
  );
}

async function token(cookie: string, tenant: TenantId, label: string): Promise<string> {
  const response = await createTokenRoute(request("/api/tokens", { method: "POST", cookie, tenant, body: { label } }));
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

async function report(bearer: string, machineId: string, groupId: string): Promise<void> {
  const body = { machineId, groupId, providers: { claude: 10 }, timestamp: new Date().toISOString() };
  const response = await postUsage(request("/api/usage", { method: "POST", bearer, body }));
  expect(response.status).toBe(201);
}

describe.skipIf(REAL_REDIS)("deleting an account", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("REGISTRATION", "invite"));
  afterEach(() => vi.unstubAllEnvs());

  it("leaves no key of the account or its own workspace, and nothing of it in any other value", async () => {
    const now = new Date();
    // Bob's world, before Alice signs up.
    const bob = await findOrCreateGithubUser({ id: 5353, login: "bob" }, now);
    const bobTenant = await createTenantFor(bob.userId, "Bob's", now);
    const bobCookie = (await withRequest(() => startUserSession(bob.userId, bobTenant, now))).split(";")[0]!;
    await report(await token(bobCookie, bobTenant, "bob's pc"), "bob-pc", "Home");
    const code = await createSignupCode(bob.userId, now);
    const before = snapshot();

    // Alice signs up with Bob's code and fills her own workspace.
    // A GitHub id long enough that no timestamp or hash in the store holds its digits by chance (4242 once did).
    const alice = await findOrCreateGithubUser({ id: ALICE_GITHUB_ID, login: "alicelogin" }, now);
    await consumeSignupCode(signupCodeHash(code.code), alice.userId, now);
    const aliceTenant = await createTenantFor(alice.userId, "Alice's", now);
    const cookie = (await withRequest(() => startUserSession(alice.userId, aliceTenant, now))).split(";")[0]!;
    const own = tenantStore(aliceTenant);
    const laptop = await token(cookie, aliceTenant, "alice laptop");
    await report(laptop, "alice-laptop", "AliceWork");
    await report(laptop, "alice-desk", "AliceHome");
    await saveOfficialUsage(own, { providerId: "claude", subLimitId: null, raw: "40", cycleStartMs: 0 }, now);
    await archiveCycle(own, "claude", {
      v: 1,
      start: now.getTime() - 14 * DAY,
      end: now.getTime() - 7 * DAY,
      total: 999,
      limit: null,
      official: 12,
      groups: { AliceWork: 999 },
      machines: 1,
      models: {},
      subLimits: {},
      archivedAt: now.getTime(),
    });
    await getRedis().set(
      own.keys.settings,
      JSON.stringify({ v: 1, alerts: { webhookUrl: "https://hooks.example.com/alice" } }),
    );
    expect((await createInvite(aliceTenant, alice.userId, "carol", now)).ok).toBe(true);
    const trashed = await deleteGroupRoute(
      request("/api/groups/AliceHome?force=1", { method: "DELETE", cookie, tenant: aliceTenant }),
      params({ group: "AliceHome" }),
    );
    expect(trashed.status).toBe(200);
    expect((await exportCycle(request("/api/export?format=json", { cookie }))).status).toBe(200);
    expect((await exportAccount(request("/api/account/export", { cookie }))).status).toBe(200);
    const ownKeys = [...snapshot().keys()].filter((key) => key.startsWith(own.keys.prefix));
    expect(ownKeys.length).toBeGreaterThan(10);

    // Alice in Bob's workspace: a token of hers, a report, a group she deletes.
    await addMember(bobTenant, alice.userId, bob.userId, now);
    expect(
      (await switchTenant(request("/api/session/tenant", { method: "POST", cookie, body: { tenantId: bobTenant } })))
        .status,
    ).toBe(200);
    await report(await token(cookie, bobTenant, "alice at bob's"), "shared-box", "Shared");
    const shared = await deleteGroupRoute(
      request("/api/groups/Shared?force=1", { method: "DELETE", cookie, tenant: bobTenant }),
      params({ group: "Shared" }),
    );
    expect(shared.status).toBe(200);

    const deleted = await deleteAccountRoute(request("/api/account", { method: "DELETE", cookie }));
    expect(await deleted.json()).toEqual({ ok: true, workspacesDeleted: 1, workspacesLeft: 1 });
    const after = snapshot();

    // Every key that is new since before Alice signed up is Bob's workspace's, or a security counter.
    const bobPrefix = tenantStore(bobTenant).keys.prefix;
    const added = [...after.keys()].filter((key) => !before.has(key));
    for (const key of added) {
      const counter = key.startsWith("usage:rl:") && after.get(key)!.ttl > 0 && after.get(key)!.ttl <= 86_400;
      expect(counter || key.startsWith(bobPrefix), key).toBe(true);
    }
    expect([...after.keys()].filter((key) => key.startsWith(own.keys.prefix))).toEqual([]);

    // Nothing of Alice's anywhere, but the record of her actions in Bob's workspace.
    const traces = [
      alice.userId,
      aliceTenant,
      "alicelogin",
      String(ALICE_GITHUB_ID),
      "alice-laptop",
      "alice-desk",
      "AliceWork",
      "AliceHome",
      "carol",
    ];
    for (const [key, { text }] of after) {
      if (key.startsWith(bobPrefix)) continue;
      const found = traces.filter((trace) => key.includes(trace) || text.includes(trace));
      const counter =
        key.startsWith("usage:rl:") && found.every((trace) => trace === aliceTenant || trace === alice.userId);
      if (!counter) expect(found, key).toEqual([]);
    }
    // In Bob's workspace: only as the "by" login and the token's "createdBy", never her own workspace's data.
    for (const [key, { text }] of after) {
      if (!key.startsWith(bobPrefix)) continue;
      expect(text, key).not.toMatch(new RegExp(`alice-laptop|alice-desk|AliceWork|AliceHome|${ALICE_GITHUB_ID}|carol`));
      expect(text.replaceAll('\\"by\\":\\"alicelogin\\"', ""), key).not.toContain("alicelogin");
      expect(text.replaceAll(`\\"createdBy\\":\\"${alice.userId}\\"`, ""), key).not.toContain(alice.userId);
    }
  });
});

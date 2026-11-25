import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as exportAccount } from "@/app/api/account/export/route";
import type { AccountExport } from "@/lib/account-export";
import { ACCOUNT_EXPORT_RATE_LIMIT_PER_USER } from "@/lib/config";
import { ingestReport } from "@/lib/ingest";
import { createInvite } from "@/lib/invites";
import { deleteGroup } from "@/lib/manage-store";
import { addMember } from "@/lib/members";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { sha256Hex } from "@/lib/security";
import { tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { createToken } from "@/lib/tokens";
import { saveOfficialUsage } from "@/lib/usage-store";
import { startUserSession } from "@/lib/user-session";
import { createTenantFor, findOrCreateGithubUser } from "@/lib/users";
import { REAL_REDIS, useRedis } from "../helpers/redis-fixture";
import { withRequest } from "../helpers/request";

/**
 * GET /api/account/export: the account, and every key of each workspace it
 * owns (checked against the store itself, so a key added to the layout later
 * is exported without anyone remembering to), but never a secret: no token,
 * token hash, invite hash, webhook URL or shared API token. A workspace it is
 * only a member of gives the membership and nothing of its data.
 */

const WEBHOOK = "https://hooks.example.com/services/T000/B000/abcdefghijklmnopqrstuvwxyz0123456789";

function request(cookie?: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/account/export", {
    headers: { host: "localhost", "x-forwarded-for": "203.0.113.9", ...(cookie && { cookie }), ...headers },
  });
}

async function signIn(githubId: number, login: string, tenantId?: TenantId) {
  const now = new Date();
  const { userId } = await findOrCreateGithubUser({ id: githubId, login }, now);
  const tenant = tenantId ?? (await createTenantFor(userId, `${login}'s`, now));
  const cookie = (await withRequest(() => startUserSession(userId, tenant, now))).split(";")[0]!;
  return { userId, tenantId: tenant, cookie };
}

async function seed(tenantId: TenantId, machineId: string, groupId: string): Promise<{ token: string }> {
  const store = tenantStore(tenantId);
  const now = new Date();
  const body = { machineId, groupId, providers: { claude: 10 }, timestamp: now.toISOString() };
  if (!(await ingestReport(store, body, now)).ok) throw new Error("report refused");
  const created = await createToken(store, "laptop", null, now);
  if (!created.ok) throw new Error("token refused");
  return { token: created.token };
}

describe.skipIf(REAL_REDIS)("GET /api/account/export", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("REGISTRATION", "invite"));
  afterEach(() => vi.unstubAllEnvs());

  it("answers 404 on a single-user instance and 401 without a session", async () => {
    expect((await exportAccount(request())).status).toBe(401);
    vi.stubEnv("REGISTRATION", "closed");
    expect((await exportAccount(request())).status).toBe(404);
  });

  it("exports every key of an owned workspace, and no secret", async () => {
    const alice = await signIn(4242, "alice");
    const bob = await signIn(5353, "bob");
    const store = tenantStore(alice.tenantId);
    const now = new Date();
    const { token } = await seed(alice.tenantId, "alice-laptop", "Work");
    const second = { machineId: "alice-desk", groupId: "Old", providers: { claude: 5 }, timestamp: now.toISOString() };
    await ingestReport(store, second, now);
    expect((await deleteGroup(store, "Old", true, now)).ok).toBe(true);
    await saveOfficialUsage(store, { providerId: "claude", subLimitId: null, raw: "40", cycleStartMs: 0 }, now);
    await getRedis().set(store.keys.settings, JSON.stringify({ v: 1, alerts: { webhookUrl: WEBHOOK } }));
    await getRedis().set(store.keys.apiToken, JSON.stringify({ v: 1, ct: "secret-ciphertext" }));
    const invite = await createInvite(alice.tenantId, alice.userId, "carol", now);
    if (!invite.ok) throw new Error("invite refused");
    // Alice is also a member of Bob's workspace, whose data is Bob's to export.
    await seed(bob.tenantId, "bob-secret-pc", "BobGroup");
    await addMember(bob.tenantId, alice.userId, bob.userId, now);

    const response = await exportAccount(request(alice.cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-disposition")).toMatch(
      /^attachment; filename="usageratio-export-alice-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const text = await response.text();
    const document = JSON.parse(text) as AccountExport;

    expect(document).toMatchObject({
      format: "usageratio-account-export",
      version: 1,
      account: { userId: alice.userId, login: "alice", identities: ["github:4242"] },
    });
    expect(document.account.sessions).toHaveLength(1);
    const owned = document.workspaces.find((workspace) => workspace.tenantId === alice.tenantId)!;
    const member = document.workspaces.find((workspace) => workspace.tenantId === bob.tenantId)!;
    expect(owned).toMatchObject({ role: "owner", name: "alice's" });
    expect(owned.data?.members).toEqual([{ login: "alice", role: "owner", joinedAt: expect.any(Number) }]);
    expect(owned.data?.invites).toEqual([
      { id: invite.entry.id, createdAt: expect.any(Number), expiresAt: expect.any(Number), login: "carol" },
    ]);
    expect(member).toEqual({ tenantId: bob.tenantId, name: "bob's", role: "member", joinedAt: expect.any(Number) });

    // Every key the workspace has, under its name without the prefix, but the three left out.
    const leftOut = [store.keys.apiToken, store.keys.registry, store.keys.tokensLock];
    const stored = getMemoryStoreForTests()!
      .keys()
      .filter((key) => key.startsWith(store.keys.prefix) && !leftOut.includes(key))
      .map((key) => key.slice(store.keys.prefix.length));
    expect(stored).toEqual(expect.arrayContaining(["settings", "events:claude:Work", "tokens", "trash", "official"]));
    expect(Object.keys(owned.data!.keys).sort()).toEqual(stored.sort());

    const keys = owned.data!.keys as Record<string, unknown>;
    expect(keys["events:claude:Work"]).toEqual([
      { member: expect.objectContaining({ m: "alice-laptop", t: 10 }), score: expect.any(Number) },
    ]);
    expect(Object.keys(keys.tokens as object)).toEqual([expect.stringMatching(/^tk_/)]);
    expect((keys.settings as { alerts: { webhookUrl: string } }).alerts.webhookUrl).toMatch(
      /^https:\/\/hooks\.example\.com\/…/,
    );

    expect(text).not.toContain(token);
    expect(text).not.toContain(sha256Hex(token));
    expect(text).not.toContain(WEBHOOK);
    expect(text).not.toContain("secret-ciphertext");
    expect(text).not.toContain(invite.code);
    expect(text).not.toContain("bob-secret-pc");
    expect(text).not.toContain("BobGroup");
  });

  it("gzips the body for a client that accepts it", async () => {
    const alice = await signIn(4242, "alice");
    await seed(alice.tenantId, "alice-laptop", "Work");
    const plain = await (await exportAccount(request(alice.cookie))).text();
    const zipped = await exportAccount(request(alice.cookie, { "accept-encoding": "br, gzip;q=0.8" }));
    expect(zipped.headers.get("content-encoding")).toBe("gzip");
    const body = JSON.parse(gunzipSync(Buffer.from(await zipped.arrayBuffer())).toString("utf8")) as AccountExport;
    expect({ ...body, generatedAt: "" }).toEqual({ ...(JSON.parse(plain) as AccountExport), generatedAt: "" });
  });

  it("limits each user to a few exports an hour", async () => {
    const alice = await signIn(4242, "alice");
    for (let i = 0; i < ACCOUNT_EXPORT_RATE_LIMIT_PER_USER; i++) {
      expect((await exportAccount(request(alice.cookie))).status).toBe(200);
    }
    const limited = await exportAccount(request(alice.cookie));
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe("rate_limited");
  });
});

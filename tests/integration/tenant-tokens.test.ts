import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as vaultAudit } from "@/app/api/api-token/audit/route";
import { POST as reveal } from "@/app/api/api-token/reveal/route";
import { GET as getVault, PUT as putVault } from "@/app/api/api-token/route";
import { POST as rotate } from "@/app/api/tokens/[id]/rotate/route";
import { DELETE as revoke } from "@/app/api/tokens/[id]/route";
import { GET as tokenAudit } from "@/app/api/tokens/audit/route";
import { POST as createTokenRoute, GET as listTokensRoute } from "@/app/api/tokens/route";
import { GET as getUsage } from "@/app/api/usage/route";
import { DELETE as removeMemberRoute } from "@/app/api/workspace/members/[userId]/route";
import type { AuditEntry } from "@/lib/api-token";
import { log } from "@/lib/log";
import { addMember } from "@/lib/members";
import { tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { createToken, listTokens } from "@/lib/tokens";
import { startUserSession } from "@/lib/user-session";
import { createTenantFor, findOrCreateGithubUser } from "@/lib/users";
import { useRedis } from "../helpers/redis-fixture";
import { withRequest } from "../helpers/request";
import { seedSession } from "../helpers/session";

/**
 * Machines and tokens per workspace (the design's F5): the shared master token
 * and its vault exist only on a single-user instance, and every use of the
 * master token there is logged, so the maintainer can tell when nothing relies
 * on it any more; new tokens carry the `ur_live_` prefix; a token can be
 * rotated in one step; and every token change lands on the workspace's audit
 * trail, in multi-tenant mode with the login of whoever did it.
 */

const ORIGIN = { origin: "http://localhost", host: "localhost" };
const MASTER = "0123456789abcdef0123456789abcdef";

interface Person {
  userId: string;
  tenantId: TenantId;
  cookie: string;
}

async function person(githubId: number, login: string, tenant?: TenantId): Promise<Person> {
  const now = new Date();
  const { userId } = await findOrCreateGithubUser({ id: githubId, login }, now);
  const tenantId = tenant ?? (await createTenantFor(userId, login, now));
  if (tenant) await addMember(tenant, userId, "u_owner", now);
  const header = await withRequest(() => startUserSession(userId, tenantId, now));
  return { userId, tenantId, cookie: header.split(";")[0]! };
}

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

function call(
  handler: Handler,
  path: string,
  init: { method?: string; cookie?: string; tenant?: string; bearer?: string; body?: unknown; params?: object } = {},
): Promise<Response> {
  const request = new Request(`http://localhost${path}`, {
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
  return handler(request, { params: Promise.resolve((init.params ?? {}) as Record<string, string>) });
}

async function trail(cookie: string): Promise<AuditEntry[]> {
  const response = await call(tokenAudit as Handler, "/api/tokens/audit", { cookie });
  return ((await response.json()) as { entries: AuditEntry[] }).entries;
}

describe("tokens per workspace", () => {
  useRedis();
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("on a single-user instance", () => {
    beforeEach(() => {
      vi.stubEnv("DASHBOARD_PIN", "12345");
      vi.stubEnv("USAGE_API_TOKEN", MASTER);
    });

    it("logs every use of the shared master token, and still lets it in", async () => {
      const info = vi.spyOn(log, "info");
      const response = await call(getUsage as Handler, "/api/usage", { bearer: MASTER });
      expect(response.status).toBe(200);
      expect(info).toHaveBeenCalledWith("api.master_token_used", { route: "api/usage" });
    });

    it("issues ur_live_ tokens, rotates one in a step, and puts every change on the trail", async () => {
      const cookie = await seedSession("12345");
      const { getRedis } = await import("@/lib/redis");
      const { sha256Hex } = await import("@/lib/security");
      await getRedis().set(`usage:session:${sha256Hex(`${cookie.split("=")[1]}:12345`)}:sudo`, "1", { ex: 300 });

      const created = await call(createTokenRoute as Handler, "/api/tokens", {
        method: "POST",
        cookie,
        body: { label: "Office laptop", machineId: "laptop" },
      });
      expect(created.status).toBe(201);
      const first = (await created.json()) as { id: string; token: string };
      expect(first.token).toMatch(/^ur_live_[A-Za-z0-9_-]{43}$/);

      const rotated = await call(rotate as Handler, "/api/tokens/x/rotate", {
        method: "POST",
        cookie,
        params: { id: first.id },
      });
      expect(rotated.status).toBe(200);
      const second = (await rotated.json()) as { id: string; token: string };
      expect(second.id).not.toBe(first.id);

      // The old secret stops working at once; the new one works, for the same machine.
      expect((await call(getUsage as Handler, "/api/usage", { bearer: first.token })).status).toBe(401);
      expect((await call(getUsage as Handler, "/api/usage", { bearer: second.token })).status).toBe(200);
      const tokens = await listTokens(tenantStore("default" as TenantId));
      expect(tokens.find((token) => token.id === second.id)).toMatchObject({
        label: "Office laptop",
        machineId: "laptop",
      });
      // A revoked token cannot be rotated again.
      const again = await call(rotate as Handler, "/api/tokens/x/rotate", {
        method: "POST",
        cookie,
        params: { id: first.id },
      });
      expect(again.status).toBe(409);

      expect(
        (await call(revoke as Handler, "/api/tokens/x", { method: "DELETE", cookie, params: { id: second.id } }))
          .status,
      ).toBe(200);
      // Revoking twice is fine, and is not written twice.
      await call(revoke as Handler, "/api/tokens/x", { method: "DELETE", cookie, params: { id: second.id } });

      const entries = await trail(cookie);
      expect(entries.map((entry) => [entry.action, entry.token?.id, entry.token?.replacement, entry.by])).toEqual([
        ["token_revoked", second.id, undefined, null],
        ["token_rotated", first.id, second.id, null],
        ["token_created", first.id, undefined, null],
      ]);
      // The trail never holds a secret.
      expect(JSON.stringify(entries)).not.toContain("ur_live_");
    });
  });

  describe("in multi-tenant mode", () => {
    beforeEach(() => {
      vi.stubEnv("REGISTRATION", "invite");
      vi.stubEnv("USAGE_API_TOKEN", MASTER);
    });

    it("ignores the shared master token, saying so once, and has no vault", async () => {
      const warn = vi.spyOn(log, "warn");
      const owner = await person(1, "alice");
      expect((await call(getUsage as Handler, "/api/usage", { bearer: MASTER })).status).toBe(401);
      await call(getUsage as Handler, "/api/usage", { bearer: MASTER });
      expect(warn.mock.calls.filter(([msg]) => msg === "api.master_token_ignored")).toHaveLength(1);

      const session = { cookie: owner.cookie, tenant: owner.tenantId };
      for (const response of [
        await call(getVault as Handler, "/api/api-token", session),
        await call(putVault as Handler, "/api/api-token", { ...session, method: "PUT", body: { token: MASTER } }),
        await call(reveal as Handler, "/api/api-token/reveal", { ...session, method: "POST" }),
        await call(vaultAudit as Handler, "/api/api-token/audit", session),
      ]) {
        expect(response.status).toBe(404);
      }
    });

    it("names who changed a token, the owner's removal of a member's tokens included", async () => {
      const owner = await person(1, "alice");
      const member = await person(2, "bob-dev", owner.tenantId);
      const store = tenantStore(owner.tenantId);

      const created = await call(createTokenRoute as Handler, "/api/tokens", {
        method: "POST",
        cookie: member.cookie,
        tenant: member.tenantId,
        body: { label: "bob's box", machineId: "bob-box" },
      });
      expect(created.status).toBe(201);
      const removed = await call(removeMemberRoute as Handler, "/api/workspace/members/x?revokeTokens=1", {
        method: "DELETE",
        cookie: owner.cookie,
        tenant: owner.tenantId,
        params: { userId: member.userId },
      });
      expect(await removed.json()).toEqual({ ok: true, tokensRevoked: 1 });

      const entries = await trail(owner.cookie);
      expect(entries.map((entry) => [entry.action, entry.token?.label, entry.by])).toEqual([
        ["token_revoked", "bob's box", "alice"],
        ["token_created", "bob's box", "bob-dev"],
      ]);
      const listed = (await (
        await call(listTokensRoute as Handler, "/api/tokens", { cookie: owner.cookie })
      ).json()) as {
        tokens: { revokedAt: number | null }[];
      };
      expect(listed.tokens[0]?.revokedAt).not.toBeNull();
      expect((await listTokens(store))[0]?.createdBy).toBe(member.userId);
    });

    it("keeps the token history to the owner, and a rotated token with the member who made it", async () => {
      const owner = await person(1, "alice");
      const member = await person(2, "bob-dev", owner.tenantId);
      const created = await call(createTokenRoute as Handler, "/api/tokens", {
        method: "POST",
        cookie: member.cookie,
        tenant: member.tenantId,
        body: { label: "bob's box", machineId: "bob-box" },
      });
      const { id } = (await created.json()) as { id: string };
      const history = await call(tokenAudit as Handler, "/api/tokens/audit", { cookie: member.cookie });
      expect(history.status).toBe(403);

      // The owner rotates bob's token: it still counts as bob's, so removing bob with his tokens
      // reaches the replacement too.
      const rotated = await call(rotate as Handler, "/api/tokens/x/rotate", {
        method: "POST",
        cookie: owner.cookie,
        tenant: owner.tenantId,
        params: { id },
      });
      expect(rotated.status).toBe(200);
      const removed = await call(removeMemberRoute as Handler, "/api/workspace/members/x?revokeTokens=1", {
        method: "DELETE",
        cookie: owner.cookie,
        tenant: owner.tenantId,
        params: { userId: member.userId },
      });
      expect(await removed.json()).toEqual({ ok: true, tokensRevoked: 1 });
      expect((await listTokens(tenantStore(owner.tenantId))).every((token) => token.revokedAt !== null)).toBe(true);
    });

    it("lets one revoke or rotate run at a time, so a token is never left live after both", async () => {
      const owner = await person(1, "alice");
      const store = tenantStore(owner.tenantId);
      const created = await createToken(store, "laptop", null, new Date());
      if (!created.ok) throw new Error("unreachable");
      const { getRedis } = await import("@/lib/redis");
      await getRedis().set(store.keys.tokensLock, "someone", { ex: 10 });
      const session = { cookie: owner.cookie, tenant: owner.tenantId, params: { id: created.id } };
      for (const response of [
        await call(rotate as Handler, "/api/tokens/x/rotate", { ...session, method: "POST" }),
        await call(revoke as Handler, "/api/tokens/x", { ...session, method: "DELETE" }),
      ]) {
        expect([response.status, ((await response.json()) as { error: string }).error]).toEqual([409, "tokens_busy"]);
      }
      expect((await listTokens(store)).map((token) => token.revokedAt)).toEqual([null]);
    });

    it("keeps an older token's own id when its workspace issues more", async () => {
      // Tokens issued before the prefix existed still authenticate: the lookup is by hash.
      const owner = await person(1, "alice");
      const store = tenantStore(owner.tenantId);
      const { getRedis } = await import("@/lib/redis");
      const { GLOBAL_KEYS } = await import("@/lib/redis-keys");
      const { hashToken } = await import("@/lib/tokens");
      const legacy = `ur_${"x".repeat(43)}`;
      await getRedis().hset(store.keys.tokens, {
        [hashToken(legacy)]: JSON.stringify({ id: "tk_LEGACY01", label: "old", machineId: null, createdAt: 1 }),
      });
      await getRedis().hset(GLOBAL_KEYS.tokenIndex, { [hashToken(legacy)]: owner.tenantId });
      expect((await call(getUsage as Handler, "/api/usage", { bearer: legacy })).status).toBe(200);
      expect((await createToken(store, "new", null, new Date())).ok).toBe(true);
    });
  });
});

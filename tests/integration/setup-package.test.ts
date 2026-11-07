import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getSetup, POST as postSetup } from "@/app/api/setup/route";
import { GET as getUsage } from "@/app/api/usage/route";
import { getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { sha256Hex } from "@/lib/security";
import { tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { listTokens, tokenTenant } from "@/lib/tokens";
import { startUserSession } from "@/lib/user-session";
import { createTenantFor, findOrCreateGithubUser } from "@/lib/users";
import en from "@/messages/en.json";
import { useRedis } from "../helpers/redis-fixture";
import { withRequest } from "../helpers/request";
import { readZip } from "../read-zip";

/**
 * The setup package in multi-tenant mode: there is no shared token to type,
 * so POST /api/setup issues the machine's own (bound to it, on the audit
 * trail, sudo first) and writes it into the package's config. The token it
 * carries reports into that workspace and nowhere else.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as "Setup" }),
}));

const ORIGIN = { origin: "http://localhost", host: "localhost" };

interface Person {
  tenantId: TenantId;
  cookie: string;
}

async function person(): Promise<Person> {
  const now = new Date();
  const { userId } = await findOrCreateGithubUser({ id: 1, login: "alice" }, now);
  const tenantId = await createTenantFor(userId, "alice", now);
  const header = await withRequest(() => startUserSession(userId, tenantId, now));
  return { tenantId, cookie: header.split(";")[0]! };
}

function post(as: Person, body: unknown): Promise<Response> {
  return postSetup(
    new Request("http://localhost/api/setup", {
      method: "POST",
      headers: {
        ...ORIGIN,
        cookie: as.cookie,
        "x-usageratio-tenant": as.tenantId,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

const PACKAGE = { os: "linux", mode: "auto", group: "Work", machine: "studio", locale: "en" };

describe("the setup package in multi-tenant mode", () => {
  useRedis();
  beforeEach(() => {
    vi.stubEnv("REGISTRATION", "invite");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.test");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("carries a fresh token bound to the machine, which reports into this workspace", async () => {
    const alice = await person();
    const response = await post(alice, PACKAGE);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const files = new Map(readZip(new Uint8Array(await response.arrayBuffer())).map((entry) => [entry.name, entry]));
    const config = files.get("config")!.data.toString("utf8");
    const token = /API_TOKEN="(ur_live_[A-Za-z0-9_-]{43})"/.exec(config)?.[1];
    expect(token).toBeDefined();
    expect(config).toContain('API_URL="https://app.example.test/api/usage"');
    expect(files.get("README.txt")!.data.toString("utf8")).toContain("This package holds a secret");

    const [issued] = await listTokens(tenantStore(alice.tenantId));
    expect(issued).toMatchObject({ label: "studio (setup)", machineId: "studio", scope: "ingest", revokedAt: null });
    expect(await tokenTenant(token!)).toBe(alice.tenantId);
    const trail = (await getRedis().lrange(tenantStore(alice.tenantId).keys.tokensAudit, 0, -1)) as unknown[];
    expect(JSON.parse(String(trail[0]))).toMatchObject({ a: "token_created", tk: issued!.id, by: "alice" });

    const usage = await getUsage(
      new Request("http://localhost/api/usage", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(usage.status).toBe(200);
  });

  it("needs a named machine and a fresh sign-in, and is only a POST here", async () => {
    const alice = await person();
    expect((await post(alice, { ...PACKAGE, machine: "" })).status).toBe(400);
    expect((await post(alice, { ...PACKAGE, os: "plan9" })).status).toBe(400);

    const key = GLOBAL_KEYS.userSession(sha256Hex(alice.cookie.split("=")[1]!));
    const record = JSON.parse(String(await getRedis().get(key)));
    await getRedis().set(key, JSON.stringify({ ...record, a: 0 }), { keepTtl: true });
    const noSudo = await post(alice, PACKAGE);
    expect([noSudo.status, ((await noSudo.json()) as { error: string }).error]).toEqual([403, "sudo_required"]);
    expect(await listTokens(tenantStore(alice.tenantId))).toEqual([]);

    const get = await getSetup(
      new Request("http://localhost/api/setup?os=linux&mode=auto&group=Work&machine=studio", {
        headers: { ...ORIGIN, cookie: alice.cookie },
      }),
    );
    expect(get.status).toBe(404);
  });

  it("is not there on a single-user instance, whose GET package carries no secret", async () => {
    const alice = await person();
    vi.stubEnv("REGISTRATION", "closed");
    expect((await post(alice, PACKAGE)).status).toBe(404);
  });
});

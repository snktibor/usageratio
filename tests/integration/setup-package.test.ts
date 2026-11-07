import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getSetup, POST as postSetup } from "@/app/api/setup/route";
import { POST as postTokens } from "@/app/api/tokens/route";
import { GET as getUsage } from "@/app/api/usage/route";
import { tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { listTokens } from "@/lib/tokens";
import { startUserSession } from "@/lib/user-session";
import { createTenantFor, findOrCreateGithubUser } from "@/lib/users";
import en from "@/messages/en.json";
import { useRedis } from "../helpers/redis-fixture";
import { withRequest } from "../helpers/request";
import { readZip } from "../read-zip";

/**
 * The setup package in multi-tenant mode: there is no shared token to type,
 * so the page issues the machine's own (POST /api/tokens: sudo, the audit
 * trail) and POST /api/setup writes it into the package's config, but only
 * the workspace's own live ingest token for that very machine.
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

async function person(githubId = 1, login = "alice"): Promise<Person> {
  const now = new Date();
  const { userId } = await findOrCreateGithubUser({ id: githubId, login }, now);
  const tenantId = await createTenantFor(userId, login, now);
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

async function issue(as: Person, machineId: string, scope = "ingest"): Promise<string> {
  const response = await postTokens(
    new Request("http://localhost/api/tokens", {
      method: "POST",
      headers: { ...ORIGIN, cookie: as.cookie, "x-usageratio-tenant": as.tenantId, "content-type": "application/json" },
      // A read token takes no machine: it reports nothing.
      body: JSON.stringify({ label: `${machineId} (setup)`, scope, ...(scope !== "read" && { machineId }) }),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

describe("the setup package in multi-tenant mode", () => {
  useRedis();
  beforeEach(() => {
    vi.stubEnv("REGISTRATION", "invite");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.test");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("carries the machine's own token, which reports into this workspace", async () => {
    const alice = await person();
    const token = await issue(alice, "studio");
    const response = await post(alice, { ...PACKAGE, token });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    const files = new Map(readZip(new Uint8Array(await response.arrayBuffer())).map((entry) => [entry.name, entry]));
    const config = files.get("config")!.data.toString("utf8");
    expect(config).toContain(`API_TOKEN="${token}"`);
    expect(config).toContain('API_URL="https://app.example.test/api/usage"');
    expect(files.get("README.txt")!.data.toString("utf8")).toContain("This package holds a secret");
    // The package itself issues nothing: one token, the one the page asked for.
    expect(await listTokens(tenantStore(alice.tenantId))).toHaveLength(1);

    const usage = await getUsage(
      new Request("http://localhost/api/usage", { headers: { authorization: `Bearer ${token}` } }),
    );
    expect(usage.status).toBe(200);
  });

  it("takes only this workspace's live ingest token for this very machine", async () => {
    const alice = await person();
    const other = await person(2, "bob");
    const forStudio = await issue(alice, "studio");
    const forLaptop = await issue(alice, "laptop");
    const readOnly = await issue(alice, "studio", "read");
    const bobs = await issue(other, "studio");
    for (const token of [forLaptop, readOnly, bobs, "ur_live_made-up"]) {
      const response = await post(alice, { ...PACKAGE, token });
      expect([token, response.status]).toEqual([token, 400]);
    }
    const [studio] = (await listTokens(tenantStore(alice.tenantId))).filter(
      (entry) => entry.machineId === "studio" && entry.scope === "ingest",
    );
    const { revokeToken } = await import("@/lib/tokens");
    await revokeToken(tenantStore(alice.tenantId), studio!.id, new Date());
    expect((await post(alice, { ...PACKAGE, token: forStudio })).status).toBe(400);
    expect((await post(alice, { ...PACKAGE, machine: "", token: forStudio })).status).toBe(400);
  });

  it("is only a POST here, and not there on a single-user instance", async () => {
    const alice = await person();
    const get = await getSetup(
      new Request("http://localhost/api/setup?os=linux&mode=auto&group=Work&machine=studio", {
        headers: { ...ORIGIN, cookie: alice.cookie },
      }),
    );
    expect(get.status).toBe(404);
    vi.stubEnv("REGISTRATION", "closed");
    expect((await post(alice, PACKAGE)).status).toBe(404);
  });
});

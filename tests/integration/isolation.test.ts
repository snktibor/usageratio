import { readdirSync } from "node:fs";
import path from "node:path";
import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ingestReport } from "@/lib/ingest";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { sha256Hex } from "@/lib/security";
import { type TenantStore, tenantStore } from "@/lib/tenant";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";
import { createToken, type TokenScope } from "@/lib/tokens";
import { archiveCycle, saveOfficialUsage } from "@/lib/usage-store";
import en from "@/messages/en.json";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

/**
 * The tenant isolation matrix: every route under app/api, called by tenant A
 * (the default tenant: its PIN session, with sudo, and its tokens), while
 * tenant B holds data marked "bsecret" everywhere it can be. For every call:
 * nothing of B appears in the response, and B's keys are byte for byte what
 * they were. Calls that name B's machines, groups or tokens find nothing.
 * Then B's own tokens are used the other way round: they reach B's data only,
 * and leave A's untouched.
 *
 * A route that is added under app/api without a row in CASES fails the test.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as "Alerts" }),
}));

const ROOT = path.resolve(__dirname, "../..");
const PIN = "12345";
const MASTER = "0123456789abcdef0123456789abcdef";
const CRON = "cron-secret-0123456789";
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("hex");
const B = "BBBBBBBBBBBBBBBBBBBBBB" as TenantId;
const MARKER = "bsecret";
/**
 * What only B has: its machines, its token labels, its webhook. (Some calls below write B's group
 * name into A on purpose, to try a colliding id, so the group name alone proves nothing.)
 */
const LEAKS = [
  `${MARKER}-host`,
  `${MARKER}-box`,
  `${MARKER} ingest`,
  `${MARKER} read`,
  `${MARKER} official`,
  `example.com/${MARKER}`,
];

type Auth = "none" | "session" | "sudo" | "master" | "ingest" | "read" | "official" | "cron";

interface Case {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth: Auth;
  body?: unknown;
  params?: Record<string, string>;
  /** Housekeeping walks every tenant by design: B's own housekeeping may write B's keys. */
  touchesEveryTenant?: boolean;
  /** The call names one of B's records: it must not find it. */
  expectNotFound?: boolean;
}

interface World {
  a: TenantStore;
  b: TenantStore;
  cookie: string;
  aTokens: Record<TokenScope, string>;
  bTokens: Record<TokenScope, string> & { id: string };
}

const now = () => new Date();

const usageBody = (machineId: string, groupId: string) => ({
  machineId,
  groupId,
  providers: { claude: 1234 },
  timestamp: now().toISOString(),
});

/** A whole settings document that also tries to remove B's group (from A, where it does not exist). */
const settingsUpdate = {
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
  groups: [],
  removedGroups: [`${MARKER}-group`],
};

function cases(world: World): Record<string, Case[]> {
  const official = {
    providerId: "claude",
    usedPercent: 41.5,
    resetsAtMs: now().getTime() + 86_400_000,
    observedAtMs: now().getTime() - 60_000,
  };
  return {
    "alerts/test": [
      {
        method: "POST",
        path: "/api/alerts/test",
        auth: "session",
        body: { webhookUrl: "https://hooks.example.com/a", format: "generic", locale: "en" },
      },
    ],
    "api-token/audit": [{ method: "GET", path: "/api/api-token/audit", auth: "session" }],
    "api-token/reveal": [{ method: "POST", path: "/api/api-token/reveal", auth: "sudo" }],
    "api-token": [
      { method: "GET", path: "/api/api-token", auth: "session" },
      { method: "PUT", path: "/api/api-token", auth: "session", body: { token: MASTER } },
    ],
    "auth/sudo": [
      { method: "GET", path: "/api/auth/sudo", auth: "session" },
      { method: "POST", path: "/api/auth/sudo", auth: "session", body: { pin: PIN } },
    ],
    // Multi-tenant mode only: on this single-user instance these answer 404 and touch nothing.
    account: [
      { method: "GET", path: "/api/account", auth: "session" },
      { method: "DELETE", path: "/api/account", auth: "sudo" },
    ],
    "account/sessions": [{ method: "DELETE", path: "/api/account/sessions", auth: "session" }],
    admin: [{ method: "GET", path: "/api/admin", auth: "session" }],
    "admin/signup-codes": [{ method: "POST", path: "/api/admin/signup-codes", auth: "session" }],
    "admin/signup-codes/[id]": [
      { method: "DELETE", path: "/api/admin/signup-codes/x", auth: "session", params: { id: "sc_AAAAAAAA" } },
    ],
    "admin/tenants/[id]": [
      {
        method: "PATCH",
        path: "/api/admin/tenants/x",
        auth: "session",
        params: { id: B },
        body: { status: "disabled" },
        expectNotFound: true,
      },
    ],
    "auth/github/start": [
      { method: "POST", path: "/api/auth/github/start", auth: "session", body: { purpose: "login" } },
    ],
    "auth/github/callback": [{ method: "GET", path: "/api/auth/github/callback?code=x&state=y", auth: "none" }],
    "cron/housekeeping": [{ method: "GET", path: "/api/cron/housekeeping", auth: "cron", touchesEveryTenant: true }],
    "csp-report": [
      { method: "POST", path: "/api/csp-report", auth: "none", body: { "csp-report": { "document-uri": "x" } } },
    ],
    export: [
      { method: "GET", path: "/api/export?format=json&cycle=current", auth: "session" },
      { method: "GET", path: "/api/export?format=csv&cycle=previous", auth: "session" },
    ],
    "groups/[group]": [
      {
        method: "PATCH",
        path: "/api/groups/x",
        auth: "sudo",
        params: { group: `${MARKER}-group` },
        body: { id: "renamed" },
        expectNotFound: true,
      },
      {
        method: "DELETE",
        path: "/api/groups/x?force=1",
        auth: "sudo",
        params: { group: `${MARKER}-group` },
        expectNotFound: true,
      },
      {
        method: "PATCH",
        path: "/api/groups/x",
        auth: "sudo",
        params: { group: "Personal" },
        body: { id: `${MARKER}-group`, merge: true },
      },
    ],
    health: [{ method: "GET", path: "/api/health", auth: "none" }],
    housekeeping: [
      { method: "POST", path: "/api/housekeeping?dryRun=1", auth: "session" },
      { method: "POST", path: "/api/housekeeping", auth: "sudo" },
    ],
    "machines/[provider]/[machine]": [
      {
        method: "PATCH",
        path: "/api/machines/x/y",
        auth: "sudo",
        params: { provider: "claude", machine: `${MARKER}-host` },
        body: { id: "stolen" },
        expectNotFound: true,
      },
      {
        method: "DELETE",
        path: "/api/machines/x/y",
        auth: "sudo",
        params: { provider: "claude", machine: `${MARKER}-host` },
        expectNotFound: true,
      },
      {
        method: "PATCH",
        path: "/api/machines/x/y",
        auth: "sudo",
        params: { provider: "claude", machine: "a-host" },
        body: { group: `${MARKER}-group` },
      },
    ],
    "machines/prune": [{ method: "POST", path: "/api/machines/prune", auth: "sudo" }],
    machines: [{ method: "GET", path: "/api/machines", auth: "session" }],
    "official-usage/archived": [
      {
        method: "PUT",
        path: "/api/official-usage/archived",
        auth: "session",
        body: { providerId: "claude", cycleStartMs: 0, raw: "50" },
      },
    ],
    "official-usage/report": [{ method: "POST", path: "/api/official-usage/report", auth: "official", body: official }],
    "official-usage": [
      {
        method: "PUT",
        path: "/api/official-usage",
        auth: "session",
        body: { providerId: "claude", subLimitId: null, raw: "33", cycleStartMs: 0 },
      },
    ],
    "providers/[provider]": [
      { method: "DELETE", path: "/api/providers/x?force=1", auth: "sudo", params: { provider: "openai" } },
    ],
    resets: [
      {
        method: "POST",
        path: "/api/resets",
        auth: "session",
        body: { providerId: "claude", atMs: Math.floor(now().getTime() / 60_000) * 60_000 - 60_000 },
      },
      { method: "PUT", path: "/api/resets", auth: "session", body: { providerId: "claude", id: "nope" } },
      { method: "DELETE", path: "/api/resets", auth: "session", body: { providerId: "claude", id: "nope" } },
    ],
    settings: [
      { method: "GET", path: "/api/settings", auth: "session" },
      { method: "PUT", path: "/api/settings", auth: "session", body: settingsUpdate },
    ],
    setup: [{ method: "GET", path: "/api/setup?os=macos&mode=auto&group=Personal&machine=a-host", auth: "session" }],
    status: [{ method: "GET", path: "/api/status", auth: "read" }],
    "tokens/[id]": [
      { method: "DELETE", path: "/api/tokens/x", auth: "sudo", params: { id: world.bTokens.id }, expectNotFound: true },
    ],
    tokens: [
      { method: "GET", path: "/api/tokens", auth: "session" },
      { method: "POST", path: "/api/tokens", auth: "sudo", body: { label: "new", machineId: "a-host" } },
    ],
    usage: [
      { method: "GET", path: "/api/usage", auth: "ingest" },
      { method: "POST", path: "/api/usage", auth: "ingest", body: usageBody("a-host", "Personal") },
      { method: "POST", path: "/api/usage", auth: "master", body: usageBody("a-host", `${MARKER}-group`) },
    ],
  };
}

/** Every route file under app/api, as its path below it ("tokens/[id]"). */
function routeIds(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (entry.name === "route.ts") found.push(path.posix.dirname(relative).slice("app/api/".length));
    }
  };
  walk("app/api");
  return found.sort();
}

async function seedTenant(store: TenantStore, prefix: string): Promise<Record<TokenScope, string> & { id: string }> {
  const at = now();
  for (const body of [
    usageBody(`${prefix}-host`, `${prefix}-group`),
    { ...usageBody(`${prefix}-box`, "Personal"), providers: { claude: 50, openai: 20 } },
  ]) {
    const result = await ingestReport(store, body, at);
    if (!result.ok) throw new Error(`seed failed: ${JSON.stringify(result)}`);
  }
  await archiveCycle(store, "claude", {
    v: 1,
    start: at.getTime() - 14 * 86_400_000,
    end: at.getTime() - 7 * 86_400_000,
    total: 999,
    limit: null,
    official: 12,
    groups: { [`${prefix}-group`]: 999 },
    machines: 1,
    models: {},
    subLimits: {},
    archivedAt: at.getTime(),
  });
  await saveOfficialUsage(store, { providerId: "claude", subLimitId: null, raw: "40", cycleStartMs: 0 }, at);
  const tokens = {} as Record<TokenScope, string> & { id: string };
  for (const scope of ["ingest", "read", "official"] as const) {
    const created = await createToken(store, `${prefix} ${scope} token`, null, at, scope);
    if (!created.ok) throw new Error("token not created");
    tokens[scope] = created.token;
    tokens.id = created.id;
  }
  return tokens;
}

/** Everything of B's in the store: its own keys, and its entries in the shared token index. */
function snapshotOf(store: TenantStore): string {
  const dump = getMemoryStoreForTests()!.dump();
  const own = Object.entries(dump).filter(([key]) => key.startsWith(store.keys.prefix));
  const index = Object.entries((dump[GLOBAL_KEYS.tokenIndex]?.value ?? {}) as Record<string, string>).filter(
    ([, tenantId]) => tenantId === store.tenantId,
  );
  return JSON.stringify({ own, index });
}

/** Everything of the default tenant's: every key without a `t:` prefix, but the rate limits and the session. */
function defaultSnapshot(): string {
  const dump = getMemoryStoreForTests()!.dump();
  const own = Object.entries(dump).filter(
    ([key]) => !key.startsWith("t:") && !key.startsWith("usage:rl:") && !key.startsWith("usage:session:"),
  );
  const index = Object.entries((dump[GLOBAL_KEYS.tokenIndex]?.value ?? {}) as Record<string, string>).filter(
    ([, tenantId]) => tenantId === DEFAULT_TENANT,
  );
  return JSON.stringify({ own: own.filter(([key]) => key !== GLOBAL_KEYS.tokenIndex), index });
}

async function call(world: World, route: string, testCase: Case, token?: string): Promise<Response> {
  const module = (await import(`@/app/api/${route}/route`)) as Record<
    string,
    (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>
  >;
  const handler = module[testCase.method];
  if (!handler) throw new Error(`${route} has no ${testCase.method}`);

  const headers: Record<string, string> = { origin: "http://localhost", host: "localhost" };
  if (testCase.body !== undefined) headers["content-type"] = "application/json";
  if (testCase.auth === "session" || testCase.auth === "sudo") headers.cookie = world.cookie;
  const bearer =
    token ??
    {
      master: MASTER,
      cron: CRON,
      ingest: world.aTokens.ingest,
      read: world.aTokens.read,
      official: world.aTokens.official,
      none: undefined,
      session: undefined,
      sudo: undefined,
    }[testCase.auth];
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  const request = new Request(`http://localhost${testCase.path}`, {
    method: testCase.method,
    headers,
    ...(testCase.body !== undefined && { body: JSON.stringify(testCase.body) }),
  });
  return handler(request, { params: Promise.resolve(testCase.params ?? {}) });
}

describe("tenant isolation, route by route", () => {
  const redis = useRedis();
  let world: World;

  beforeEach(async () => {
    vi.stubEnv("DASHBOARD_PIN", PIN);
    vi.stubEnv("USAGE_API_TOKEN", MASTER);
    vi.stubEnv("CRON_SECRET", CRON);
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", ENCRYPTION_KEY);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    const a = tenantStore(DEFAULT_TENANT);
    const b = tenantStore(B);
    const aTokens = await seedTenant(a, "a");
    const bTokens = await seedTenant(b, MARKER);
    await getRedis().set(
      b.keys.settings,
      JSON.stringify({ v: 1, alerts: { webhookUrl: `https://hooks.example.com/${MARKER}` } }),
    );
    const cookie = await seedSession(PIN);
    await getRedis().set(`${GLOBAL_KEYS.pinSession(sha256Hex(`${cookie.split("=")[1]}:${PIN}`))}:sudo`, "1", {
      ex: 300,
    });
    world = { a, b, cookie, aTokens, bTokens };
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("has a row for every route under app/api", () => {
    const covered = Object.keys(cases({ bTokens: { id: "x" } } as World)).sort();
    expect(covered).toEqual(routeIds());
  });

  it("never shows tenant A anything of B's, and never changes B's data", async () => {
    if (!redis.store) return; // the snapshots read the memory store's own dump
    const failures: string[] = [];
    for (const [route, list] of Object.entries(cases(world))) {
      for (const testCase of list) {
        const label = `${testCase.method} ${route} ${JSON.stringify(testCase.params ?? {})} (${testCase.auth})`;
        const before = snapshotOf(world.b);
        const response = await call(world, route, testCase);
        const text = await response.text();
        const leaked = LEAKS.filter((marker) => text.includes(marker));
        if (leaked.length > 0)
          failures.push(`${label}: response mentions B: ${leaked.join(", ")} (${response.status})`);
        if (!testCase.touchesEveryTenant && snapshotOf(world.b) !== before) failures.push(`${label}: changed B's data`);
        if (testCase.expectNotFound && response.status !== 404) {
          failures.push(`${label}: expected 404 for B's record, got ${response.status}`);
        }
        if (response.status >= 500) failures.push(`${label}: ${response.status} ${text.slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("gives B's own tokens B's data only, and leaves A's untouched", async () => {
    if (!redis.store) return;
    const aBefore = defaultSnapshot();

    const status = await call(
      world,
      "status",
      { method: "GET", path: "/api/status", auth: "read" },
      world.bTokens.read,
    );
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(statusText).not.toContain("a-host");
    expect(statusText).not.toContain("a-group");

    const cycle = await call(
      world,
      "usage",
      { method: "GET", path: "/api/usage", auth: "ingest" },
      world.bTokens.ingest,
    );
    expect(cycle.status).toBe(200);

    const posted = await call(
      world,
      "usage",
      { method: "POST", path: "/api/usage", auth: "ingest", body: usageBody(`${MARKER}-host`, `${MARKER}-group`) },
      world.bTokens.ingest,
    );
    expect(posted.status).toBeLessThan(300);
    const reported = await call(
      world,
      "official-usage/report",
      {
        method: "POST",
        path: "/api/official-usage/report",
        auth: "official",
        body: {
          providerId: "claude",
          usedPercent: 10,
          resetsAtMs: now().getTime() + 86_400_000,
          observedAtMs: now().getTime() - 60_000,
        },
      },
      world.bTokens.official,
    );
    expect(reported.status).toBeLessThan(300);

    expect(defaultSnapshot()).toBe(aBefore);
    // B's report landed in B.
    expect(await getRedis().hexists(world.b.keys.machines, `claude:${MARKER}-host`)).toBe(1);
    expect(await getRedis().hexists(world.a.keys.machines, `claude:${MARKER}-host`)).toBe(0);
  });
});

import { readdirSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { ingestReport } from "@/lib/ingest";
import { deleteGroup } from "@/lib/manage-store";
import { getMemoryStoreForTests, getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { sha256Hex } from "@/lib/security";
import { type TenantStore, tenantStore } from "@/lib/tenant";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";
import { serializeTenantRecord } from "@/lib/tenants";
import { createToken, type TokenScope } from "@/lib/tokens";
import { archiveCycle, saveOfficialUsage } from "@/lib/usage-store";
import { startUserSession } from "@/lib/user-session";
import { addOwner, findOrCreateGithubUser } from "@/lib/users";
import { setWebhookTransportForTests } from "@/lib/webhook-send";
import { withRequest } from "./request";
import { seedSession } from "./session";

/**
 * The world the tenant isolation tests (tests/integration/isolation.test.ts,
 * isolation-fuzz.test.ts) run in, and the matrix of calls they make.
 *
 * Two tenants, seeded alike: A (the default tenant on a single-user "closed"
 * instance; a workspace of its own in "multi" mode) and B. Each holds data
 * marked with its own secret prefix (`asecret`, `bsecret`) everywhere it can
 * be: machines, token labels, a webhook, an invite, a trashed group.
 * `cases()` lists every route under app/api, written from one tenant's point
 * of view: the records it names that are not its own are the other's.
 *
 * A route that is added under app/api without a row in `cases()` fails the
 * "every route has a row" check of both tests.
 */

export const ROOT = path.resolve(__dirname, "../..");
export const PIN = "12345";
export const MASTER = "0123456789abcdef0123456789abcdef";
export const CRON = "cron-secret-0123456789";
export const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("hex");
export const TENANT_A = "AAAAAAAAAAAAAAAAAAAAAA" as TenantId;
export const TENANT_B = "BBBBBBBBBBBBBBBBBBBBBB" as TenantId;
export type Mode = "closed" | "multi";
export type SideKey = "a" | "b";

export const now = () => new Date();

const TOKEN_SCOPES_SEEDED = ["ingest", "read", "official"] as const;

export type Auth = "none" | "session" | "sudo" | "master" | "ingest" | "read" | "official" | "cron";

export interface Case {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  auth: Auth;
  body?: unknown;
  params?: Record<string, string>;
  /** Housekeeping walks every tenant by design: B's own housekeeping may write B's keys. */
  touchesEveryTenant?: boolean;
  /** The call names one of the other tenant's records: it must not find it. */
  expectNotFound?: boolean;
}

export interface Side {
  key: SideKey;
  /** The secret prefix of everything this tenant holds: `asecret-host`, `bsecret ingest token`, … */
  prefix: string;
  store: TenantStore;
  tokens: Record<TokenScope, string> & { id: string };
  /** The trash entry of a group this tenant force-deleted. */
  trashId: string;
  userId: string;
  inviteId: string;
  /** The Cookie header of this tenant's signed-in browser; null where it has none (a single-user instance's B). */
  cookie: string | null;
}

export interface World {
  mode: Mode;
  a: Side;
  b: Side;
}

export const sideOf = (world: World, key: SideKey): Side => world[key];
export const otherKey = (key: SideKey): SideKey => (key === "a" ? "b" : "a");

/** What only one tenant has: its machines, token labels and webhook. (Group names are written across on purpose.) */
export function leaksOf(side: Pick<Side, "prefix">): string[] {
  return [
    `${side.prefix}-host`,
    `${side.prefix}-box`,
    `${side.prefix} ingest`,
    `${side.prefix} read`,
    `${side.prefix} official`,
    `example.com/${side.prefix}`,
  ];
}

export const usageBody = (machineId: string, groupId: string) => ({
  machineId,
  groupId,
  providers: { claude: 1234 },
  timestamp: now().toISOString(),
});

/** A whole settings document that also tries to remove the other's group (from here, where it does not exist). */
const settingsUpdate = (otherPrefix: string) => ({
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
  removedGroups: [`${otherPrefix}-group`],
});

/** Every row of the matrix, keyed by route, from `from`'s point of view (its tenant against the other's). */
export function cases(world: World, from: SideKey = "a"): Record<string, Case[]> {
  const self = sideOf(world, from);
  const other = sideOf(world, otherKey(from));
  const ownHost = `${self.prefix}-host`;
  const otherGroup = `${other.prefix}-group`;
  const otherHost = `${other.prefix}-host`;
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
    "account/export": [{ method: "GET", path: "/api/account/export", auth: "session" }],
    // Multi-tenant mode: a new workspace of its own; single-user: not empty, so 409 and nothing written.
    import: [
      {
        method: "POST",
        path: "/api/import",
        auth: "sudo",
        body: { format: "usageratio-account-export", version: 1, workspace: { name: "a", keys: {} } },
      },
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
        params: { id: other.store.tenantId },
        body: { status: "disabled" },
        expectNotFound: true,
      },
    ],
    // Multi-tenant mode only as well: 404 here. The roles inside one workspace are
    // tests/integration/workspace-members.test.ts's.
    workspace: [{ method: "GET", path: "/api/workspace", auth: "session" }],
    "workspace/invites": [{ method: "POST", path: "/api/workspace/invites", auth: "session", body: {} }],
    "workspace/invites/[id]": [
      {
        method: "DELETE",
        path: "/api/workspace/invites/x",
        auth: "session",
        params: { id: other.inviteId },
        expectNotFound: true,
      },
    ],
    "workspace/members/[userId]": [
      {
        method: "DELETE",
        path: "/api/workspace/members/x?revokeTokens=1",
        auth: "session",
        params: { userId: other.userId },
        expectNotFound: true,
      },
    ],
    "workspace/leave": [{ method: "POST", path: "/api/workspace/leave", auth: "session" }],
    "workspace/transfer": [
      {
        method: "POST",
        path: "/api/workspace/transfer",
        auth: "sudo",
        body: { userId: other.userId },
        expectNotFound: true,
      },
    ],
    "session/tenant": [
      {
        method: "POST",
        path: "/api/session/tenant",
        auth: "session",
        body: { tenantId: other.store.tenantId },
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
        params: { group: otherGroup },
        body: { id: "renamed" },
        expectNotFound: true,
      },
      {
        method: "DELETE",
        path: "/api/groups/x?force=1",
        auth: "sudo",
        params: { group: otherGroup },
        expectNotFound: true,
      },
      {
        method: "PATCH",
        path: "/api/groups/x",
        auth: "sudo",
        params: { group: "Personal" },
        body: { id: otherGroup, merge: true },
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
        params: { provider: "claude", machine: otherHost },
        body: { id: "stolen" },
        expectNotFound: true,
      },
      {
        method: "DELETE",
        path: "/api/machines/x/y",
        auth: "sudo",
        params: { provider: "claude", machine: otherHost },
        expectNotFound: true,
      },
      {
        method: "PATCH",
        path: "/api/machines/x/y",
        auth: "sudo",
        params: { provider: "claude", machine: ownHost },
        body: { group: otherGroup },
      },
    ],
    "machines/prune": [{ method: "POST", path: "/api/machines/prune", auth: "sudo" }],
    machines: [{ method: "GET", path: "/api/machines", auth: "session" }],
    "manage/audit": [{ method: "GET", path: "/api/manage/audit", auth: "session" }],
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
      { method: "PUT", path: "/api/settings", auth: "session", body: settingsUpdate(other.prefix) },
    ],
    setup: [
      { method: "GET", path: `/api/setup?os=macos&mode=auto&group=Personal&machine=${ownHost}`, auth: "session" },
      // Multi-tenant mode: a package with a fresh token for the machine (404 on a single-user instance).
      {
        method: "POST",
        path: "/api/setup",
        auth: "sudo",
        body: { os: "linux", mode: "auto", group: "Personal", machine: ownHost, locale: "en" },
      },
    ],
    status: [{ method: "GET", path: "/api/status", auth: "read" }],
    "tokens/[id]": [
      { method: "DELETE", path: "/api/tokens/x", auth: "sudo", params: { id: other.tokens.id }, expectNotFound: true },
    ],
    "tokens/[id]/rotate": [
      {
        method: "POST",
        path: "/api/tokens/x/rotate",
        auth: "sudo",
        params: { id: other.tokens.id },
        expectNotFound: true,
      },
    ],
    "tokens/audit": [{ method: "GET", path: "/api/tokens/audit", auth: "session" }],
    trash: [{ method: "GET", path: "/api/trash", auth: "session" }],
    "trash/[id]": [
      { method: "DELETE", path: "/api/trash/x", auth: "sudo", params: { id: other.trashId }, expectNotFound: true },
    ],
    "trash/[id]/restore": [
      {
        method: "POST",
        path: "/api/trash/x/restore",
        auth: "sudo",
        params: { id: other.trashId },
        expectNotFound: true,
      },
    ],
    tokens: [
      { method: "GET", path: "/api/tokens", auth: "session" },
      { method: "POST", path: "/api/tokens", auth: "sudo", body: { label: "new", machineId: ownHost } },
    ],
    usage: [
      { method: "GET", path: "/api/usage", auth: "ingest" },
      { method: "POST", path: "/api/usage", auth: "ingest", body: usageBody(ownHost, "Personal") },
      { method: "POST", path: "/api/usage", auth: "master", body: usageBody(ownHost, otherGroup) },
    ],
  };
}

/** Every route file under app/api, as its path below it ("tokens/[id]"). */
export function routeIds(): string[] {
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

/** The cases of a world nobody has built: only to list its rows. */
export function caseRoutes(): string[] {
  const side = { prefix: "x", store: { tenantId: "x" }, tokens: { id: "x" }, trashId: "x", userId: "x", inviteId: "x" };
  return Object.keys(cases({ mode: "closed", a: side, b: side } as unknown as World)).sort();
}

async function seedTenant(store: TenantStore, prefix: string): Promise<Side["tokens"]> {
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
  const tokens = {} as Side["tokens"];
  for (const scope of TOKEN_SCOPES_SEEDED) {
    const created = await createToken(store, `${prefix} ${scope} token`, null, at, scope);
    if (!created.ok) throw new Error("token not created");
    tokens[scope] = created.token;
    tokens.id = created.id;
  }
  return tokens;
}

/** Everything of a tenant's in the store: its own keys, its record, members and invites, and its token index entries. */
export function snapshotOf(store: TenantStore): string {
  const dump = getMemoryStoreForTests()!.dump();
  const own = Object.entries(dump).filter(
    ([key]) => key.startsWith(store.keys.prefix) || key.startsWith(GLOBAL_KEYS.tenantRecord(store.tenantId)),
  );
  const index = Object.entries((dump[GLOBAL_KEYS.tokenIndex]?.value ?? {}) as Record<string, string>).filter(
    ([, tenantId]) => tenantId === store.tenantId,
  );
  return JSON.stringify({ own, index });
}

/** What no tenant's own keys are: rate limits, sessions, and the accounts, workspaces and invites around them. */
const NOT_THE_DEFAULT_TENANTS =
  /^(t:|usage:(rl:|session2?:|tenants?\b|users?\b|invite:|identity:|oauth:|signup|activity:|demo:))/;

/** Everything of the default tenant's: its keys (they have no `t:` prefix), and its token index entries. */
function defaultSnapshot(): string {
  const dump = getMemoryStoreForTests()!.dump();
  const own = Object.entries(dump).filter(
    ([key]) => !NOT_THE_DEFAULT_TENANTS.test(key) && key !== GLOBAL_KEYS.tokenIndex,
  );
  const index = Object.entries((dump[GLOBAL_KEYS.tokenIndex]?.value ?? {}) as Record<string, string>).filter(
    ([, tenantId]) => tenantId === DEFAULT_TENANT,
  );
  return JSON.stringify({ own, index });
}

/** `snapshotOf` for any tenant of the world, the single-user instance's default one included. */
export function snapshotOfSide(side: Side): string {
  return side.store.tenantId === DEFAULT_TENANT ? defaultSnapshot() : snapshotOf(side.store);
}

/** How a request proves itself: a session cookie (and the workspace the page says it is in), and/or a bearer. */
export interface Credential {
  cookie?: string;
  tenantHeader?: string;
  bearer?: string;
  /** The whole Authorization header, for the ones that are not a well-formed bearer. */
  authorization?: string;
}

/** The credential a row of the matrix means, held by `from`. Empty where `from` has no such thing. */
export function credentialFor(world: World, auth: Auth, from: SideKey): Credential {
  const side = sideOf(world, from);
  switch (auth) {
    case "session":
    case "sudo":
      // Multi-tenant mode: the page's own workspace, as every page sends it (the stale-tab guard).
      return side.cookie ? { cookie: side.cookie, tenantHeader: side.store.tenantId } : {};
    case "master":
      return { bearer: MASTER };
    case "cron":
      return { bearer: CRON };
    case "ingest":
    case "read":
    case "official":
      return { bearer: side.tokens[auth] };
    case "none":
      return {};
  }
}

export interface CallOptions {
  credential: Credential;
  /** Replaces the case's params. */
  params?: Record<string, string>;
  /** Replaces the case's body: sent as it is (a string) or as JSON. */
  body?: unknown;
  rawBody?: string;
}

export async function call(route: string, testCase: Case, options: CallOptions): Promise<Response> {
  const module = (await import(`@/app/api/${route}/route`)) as Record<
    string,
    (request: Request, context?: { params: Promise<Record<string, string>> }) => Promise<Response>
  >;
  const handler = module[testCase.method];
  if (!handler) throw new Error(`${route} has no ${testCase.method}`);

  const body =
    options.rawBody !== undefined
      ? options.rawBody
      : options.body !== undefined
        ? JSON.stringify(options.body)
        : testCase.body !== undefined
          ? JSON.stringify(testCase.body)
          : undefined;
  const headers: Record<string, string> = { origin: "http://localhost", host: "localhost" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const { cookie, tenantHeader, bearer, authorization } = options.credential;
  if (cookie) headers.cookie = cookie;
  if (tenantHeader) headers["x-usageratio-tenant"] = tenantHeader;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (authorization !== undefined) headers.authorization = authorization;

  const request = new Request(`http://localhost${testCase.path}`, {
    method: testCase.method,
    headers,
    ...(body !== undefined && { body }),
  });
  return handler(request, { params: Promise.resolve(options.params ?? testCase.params ?? {}) });
}

async function seedSide(
  key: SideKey,
  mode: Mode,
  prefix: string,
  store: TenantStore,
  userId: string,
): Promise<Omit<Side, "cookie">> {
  const tokens = await seedTenant(store, prefix);
  // Something in its trash too: a group it force-deleted, named so that a leak shows in a response.
  const at = now();
  await ingestReport(store, usageBody(`${prefix}-box-pc`, `${prefix}-box-trashed`), at);
  const trashed = await deleteGroup(store, `${prefix}-box-trashed`, true, at);
  if (!trashed.ok || !trashed.trashId) throw new Error(`${key}'s group was not trashed`);
  await getRedis().set(
    store.keys.settings,
    JSON.stringify({ v: 1, alerts: { webhookUrl: `https://hooks.example.com/${prefix}` } }),
  );
  const inviteId = `iv_${key === "a" ? "AAAAAAAA" : "BBBBBBBB"}`;
  // On a single-user instance only B is a workspace at all; A, the default tenant, has no record or members.
  if (mode === "multi" || key === "b") {
    const record = serializeTenantRecord({ v: 1, name: key, createdAt: 1, status: "active" });
    await getRedis().set(GLOBAL_KEYS.tenantRecord(store.tenantId), record);
    await getRedis().hset(GLOBAL_KEYS.tenantMembers(store.tenantId), {
      [userId]: JSON.stringify({ role: "owner", joinedAt: 1 }),
    });
    await getRedis().hset(GLOBAL_KEYS.tenantInvites(store.tenantId), {
      [inviteId]: JSON.stringify({
        hash: "0".repeat(64),
        createdAt: 1,
        expiresAt: Date.now() + 86_400_000,
        createdBy: userId,
      }),
    });
  }
  return { key, prefix, store, tokens, trashId: trashed.trashId, userId, inviteId };
}

/** A and B, seeded alike; each is also a workspace with an owner and a pending invite (A only in multi-tenant mode). */
export async function buildWorld(mode: Mode): Promise<World> {
  const at = now();
  let userA = "u_AAAAAAAAAAAAAAAAAAAAAA";
  let userB = "u_BBBBBBBBBBBBBBBBBBBBBB";
  if (mode === "multi") {
    // Two GitHub accounts, each the owner of its workspace.
    userA = (await findOrCreateGithubUser({ id: 1001, login: "alice" }, at)).userId;
    userB = (await findOrCreateGithubUser({ id: 1002, login: "bob" }, at)).userId;
    await addOwner(TENANT_A, userA, at);
    await addOwner(TENANT_B, userB, at);
  }
  const a = await seedSide("a", mode, "asecret", tenantStore(mode === "multi" ? TENANT_A : DEFAULT_TENANT), userA);
  const b = await seedSide("b", mode, "bsecret", tenantStore(TENANT_B), userB);

  if (mode === "closed") {
    const cookie = await seedSession(PIN);
    await getRedis().set(`${GLOBAL_KEYS.pinSession(sha256Hex(`${cookie.split("=")[1]}:${PIN}`))}:sudo`, "1", {
      ex: 300,
    });
    return { mode, a: { ...a, cookie }, b: { ...b, cookie: null } };
  }
  // A fresh session is a fresh GitHub sign-in: sudo for the next five minutes.
  const signIn = async (side: Omit<Side, "cookie">): Promise<Side> => {
    const header = await withRequest(() => startUserSession(side.userId, side.store.tenantId, at));
    return { ...side, cookie: header.split(";")[0]! };
  };
  return { mode, a: await signIn(a), b: await signIn(b) };
}

/** The environment both modes run in (single-user: the PIN and the master token; multi: GitHub sign-in). */
export function stubIsolationEnvironment(mode: Mode): void {
  vi.stubEnv("DASHBOARD_PIN", PIN);
  vi.stubEnv("USAGE_API_TOKEN", MASTER);
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", ENCRYPTION_KEY);
  if (mode === "multi") {
    vi.stubEnv("REGISTRATION", "invite");
    vi.stubEnv("GITHUB_CLIENT_ID", "Iv1.client");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "client-secret-value");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.example.test");
  }
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  setWebhookTransportForTests(vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
}

export function unstubIsolationEnvironment(): void {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setWebhookTransportForTests(null);
}

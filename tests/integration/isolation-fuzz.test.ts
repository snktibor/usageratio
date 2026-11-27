import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTenantRecord, setTenantStatus } from "@/lib/tenants";
import { listTokens, revokeToken, type TokenScope } from "@/lib/tokens";
import { startUserSession } from "@/lib/user-session";
import en from "@/messages/en.json";
import {
  buildWorld,
  type Case,
  CRON,
  type Credential,
  call,
  caseRoutes,
  cases,
  credentialFor,
  leaksOf,
  MASTER,
  type Mode,
  otherKey,
  PIN,
  routeIds,
  type Side,
  type SideKey,
  sideOf,
  snapshotOfSide,
  stubIsolationEnvironment,
  unstubIsolationEnvironment,
  type World,
} from "../helpers/isolation-world";
import { useRedis } from "../helpers/redis-fixture";
import { withRequest } from "../helpers/request";
import { seedSession } from "../helpers/session";

/**
 * A fuzz on top of the tenant isolation matrix (tests/helpers/isolation-world.ts, the rows of
 * tests/integration/isolation.test.ts): random combinations of a row of the matrix, the tenant it
 * is written from, the credential it is called with (none, either tenant's session, either's
 * tokens, a revoked one, a disabled tenant's, garbage, the shared master token, the cron secret
 * right and wrong), and mutated inputs (path params pointing at the other tenant's ids or at
 * garbage, a garbled or injected body, the other tenant's id in the query and the tenant header).
 *
 * For every call, whoever the credential belongs to:
 *   - the response mentions nothing of any other tenant (what the request itself said does not count);
 *   - every other tenant's keys are byte for byte what they were;
 *   - nothing answers 5xx;
 *   - a credential that is nobody's (garbage, revoked, disabled, wrong secret, the master token
 *     of a multi-tenant instance) gets no 2xx from a route that asks for one (a redirect to the sign-in is nowhere), and a session
 *     without sudo gets none from a route that asks for sudo.
 * Every iteration starts from a fresh world, so a failure replays on its own.
 *
 * The rows come from the matrix, so a row added there is fuzzed with no change here. Seeded:
 *
 *   FUZZ_SEED=123 FUZZ_RUNS=2000 npx vitest run tests/integration/isolation-fuzz.test.ts
 *   FUZZ_SEED=123 FUZZ_ONLY=417 npx vitest run tests/integration/isolation-fuzz.test.ts   # one iteration
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as "Alerts" }),
}));

const intFromEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= 0 && process.env[name] !== "" && process.env[name] !== undefined
    ? parsed
    : fallback;
};
const SEED = intFromEnv("FUZZ_SEED", 20261127);
/** Iterations per mode. */
const RUNS = intFromEnv("FUZZ_RUNS", 500);
const ONLY = process.env.FUZZ_ONLY === undefined || process.env.FUZZ_ONLY === "" ? null : intFromEnv("FUZZ_ONLY", 0);

/** mulberry32: a seeded PRNG in a few lines. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

class Random {
  constructor(private readonly next: () => number) {}
  float = () => this.next();
  chance = (probability: number) => this.next() < probability;
  int = (below: number) => Math.floor(this.next() * below);
  pick = <T>(items: readonly T[]): T => items[this.int(items.length)]!;
  weighted = <T extends { weight: number }>(items: readonly T[]): T => {
    let left = this.next() * items.reduce((sum, item) => sum + item.weight, 0);
    for (const item of items) {
      left -= item.weight;
      if (left < 0) return item;
    }
    return items[items.length - 1]!;
  };
}

/** Whose data a credential may reach: one tenant's, nobody's, or the cron job's (every tenant, by design). */
type Owner = SideKey | "nobody" | "cron";

interface Plan {
  label: string;
  weight: number;
  /** Who the credential belongs to; "nobody" for one that must get nowhere. */
  owner: Owner;
  /** The credential, after whatever it needs done to the world first (a revoked token, a disabled tenant). */
  make: (world: World) => Promise<Credential>;
  /** The credential is the case's own, held by the tenant the row is written from: unmutated, `expectNotFound` holds. */
  native?: boolean;
  /** A session that is signed in but has no sudo. */
  withoutSudo?: boolean;
  /** The user is still signed in, whose workspace is gone from under the session: the account routes still answer. */
  signedInAs?: SideKey;
}

/** Routes of the signed-in user rather than of a workspace (an import is a new workspace of theirs): they answer a session whose workspace is disabled. */
const USER_ROUTES = new Set(["account", "account/export", "account/sessions", "import"]);

/**
 * Rows that need a fresh sudo grant whatever they are sent (the matrix's `sudo` is not that strict:
 * a rename needs none, a merge does; an import needs it on a single-user instance only).
 */
const SUDO_ROWS = new Set([
  "POST api-token/reveal",
  "POST tokens",
  "DELETE tokens/[id]",
  "POST tokens/[id]/rotate",
  "DELETE trash/[id]",
  "POST trash/[id]/restore",
  "POST machines/prune",
  "DELETE providers/[provider]",
  "DELETE account",
  "POST workspace/transfer",
]);

/** Routes the matrix lists with a session that need none: the sign-in starts from anywhere. */
const OPEN_ROUTES = new Set(["auth/github/start"]);

const SCOPES: readonly TokenScope[] = ["ingest", "read", "official"];

/** The same token with its last character changed. */
const FLIPPED = (token: string) => `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

async function tokenOf(side: Side, scope: TokenScope): Promise<string> {
  return side.tokens[scope];
}

async function revoke(side: Side, scope: TokenScope): Promise<void> {
  const record = (await listTokens(side.store)).find((token) => token.label === `${side.prefix} ${scope} token`);
  if (!record) throw new Error(`no ${scope} token to revoke`);
  const revoked = await revokeToken(side.store, record.id, new Date());
  if (!revoked.ok) throw new Error("token not revoked");
}

/** A signed-in session of this side without the sudo window (null: it has no browser at all). */
async function sessionWithoutSudo(world: World, side: Side): Promise<Credential> {
  if (world.mode === "closed") {
    if (side.key !== "a") return {};
    return { cookie: await seedSession(PIN), tenantHeader: side.store.tenantId };
  }
  const longAgo = new Date(Date.now() - 3_600_000);
  const header = await withRequest(() => startUserSession(side.userId, side.store.tenantId, longAgo));
  return { cookie: header.split(";")[0]!, tenantHeader: side.store.tenantId };
}

async function disable(side: Side): Promise<boolean> {
  if (!(await loadTenantRecord(side.store.tenantId))) return false;
  return setTenantStatus(side.store.tenantId, "disabled", new Date());
}

function plansFor(world: World, testCase: Case, from: SideKey): Plan[] {
  const other = otherKey(from);
  const plans: Plan[] = [];
  const add = (plan: Plan) => plans.push(plan);
  const holds = (key: SideKey, auth: Case["auth"]) => async () => credentialFor(world, auth, key);

  // The row's own credential, held by the tenant it is written from, and by the other one.
  const nativeOwner = (key: SideKey): Owner =>
    testCase.auth === "cron" ? "cron" : testCase.auth === "master" ? (world.mode === "closed" ? "a" : "nobody") : key;
  add({
    label: `native(${testCase.auth})`,
    weight: 8,
    owner: nativeOwner(from),
    make: holds(from, testCase.auth),
    native: true,
  });
  add({
    label: `native-of-other(${testCase.auth})`,
    weight: 4,
    owner: nativeOwner(other),
    make: holds(other, testCase.auth),
  });

  add({ label: "no credential", weight: 2, owner: "nobody", make: async () => ({}) });

  for (const key of ["a", "b"] as const) {
    const side = sideOf(world, key);
    add({ label: `session of ${key}`, weight: 2, owner: key, make: holds(key, "session") });
    add({
      label: `session of ${key} for the other workspace`,
      weight: 2,
      owner: key,
      make: async () => ({
        ...credentialFor(world, "session", key),
        tenantHeader: sideOf(world, otherKey(key)).store.tenantId,
      }),
    });
    add({
      label: `session of ${key} without the workspace header`,
      weight: 1,
      owner: key,
      make: async () => ({ cookie: credentialFor(world, "session", key).cookie }),
    });
    add({
      label: `session of ${key} without sudo`,
      weight: 2,
      owner: key,
      withoutSudo: true,
      make: () => sessionWithoutSudo(world, side),
    });
    for (const scope of SCOPES) {
      add({
        label: `${scope} token of ${key}`,
        weight: 2,
        owner: key,
        make: async () => ({ bearer: await tokenOf(side, scope) }),
      });
      add({
        label: `revoked ${scope} token of ${key}`,
        weight: 1,
        owner: "nobody",
        make: async () => {
          await revoke(side, scope);
          return { bearer: await tokenOf(side, scope) };
        },
      });
    }
    add({
      label: `${key}'s token, one character off`,
      weight: 1,
      owner: "nobody",
      make: async () => ({ bearer: FLIPPED(side.tokens.ingest) }),
    });
    add({
      label: `${key}'s token, wrong scheme`,
      weight: 1,
      owner: "nobody",
      make: async () => ({ authorization: `Basic ${side.tokens.ingest}` }),
    });
    add({
      label: `${key}'s token, bare`,
      weight: 1,
      owner: "nobody",
      make: async () => ({ authorization: side.tokens.ingest }),
    });
    add({
      label: `ingest token of ${key}, tenant disabled`,
      weight: 2,
      // FINDING: a single-user instance never looks at the tenant record of a token's tenant
      // (lib/api.ts requireBearer: `multi && !tenantIsActive(...)`), so a disabled workspace's tokens
      // still authenticate and write there if the token index holds them (an instance switched from
      // multi-tenant back to REGISTRATION=closed). They reach their own tenant only; expected as such here.
      owner: world.mode === "multi" ? "nobody" : key,
      make: async () => {
        if (!(await disable(side))) return {}; // the default tenant has no record to disable
        return { bearer: await tokenOf(side, "ingest") };
      },
    });
    add({
      label: `read token of ${key}, tenant disabled`,
      weight: 1,
      owner: world.mode === "multi" ? "nobody" : key, // FINDING: see the ingest token above
      make: async () => {
        await disable(side);
        return { bearer: await tokenOf(side, "read") };
      },
    });
    add({
      label: `session of ${key}, tenant disabled`,
      weight: 2,
      owner: world.mode === "multi" ? "nobody" : key,
      signedInAs: key,
      make: async () => {
        if (world.mode === "closed") return credentialFor(world, "session", key);
        await disable(side);
        return credentialFor(world, "session", key);
      },
    });
  }

  for (const [label, bearer] of [
    ["garbage bearer", "ur_live_not-a-token-at-all-0000000000000000"],
    ["empty bearer", ""],
    ["very long bearer", "ur_live_".padEnd(8_000, "z")],
    ["bearer with non-ASCII", "ur_live_éèÿ"],
    ["bearer null", "null"],
    ["bearer proto", "__proto__"],
    ["wrong cron secret", `${CRON.slice(0, -1)}0`],
  ] as const) {
    add({ label, weight: 1, owner: "nobody", make: async () => ({ bearer }) });
  }
  add({
    label: "master token",
    weight: 3,
    owner: world.mode === "closed" ? "a" : "nobody",
    make: async () => ({ bearer: MASTER }),
  });
  // The cron secret is the cron job's on its own route; anywhere else it is just a wrong bearer.
  add({
    label: "cron secret",
    weight: 2,
    owner: testCase.touchesEveryTenant ? "cron" : "nobody",
    make: async () => ({ bearer: CRON }),
  });
  return plans;
}

const GARBAGE = [
  "",
  " ",
  "..",
  "../../etc/passwd",
  "%00",
  "%2e%2e%2f",
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "x".repeat(5_000),
  "\u{1F4A5}",
  "\u0000",
  "x/y",
  "*",
  "?force=1",
  "<script>alert(1)</script>",
  "'; DROP TABLE usage; --",
  "{}",
  "null",
  "-1",
  "1e999",
  "NaN",
  "usage:settings",
  "t:BBBBBBBBBBBBBBBBBBBBBB:usage:settings",
];

const BODY_GARBAGE = [
  "",
  "{",
  "null",
  "[]",
  '"text"',
  "123",
  "true",
  '{"__proto__":{"polluted":true}}',
  '{"constructor":{"prototype":{"polluted":true}}}',
  `${"[".repeat(2_000)}${"]".repeat(2_000)}`,
  `{"a":"${"x".repeat(100_000)}"}`,
  '{"providerId":"__proto__","machineId":"__proto__","groupId":"constructor","providers":{"__proto__":1}}',
  '{"providers":{"claude":-1},"machineId":"","groupId":""}',
];

interface Mutation {
  params?: Record<string, string>;
  rawBody?: string;
  body?: unknown;
  /** Appended to the path's query. */
  query?: string;
  /** The other tenant's id in the workspace header, whatever the credential says. */
  tenantHeader?: string;
  describe: string[];
}

/** The other tenant's ids and names, and a few more of the kind: what a path param is pointed at. */
function idsOf(world: World): string[] {
  const ids: string[] = ["claude", "openai", "Personal"];
  for (const side of [world.a, world.b]) {
    ids.push(
      side.tokens.id,
      side.trashId,
      side.userId,
      side.inviteId,
      side.store.tenantId,
      `${side.prefix}-host`,
      `${side.prefix}-box`,
      `${side.prefix}-box-pc`,
      `${side.prefix}-group`,
      `${side.prefix}-box-trashed`,
      `claude:${side.prefix}-host`,
    );
  }
  return ids;
}

function mutate(rng: Random, world: World, testCase: Case, from: SideKey): Mutation {
  const mutation: Mutation = { describe: [] };
  const other = sideOf(world, otherKey(from));
  if (testCase.params && rng.chance(0.5)) {
    const ids = idsOf(world);
    mutation.params = Object.fromEntries(
      Object.entries(testCase.params).map(([name, original]) => {
        const roll = rng.float();
        return [name, roll < 0.15 ? original : roll < 0.6 ? rng.pick(ids) : rng.pick(GARBAGE)];
      }),
    );
    mutation.describe.push(`params=${JSON.stringify(mutation.params)}`);
  }
  if (testCase.method !== "GET" && rng.chance(0.25)) {
    if (rng.chance(0.5)) {
      mutation.rawBody = rng.pick(BODY_GARBAGE);
      mutation.describe.push(`rawBody=${JSON.stringify(mutation.rawBody.slice(0, 80))}`);
    } else {
      // The other tenant's id and names where the body could carry a tenant.
      const base = testCase.body && typeof testCase.body === "object" ? testCase.body : {};
      mutation.body = {
        ...base,
        tenantId: other.store.tenantId,
        tenant: other.store.tenantId,
        prefix: other.store.keys.prefix,
        userId: other.userId,
        store: other.store.keys.prefix,
      };
      mutation.describe.push(`body+tenant fields=${other.store.tenantId}`);
    }
  }
  if (rng.chance(0.2)) {
    const id = other.store.tenantId;
    mutation.query = `tenantId=${id}&tenant=${id}&t=${id}&group=${other.prefix}-group&machine=${other.prefix}-host`;
    mutation.describe.push(`query=${mutation.query}`);
  }
  if (rng.chance(0.2)) {
    mutation.tenantHeader = other.store.tenantId;
    mutation.describe.push(`tenantHeader=${mutation.tenantHeader}`);
  }
  return mutation;
}

/** All the text of the request that the response may echo without it being a leak. */
function requestText(testCase: Case, mutation: Mutation, credential: Credential): string {
  return JSON.stringify([
    testCase.path,
    testCase.params,
    mutation.params,
    testCase.body,
    mutation.body,
    mutation.rawBody,
    mutation.query,
    credential,
  ]);
}

/** Every row of the matrix, as the route and the place in its list. */
function rowsOf(world: World): { route: string; index: number }[] {
  return Object.entries(cases(world, "a")).flatMap(([route, list]) => list.map((_, index) => ({ route, index })));
}

describe.each<Mode>(["closed", "multi"])("tenant isolation, fuzzed (%s mode)", (mode) => {
  const redis = useRedis();

  beforeEach(() => stubIsolationEnvironment(mode));
  afterEach(unstubIsolationEnvironment);

  it("has the matrix's rows, all of them", async () => {
    expect(caseRoutes()).toEqual(routeIds());
  });

  it(`holds across ${RUNS} random calls (FUZZ_SEED=${SEED})`, async () => {
    if (!redis.store) return; // the snapshots read the memory store's own dump
    const failures: string[] = [];
    const first = ONLY ?? 0;
    const last = ONLY === null ? RUNS : ONLY + 1;
    // Every row is called, whatever the seed: the rows are dealt out in turn, from a place the seed picks.
    const rows = rowsOf(await buildWorld(mode));
    const offset = SEED % rows.length;

    for (let iteration = first; iteration < last; iteration++) {
      redis.store.clear();
      const world = await buildWorld(mode);
      const rng = new Random(mulberry32((SEED ^ Math.imul(iteration + 1, 0x9e3779b1)) >>> 0));
      const from: SideKey = rng.pick(["a", "b"] as const);
      const { route, index } = rows[(offset + iteration) % rows.length]!;
      // The row as written from `from`'s point of view (its params name the other tenant's records).
      const own = cases(world, from)[route]![index]!;
      const plan = rng.weighted(plansFor(world, own, from));
      const mutation = mutate(rng, world, own, from);
      const replay = `FUZZ_SEED=${SEED} FUZZ_ONLY=${iteration} (${mode} mode)`;
      const label = [
        replay,
        `${own.method} ${route} ${own.path}`,
        `row written from ${from}`,
        `credential: ${plan.label} [owner ${plan.owner}]`,
        ...mutation.describe,
      ].join(" | ");

      const credential = await plan.make(world);
      if (mutation.tenantHeader && (credential.cookie || credential.tenantHeader)) {
        credential.tenantHeader = mutation.tenantHeader;
      }
      const owner: Owner = plan.signedInAs && USER_ROUTES.has(route) ? plan.signedInAs : plan.owner;
      const bystanders = (["a", "b"] as const).filter((key) => key !== owner);
      const before = new Map(bystanders.map((key) => [key, snapshotOfSide(sideOf(world, key))]));

      const path = mutation.query ? `${own.path}${own.path.includes("?") ? "&" : "?"}${mutation.query}` : own.path;
      const request = { ...own, path };
      let response: Response;
      try {
        response = await call(route, request, {
          credential,
          params: mutation.params,
          body: mutation.body,
          rawBody: mutation.rawBody,
        });
      } catch (error) {
        failures.push(`${label}: the handler threw ${error instanceof Error ? error.stack?.slice(0, 300) : error}`);
        continue;
      }
      const text = await response.text();

      const echoed = requestText(own, mutation, credential);
      for (const key of bystanders) {
        const leaked = leaksOf(sideOf(world, key)).filter(
          (marker) => text.includes(marker) && !echoed.includes(marker),
        );
        if (leaked.length > 0)
          failures.push(`${label}: response mentions ${key}: ${leaked.join(", ")} (${response.status})`);
        // The cron job walks every tenant on purpose, and may write any of them.
        if (!(owner === "cron" && own.touchesEveryTenant) && snapshotOfSide(sideOf(world, key)) !== before.get(key)) {
          failures.push(`${label}: changed ${key}'s data (${response.status})`);
        }
      }
      if (response.status >= 500) failures.push(`${label}: ${response.status} ${text.slice(0, 160)}`);
      const holdsCredential = Object.values(credential).some(Boolean);
      if (
        plan.native &&
        holdsCredential &&
        mutation.describe.length === 0 &&
        own.expectNotFound &&
        response.status !== 404
      ) {
        failures.push(`${label}: expected 404 for the other tenant's record, got ${response.status}`);
      }
      // Nobody's credential, or a session without sudo, gets nothing out of a route that asks for more.
      const needsMore = owner === "nobody" || (plan.withoutSudo && SUDO_ROWS.has(`${own.method} ${route}`));
      if (
        needsMore &&
        own.auth !== "none" &&
        !OPEN_ROUTES.has(route) &&
        (response.status < 200 || response.status >= 300) === false
      ) {
        failures.push(`${label}: ${response.status} for a credential that should get nowhere: ${text.slice(0, 120)}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

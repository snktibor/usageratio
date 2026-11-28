import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRedis } from "@/lib/redis";
import en from "@/messages/en.json";
import {
  buildWorld,
  type Case,
  call,
  caseRoutes,
  cases,
  credentialFor,
  leaksOf,
  type Mode,
  now,
  routeIds,
  type SideKey,
  snapshotOfSide,
  stubIsolationEnvironment,
  unstubIsolationEnvironment,
  usageBody,
  type World,
} from "../helpers/isolation-world";
import { useRedis } from "../helpers/redis-fixture";

/**
 * The tenant isolation matrix: every route under app/api, called by tenant A
 * (the default tenant: its PIN session, with sudo, and its tokens), while
 * tenant B holds data marked "bsecret" everywhere it can be. For every call:
 * nothing of B appears in the response, and B's keys are byte for byte what
 * they were. Calls that name B's machines, groups or tokens find nothing.
 * Then B's own tokens are used the other way round: they reach B's data only,
 * and leave A's untouched.
 *
 * It runs twice: on a single-user instance (A is the default tenant, with its
 * PIN session and its master token), and in multi-tenant mode (A is a
 * workspace of its own, with a GitHub session; the master token must get
 * nowhere there). In multi-tenant mode every call starts from a fresh world,
 * since the account and workspace routes then really act on A.
 *
 * A route that is added under app/api without a row in the matrix fails the test. The matrix and the
 * world it runs in are tests/helpers/isolation-world.ts's; tests/integration/isolation-fuzz.test.ts
 * runs random combinations of it.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as "Alerts" }),
}));

const MARKER = "bsecret";

/** One call of the matrix, as its holder: the credential the row means. */
async function run(world: World, route: string, testCase: Case, from: SideKey = "a", bearer?: string) {
  const credential = credentialFor(world, testCase.auth, from);
  return call(route, testCase, { credential: bearer ? { ...credential, bearer } : credential });
}

describe.each<Mode>(["closed", "multi"])("tenant isolation, route by route (%s mode)", (mode) => {
  const redis = useRedis();
  let world: World;

  beforeEach(async () => {
    stubIsolationEnvironment(mode);
    world = await buildWorld(mode);
  });
  afterEach(unstubIsolationEnvironment);

  it("has a row for every route under app/api", () => {
    expect(caseRoutes()).toEqual(routeIds());
  });

  it("never shows tenant A anything of B's, and never changes B's data", async () => {
    if (!redis.store) return; // the snapshots read the memory store's own dump
    const failures: string[] = [];
    // Each row by its place, read again from the world it runs in: a fresh multi-mode world has new ids.
    const rows = Object.entries(cases(world)).flatMap(([route, list]) => list.map((_, index) => ({ route, index })));
    for (const { route, index } of rows) {
      {
        if (mode === "multi") {
          redis.store.clear();
          world = await buildWorld(mode);
        }
        const testCase = cases(world)[route]![index]!;
        const label = `${testCase.method} ${route} ${JSON.stringify(testCase.params ?? {})} (${testCase.auth})`;
        const before = snapshotOfSide(world.b);
        const response = await run(world, route, testCase);
        const text = await response.text();
        const leaked = leaksOf(world.b).filter((marker) => text.includes(marker));
        if (leaked.length > 0)
          failures.push(`${label}: response mentions B: ${leaked.join(", ")} (${response.status})`);
        if (!testCase.touchesEveryTenant && snapshotOfSide(world.b) !== before)
          failures.push(`${label}: changed B's data`);
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
    const aBefore = snapshotOfSide(world.a);
    const status = await run(world, "status", { method: "GET", path: "/api/status", auth: "read" }, "b");
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(statusText).not.toContain("asecret-host");
    expect(statusText).not.toContain("asecret-group");

    const cycle = await run(world, "usage", { method: "GET", path: "/api/usage", auth: "ingest" }, "b");
    expect(cycle.status).toBe(200);

    const posted = await run(
      world,
      "usage",
      { method: "POST", path: "/api/usage", auth: "ingest", body: usageBody(`${MARKER}-host`, `${MARKER}-group`) },
      "b",
    );
    expect(posted.status).toBeLessThan(300);
    const reported = await run(
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
      "b",
    );
    expect(reported.status).toBeLessThan(300);

    expect(snapshotOfSide(world.a)).toBe(aBefore);
    // B's report landed in B.
    expect(await getRedis().hexists(world.b.store.keys.machines, `claude:${MARKER}-host`)).toBe(1);
    expect(await getRedis().hexists(world.a.store.keys.machines, `claude:${MARKER}-host`)).toBe(0);
  });

  it("lets A's own session and tokens reach A's data, so the matrix above is not a wall of 401s", async () => {
    const machines = await run(world, "machines", { method: "GET", path: "/api/machines", auth: "session" });
    expect(machines.status).toBe(200);
    expect(await machines.text()).toContain("asecret-host");
    const created = await run(world, "tokens", {
      method: "POST",
      path: "/api/tokens",
      auth: "sudo",
      body: { label: "new", machineId: "asecret-host" },
    });
    expect(created.status).toBe(201);
    expect(((await created.json()) as { token: string }).token.startsWith("ur_live_")).toBe(true);
    const status = await run(world, "status", { method: "GET", path: "/api/status", auth: "read" });
    expect(status.status).toBe(200);
  });

  it("lets the shared master token in only on a single-user instance", async () => {
    const response = await run(world, "usage", { method: "GET", path: "/api/usage", auth: "master" });
    expect(response.status).toBe(mode === "closed" ? 200 : 401);
  });
});

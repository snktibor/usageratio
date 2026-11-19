import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as testAlert } from "@/app/api/alerts/test/route";
import { GET as signInCallback } from "@/app/api/auth/github/callback/route";
import { POST as signInStart } from "@/app/api/auth/github/start/route";
import { POST as cspReport } from "@/app/api/csp-report/route";
import { GET as exportRoute } from "@/app/api/export/route";
import { POST as officialReport } from "@/app/api/official-usage/report/route";
import { GET as cycle, POST as ingest } from "@/app/api/usage/route";
import {
  CSP_REPORT_RATE_LIMIT_INSTANCE,
  CSP_REPORT_RATE_LIMIT_PER_IP,
  EXPORT_RATE_LIMIT_PER_TENANT,
  INGEST_RATE_LIMIT_PER_MACHINE_MULTI,
  INGEST_RATE_LIMIT_PER_TENANT,
  OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN,
  REGISTRATION_RATE_LIMIT_PER_IP,
  SIGN_IN_RATE_LIMIT_PER_IP,
} from "@/lib/config";
import { log } from "@/lib/log";
import { getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { hourBucket, ipKey } from "@/lib/route-limits";
import { createSignupCode, signupCodeHash, signupCodeIsLive } from "@/lib/signup-codes";
import { tenantStore } from "@/lib/tenant";
import type { TenantId } from "@/lib/tenant-id";
import { createToken, type TokenScope } from "@/lib/tokens";
import { startUserSession } from "@/lib/user-session";
import { createTenantFor, findOrCreateGithubUser, userForGithub } from "@/lib/users";
import en from "@/messages/en.json";
import { ACCOUNTS, ORIGIN, stubGithubInstance } from "../helpers/github";
import { useRedis } from "../helpers/redis-fixture";
import { withRequest } from "../helpers/request";

/**
 * The F6 rate limits, through the real route handlers: every refusal is a 429
 * `rate_limited` with Retry-After; one tenant hammering its own budget never
 * limits another; and the abuse probe at the end floods ingest and sign-in from
 * one address and shows both stop at their limits.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as "Alerts" }),
}));

const MASTER = "0123456789abcdef0123456789abcdef";
const IP_A = "203.0.113.10";
const IP_B = "198.51.100.20";

type Handler = (request: Request) => Promise<Response>;

interface Workspace {
  tenantId: TenantId;
  cookie: string;
}

let nextGithubId = 5000;

async function workspace(login: string): Promise<Workspace> {
  const now = new Date();
  const { userId } = await findOrCreateGithubUser({ id: nextGithubId++, login }, now);
  const tenantId = await createTenantFor(userId, login, now);
  const header = await withRequest(() => startUserSession(userId, tenantId, now));
  return { tenantId, cookie: header.split(";")[0]! };
}

async function token(tenantId: TenantId, scope: TokenScope = "ingest"): Promise<string> {
  const created = await createToken(tenantStore(tenantId), `${scope} token`, null, new Date(), scope);
  if (!created.ok) throw new Error("token refused");
  return created.token;
}

function call(
  handler: Handler,
  path: string,
  init: { method?: string; bearer?: string; cookie?: string; tenant?: string; ip?: string; body?: unknown } = {},
): Promise<Response> {
  return handler(
    new Request(`http://localhost${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...ORIGIN,
        "x-forwarded-for": init.ip ?? IP_A,
        ...(init.bearer && { authorization: `Bearer ${init.bearer}` }),
        ...(init.cookie && { cookie: init.cookie }),
        ...(init.tenant && { "x-usageratio-tenant": init.tenant }),
        ...(init.body !== undefined && { "content-type": "application/json" }),
      },
      ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
    }),
  );
}

const report = (machineId: string) => ({
  machineId,
  groupId: "Personal",
  providers: { claude: 1000 },
  timestamp: new Date().toISOString(),
});

async function expectRateLimited(response: Response): Promise<void> {
  expect(response.status).toBe(429);
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
  const body = (await response.json()) as { error: string; retryAfterSeconds: number };
  expect(body.error).toBe("rate_limited");
  expect(body.retryAfterSeconds).toBeGreaterThan(0);
}

/** Sends `count` requests one after another; the statuses, in order. */
async function flood(count: number, send: (i: number) => Promise<Response>): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) statuses.push((await send(i)).status);
  return statuses;
}

/** POST /api/auth/github/start from `ip`, as a login. */
const startFrom = (ip: string, body: Record<string, unknown> = { purpose: "login" }) =>
  call(signInStart, "/api/auth/github/start", { method: "POST", ip, body });

const counter = async (key: string) => Number((await getRedis().get(key)) ?? 0);

describe("rate limits", () => {
  useRedis();
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("in multi-tenant mode", () => {
    beforeEach(() => stubGithubInstance());

    it("refuses a machine's 13th report of the hour, with Retry-After, and logs it once", async () => {
      const { tenantId } = await workspace("alice");
      const bearer = await token(tenantId);
      const warn = vi.spyOn(log, "warn");
      const statuses = await flood(INGEST_RATE_LIMIT_PER_MACHINE_MULTI, () =>
        call(ingest, "/api/usage", { method: "POST", bearer, body: report("mac") }),
      );
      expect(statuses.every((status) => status === 200 || status === 201)).toBe(true);

      await expectRateLimited(await call(ingest, "/api/usage", { method: "POST", bearer, body: report("mac") }));
      await call(ingest, "/api/usage", { method: "POST", bearer, body: report("mac") });
      const exceeded = warn.mock.calls.filter(([event]) => event === "rate_limit.exceeded");
      expect(exceeded).toHaveLength(1);
      expect(exceeded[0]![1]).toMatchObject({ limit: "ingest", scope: "machine", route: "api/usage" });

      // Another machine of the same workspace still reports.
      expect((await call(ingest, "/api/usage", { method: "POST", bearer, body: report("pc") })).status).toBe(201);
    });

    it("keeps one tenant's ingest flood from limiting another tenant, or using up the instance's budget", async () => {
      const a = await workspace("alice");
      const b = await workspace("bob");
      const bearerA = await token(a.tenantId);
      const bearerB = await token(b.tenantId);

      // A fresh machine id each time gets past the per-machine limit; junk bodies keep it cheap.
      const statuses = await flood(INGEST_RATE_LIMIT_PER_TENANT + 20, (i) =>
        call(ingest, "/api/usage", { method: "POST", bearer: bearerA, body: { machineId: `m${i}` } }),
      );
      expect(statuses.filter((status) => status !== 429)).toHaveLength(INGEST_RATE_LIMIT_PER_TENANT);
      expect(statuses.slice(INGEST_RATE_LIMIT_PER_TENANT).every((status) => status === 429)).toBe(true);

      // The instance counted only what A's own budget let through.
      const bucket = hourBucket(new Date());
      expect(await counter(GLOBAL_KEYS.rateLimit.ingestGlobal(bucket))).toBe(INGEST_RATE_LIMIT_PER_TENANT);

      // B, even from the same address, is not affected.
      const fromB = await call(ingest, "/api/usage", { method: "POST", bearer: bearerB, body: report("mac") });
      expect(fromB.status).toBe(201);
      await expectRateLimited(
        await call(ingest, "/api/usage", { method: "POST", bearer: bearerA, body: report("mac") }),
      );
    });

    it("refuses every tenant once the instance's hourly cost cap is used up", async () => {
      const { tenantId } = await workspace("alice");
      const bearer = await token(tenantId);
      await getRedis().set(GLOBAL_KEYS.rateLimit.ingestGlobal(hourBucket(new Date())), 20_000, { ex: 3600 });
      await expectRateLimited(await call(ingest, "/api/usage", { method: "POST", bearer, body: report("mac") }));
    });

    it("limits ingest per client address across tenants", async () => {
      const { tenantId } = await workspace("alice");
      const bearer = await token(tenantId);
      await getRedis().set(GLOBAL_KEYS.rateLimit.ingestIp(ipKey(IP_A)!), 1_200, { ex: 3600 });
      await expectRateLimited(await call(ingest, "/api/usage", { method: "POST", bearer, body: report("mac") }));
      const other = await call(ingest, "/api/usage", { method: "POST", bearer, ip: IP_B, body: report("mac") });
      expect(other.status).toBe(201);
    });

    it("limits official reports per token, without touching another token's budget", async () => {
      const { tenantId } = await workspace("alice");
      const first = await token(tenantId, "official");
      const second = await token(tenantId, "official");
      const statuses = await flood(OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN, () =>
        call(officialReport, "/api/official-usage/report", { method: "POST", bearer: first, body: {} }),
      );
      expect(statuses.every((status) => status === 400)).toBe(true);
      await expectRateLimited(
        await call(officialReport, "/api/official-usage/report", { method: "POST", bearer: first, body: {} }),
      );
      const other = await call(officialReport, "/api/official-usage/report", {
        method: "POST",
        bearer: second,
        body: {},
      });
      expect(other.status).toBe(400);
    });

    it("limits official reports per tenant", async () => {
      const { tenantId } = await workspace("alice");
      const bearer = await token(tenantId, "official");
      await getRedis().set(GLOBAL_KEYS.rateLimit.officialTenant(tenantId), 1_200, { ex: 3600 });
      await expectRateLimited(
        await call(officialReport, "/api/official-usage/report", { method: "POST", bearer, body: {} }),
      );
    });

    it("limits exports per tenant, and leaves another tenant's alone", async () => {
      const a = await workspace("alice");
      const b = await workspace("bob");
      const statuses = await flood(EXPORT_RATE_LIMIT_PER_TENANT, () =>
        call(exportRoute, "/api/export?format=json", { cookie: a.cookie }),
      );
      expect(statuses.every((status) => status === 200)).toBe(true);
      await expectRateLimited(await call(exportRoute, "/api/export?format=json", { cookie: a.cookie }));
      expect((await call(exportRoute, "/api/export?format=json", { cookie: b.cookie, ip: IP_B })).status).toBe(200);
    });

    it("limits alert tests per workspace: one tenant's test never blocks another's", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("ok", { status: 200 })),
      );
      const a = await workspace("alice");
      const b = await workspace("bob");
      const send = (who: Workspace) =>
        call(testAlert, "/api/alerts/test", {
          method: "POST",
          cookie: who.cookie,
          tenant: who.tenantId,
          body: { webhookUrl: "https://hooks.example.com/x", format: "slack", locale: "en" },
        });

      expect((await send(a)).status).toBe(200);
      expect((await send(b)).status).toBe(200);
      const again = await send(a);
      await expectRateLimited(again.clone());
      expect(Number(again.headers.get("retry-after"))).toBeLessThanOrEqual(10);

      await getRedis().set(GLOBAL_KEYS.rateLimit.alertsTestTenant(b.tenantId), 30, { ex: 3600 });
      await getRedis().del(GLOBAL_KEYS.rateLimit.alertsTestBurst(b.tenantId));
      await expectRateLimited(await send(b));
    });
  });

  describe("on a single-user instance", () => {
    beforeEach(() => {
      vi.stubEnv("REGISTRATION", "closed");
      vi.stubEnv("USAGE_API_TOKEN", MASTER);
    });

    it("keeps a machine's 60 reports an hour, and the cycle lookup's 120", async () => {
      const statuses = await flood(20, () =>
        call(ingest, "/api/usage", { method: "POST", bearer: MASTER, body: report("mac") }),
      );
      expect(statuses.every((status) => status === 200 || status === 201)).toBe(true);

      const lookups = await flood(120, () => call(cycle, "/api/usage", { bearer: MASTER }));
      expect(lookups.every((status) => status === 200)).toBe(true);
      await expectRateLimited(await call(cycle, "/api/usage", { bearer: MASTER }));
    });
  });

  describe("POST /api/csp-report", () => {
    const beacon = (ip: string, contentType = "application/csp-report") =>
      cspReport(
        new Request("http://localhost/api/csp-report", {
          method: "POST",
          headers: { "content-type": contentType, "x-forwarded-for": ip },
          body: JSON.stringify({ "csp-report": { "violated-directive": "script-src" } }),
        }),
      );

    it("counts every beacon, whatever its Content-Type, per address and in total", async () => {
      vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const statuses = await flood(CSP_REPORT_RATE_LIMIT_PER_IP, () => beacon("192.0.2.1", "text/plain"));
      expect(statuses.every((status) => status === 415)).toBe(true);
      await expectRateLimited(await beacon("192.0.2.1"));

      // Many addresses together stop at the total, which bounds the log volume.
      const addresses = Math.ceil(CSP_REPORT_RATE_LIMIT_INSTANCE / CSP_REPORT_RATE_LIMIT_PER_IP) + 1;
      const all: number[] = [];
      for (let a = 2; a < addresses + 2; a++) {
        all.push(...(await flood(CSP_REPORT_RATE_LIMIT_PER_IP, () => beacon(`192.0.2.${a}`))));
      }
      expect(all.filter((status) => status === 204)).toHaveLength(
        CSP_REPORT_RATE_LIMIT_INSTANCE - CSP_REPORT_RATE_LIMIT_PER_IP,
      );
      await expectRateLimited(await beacon("192.0.2.250"));
    });
  });

  describe("sign-in and registration", () => {
    /** A whole sign-in from `ip`: start, then GitHub's callback with `account`. */
    async function signInFrom(ip: string, account: string, body?: Record<string, unknown>): Promise<string | null> {
      const started = await startFrom(ip, body);
      if (started.status !== 200) return `start ${started.status}`;
      const { url } = (await started.json()) as { url: string };
      const nonce = started.headers.getSetCookie()[0]!.split(";")[0]!;
      const response = await signInCallback(
        new Request(
          `http://localhost/api/auth/github/callback?code=${account}&state=${new URL(url).searchParams.get("state")}`,
          {
            headers: { cookie: nonce, "x-forwarded-for": ip },
          },
        ),
      );
      return response.headers.get("location");
    }

    it("creates at most five workspaces a day from one address in open mode", async () => {
      stubGithubInstance("open");
      for (let i = 0; i < 7; i++) ACCOUNTS[`new${i}`] = { id: 9000 + i, login: `new${i}` };
      const locations: (string | null)[] = [];
      for (let i = 0; i < REGISTRATION_RATE_LIMIT_PER_IP + 1; i++) locations.push(await signInFrom(IP_A, `new${i}`));
      expect(locations.slice(0, REGISTRATION_RATE_LIMIT_PER_IP).every((at) => at === "/en")).toBe(true);
      expect(locations.at(-1)).toBe("/en?signin_error=registration_rate_limited");
      // The refused one got no user either: nothing was created for it.
      expect(await userForGithub(9000 + REGISTRATION_RATE_LIMIT_PER_IP)).toBeNull();

      // Another address may still register.
      expect(await signInFrom(IP_B, "new6")).toBe("/en");
    });

    it("leaves a sign-up code unused when the address may not register any more", async () => {
      stubGithubInstance("invite");
      const { code } = await createSignupCode("u_admin", new Date());
      await getRedis().set(GLOBAL_KEYS.rateLimit.registrationIp(ipKey(IP_A)!), 5, { ex: 86_400 });

      expect(await signInFrom(IP_A, "alice", { purpose: "signup", code })).toBe(
        "/en?signin_error=registration_rate_limited",
      );
      expect(await signupCodeIsLive(signupCodeHash(code))).toBe(true);
    });
  });

  describe("abuse probe", () => {
    beforeEach(() => stubGithubInstance());

    it("a report flood and a sign-in flood from one address both stop at their limits", async () => {
      const { tenantId } = await workspace("alice");
      const bearer = await token(tenantId);

      // 1 000 reports in one hour: a new machine id every time, so only the tenant's budget holds them.
      const reports = await flood(1_000, (i) =>
        call(ingest, "/api/usage", { method: "POST", bearer, body: { machineId: `flood-${i}` } }),
      );
      expect(reports.filter((status) => status !== 429)).toHaveLength(INGEST_RATE_LIMIT_PER_TENANT);

      // 100 sign-in starts from one address: 20 get through, the rest wait out the window.
      const starts = await flood(100, () => startFrom(IP_A));
      expect(starts.filter((status) => status === 200)).toHaveLength(SIGN_IN_RATE_LIMIT_PER_IP);
      expect(starts.slice(SIGN_IN_RATE_LIMIT_PER_IP).every((status) => status === 429)).toBe(true);
      // Someone else signs in meanwhile.
      expect((await startFrom(IP_B)).status).toBe(200);
    });
  });
});

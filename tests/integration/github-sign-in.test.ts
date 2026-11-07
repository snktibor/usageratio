import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callback } from "@/app/api/auth/github/callback/route";
import { POST as start } from "@/app/api/auth/github/start/route";
import { GET as getMachines } from "@/app/api/machines/route";
import { ingestReport } from "@/lib/ingest";
import { getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { createSignupCode } from "@/lib/signup-codes";
import { tenantStore } from "@/lib/tenant";
import { DEFAULT_TENANT, type TenantId } from "@/lib/tenant-id";
import { userForGithub, userTenants } from "@/lib/users";
import { useRedis } from "../helpers/redis-fixture";

/**
 * The GitHub sign-in end to end, through both route handlers, with GitHub
 * itself played by a fetch stub: every account below is a `code` the stub
 * knows. What has to hold: a state works once and only in the browser that
 * started it; `invite` mode lets nobody new in without a sign-up code; two
 * accounts get two workspaces that never see each other; sudo only confirms
 * the account that is signed in.
 */

const SITE = "https://app.example.test";
const ORIGIN = { origin: "http://localhost", host: "localhost" };
const ACCOUNTS: Record<string, { id: number; login: string }> = {
  alice: { id: 1001, login: "alice" },
  bob: { id: 2002, login: "bob-dev" },
};

let tokenCalls: { body: Record<string, unknown> }[] = [];

function stubGithub(): void {
  tokenCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://github.com/login/oauth/access_token") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        tokenCalls.push({ body });
        const account = String(body.code);
        return Response.json(
          ACCOUNTS[account] ? { access_token: `gho_${account}` } : { error: "bad_verification_code" },
        );
      }
      if (url === "https://api.github.com/user") {
        const token = new Headers(init?.headers).get("authorization")?.replace("Bearer gho_", "") ?? "";
        const account = ACCOUNTS[token];
        return account ? Response.json(account) : new Response(null, { status: 401 });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

/** Cookie name=value pairs from a response's Set-Cookie headers. */
function setCookies(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const [name, ...value] = pair!.split("=");
    result[name!] = value.join("=");
  }
  return result;
}

async function startAttempt(body: Record<string, unknown>, cookie = "") {
  const response = await start(
    new Request("http://localhost/api/auth/github/start", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { ...ORIGIN, "content-type": "application/json", ...(cookie && { cookie }) },
    }),
  );
  if (response.status !== 200) return { response, state: "", nonce: "" };
  const { url } = (await response.clone().json()) as { url: string };
  return {
    response,
    state: new URL(url).searchParams.get("state") ?? "",
    nonce: setCookies(response).ur_oauth ?? "",
    url,
  };
}

async function finish(params: { account: string; state: string; nonce?: string; session?: string }) {
  const cookies = [params.nonce && `ur_oauth=${params.nonce}`, params.session].filter(Boolean).join("; ");
  const response = await callback(
    new Request(`http://localhost/api/auth/github/callback?code=${params.account}&state=${params.state}`, {
      headers: cookies ? { cookie: cookies } : {},
    }),
  );
  const session = setCookies(response).ur_session;
  return { response, location: response.headers.get("location"), session: session ? `ur_session=${session}` : null };
}

async function signIn(account: string, body: Record<string, unknown> = { purpose: "login" }) {
  const attempt = await startAttempt(body);
  expect(attempt.response.status).toBe(200);
  return finish({ account, state: attempt.state, nonce: attempt.nonce });
}

async function machinesSeenBy(session: string): Promise<string[]> {
  const response = await getMachines(new Request("http://localhost/api/machines", { headers: { cookie: session } }));
  if (response.status !== 200) return [`status ${response.status}`];
  const body = (await response.json()) as { machines: { machineId: string }[] };
  return body.machines.map((machine) => machine.machineId).sort();
}

async function report(tenantId: TenantId, machineId: string): Promise<void> {
  const now = new Date();
  const result = await ingestReport(
    tenantStore(tenantId),
    { machineId, groupId: "Personal", providers: { claude: 100 }, timestamp: now.toISOString() },
    now,
  );
  if (!result.ok) throw new Error("report refused");
}

describe("GitHub sign-in", () => {
  useRedis();
  beforeEach(() => {
    vi.stubEnv("REGISTRATION", "invite");
    vi.stubEnv("GITHUB_CLIENT_ID", "Iv1.client");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "client-secret-value");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
    stubGithub();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("sends the browser to GitHub with PKCE, no scopes and the fixed callback URL", async () => {
    const attempt = await startAttempt({ purpose: "login", returnTo: "/settings", locale: "hu" });
    const url = new URL(attempt.url!);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe(`${SITE}/api/auth/github/callback`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("scope")).toBe("");
    expect(attempt.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const nonceCookie = attempt.response.headers.getSetCookie()[0]!;
    expect(nonceCookie).toMatch(/HttpOnly/);
    expect(nonceCookie).toMatch(/SameSite=Lax/);
    expect(nonceCookie).not.toMatch(/Domain=/i);
  });

  it("names the cookies __Host- over HTTPS", async () => {
    vi.stubEnv("COOKIE_SECURE", "1");
    const response = await start(
      new Request("http://localhost/api/auth/github/start", {
        method: "POST",
        body: JSON.stringify({ purpose: "login" }),
        headers: { ...ORIGIN, "content-type": "application/json" },
      }),
    );
    expect(response.headers.getSetCookie()[0]).toMatch(
      /^__Host-ur_oauth=[^;]+; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
  });

  it("refuses a foreign Origin, and answers 404 on a single-user instance", async () => {
    const foreign = await start(
      new Request("http://localhost/api/auth/github/start", {
        method: "POST",
        body: JSON.stringify({ purpose: "login" }),
        headers: { origin: "https://evil.example", host: "localhost", "content-type": "application/json" },
      }),
    );
    expect(foreign.status).toBe(403);
    vi.stubEnv("REGISTRATION", "closed");
    expect((await startAttempt({ purpose: "login" })).response.status).toBe(404);
    expect((await finish({ account: "alice", state: "x" })).response.status).toBe(404);
  });

  it("answers server_misconfigured while the OAuth App is not set up", async () => {
    vi.stubEnv("GITHUB_CLIENT_SECRET", "");
    const attempt = await startAttempt({ purpose: "login" });
    expect(attempt.response.status).toBe(500);
    expect(((await attempt.response.json()) as { error: string }).error).toBe("server_misconfigured");
  });

  it("lets nobody new in without a sign-up code in invite mode, and creates nothing", async () => {
    const result = await signIn("alice");
    expect(result.location).toBe("/en?signin_error=registration_closed");
    expect(result.session).toBeNull();
    expect(await userForGithub(ACCOUNTS.alice!.id)).toBeNull();
  });

  it("gives each account with a sign-up code a workspace of its own, which the other never sees", async () => {
    const codeA = await createSignupCode("admin", new Date());
    const codeB = await createSignupCode("admin", new Date());
    const alice = await signIn("alice", { purpose: "signup", code: codeA.code, returnTo: "/settings", locale: "de" });
    const bob = await signIn("bob", { purpose: "signup", code: codeB.code });
    expect(alice.location).toBe("/de/settings");
    expect(alice.session && bob.session).toBeTruthy();

    const aliceId = (await userForGithub(ACCOUNTS.alice!.id))!;
    const bobId = (await userForGithub(ACCOUNTS.bob!.id))!;
    const [aliceTenant] = await userTenants(aliceId);
    const [bobTenant] = await userTenants(bobId);
    expect(aliceTenant?.role).toBe("owner");
    expect(aliceTenant?.tenantId).not.toBe(bobTenant?.tenantId);
    expect(aliceTenant?.tenantId).not.toBe(DEFAULT_TENANT);

    await report(aliceTenant!.tenantId, "alice-laptop");
    await report(bobTenant!.tenantId, "bob-desktop");
    await report(DEFAULT_TENANT, "maintainer-mac");
    expect(await machinesSeenBy(alice.session!)).toEqual(["alice-laptop"]);
    expect(await machinesSeenBy(bob.session!)).toEqual(["bob-desktop"]);

    // A later sign-in of the same account lands in the same workspace, and makes no new one.
    const again = await signIn("alice");
    expect(await machinesSeenBy(again.session!)).toEqual(["alice-laptop"]);
    expect(await userTenants(aliceId)).toHaveLength(1);
  });

  it("uses a sign-up code exactly once", async () => {
    const { code } = await createSignupCode("admin", new Date());
    const first = await startAttempt({ purpose: "signup", code });
    const second = await startAttempt({ purpose: "signup", code });
    expect((await finish({ account: "alice", state: first.state, nonce: first.nonce })).session).not.toBeNull();
    // Started while the code was still live, finished after it was used: refused, and bob gets no user.
    const late = await finish({ account: "bob", state: second.state, nonce: second.nonce });
    expect(late.location).toBe("/en?signin_error=signup_code_invalid");
    expect(await userForGithub(ACCOUNTS.bob!.id)).toBeNull();
    const after = await startAttempt({ purpose: "signup", code });
    expect(after.response.status).toBe(400);
  });

  it("works a state once, in the browser that started it", async () => {
    const codeA = await createSignupCode("admin", new Date());
    const attempt = await startAttempt({ purpose: "signup", code: codeA.code });
    // Without the browser's nonce (someone else's link): refused, and the state is spent.
    expect((await finish({ account: "alice", state: attempt.state })).location).toBe("/en?signin_error=state_invalid");
    expect((await finish({ account: "alice", state: attempt.state, nonce: attempt.nonce })).location).toBe(
      "/en?signin_error=state_invalid",
    );

    const other = await startAttempt({ purpose: "signup", code: codeA.code });
    expect((await finish({ account: "alice", state: other.state, nonce: attempt.nonce })).location).toBe(
      "/en?signin_error=state_invalid",
    );
  });

  it("returns only to an allowed page", async () => {
    vi.stubEnv("REGISTRATION", "open");
    for (const returnTo of ["https://evil.example", "//evil.example", "/api/export", "/settings?x=1"]) {
      expect((await signIn("alice", { purpose: "login", returnTo, locale: "xx" })).location).toBe("/en");
    }
  });

  it("refuses a GitHub error or a code GitHub does not take, without echoing anything", async () => {
    vi.stubEnv("REGISTRATION", "open");
    const attempt = await startAttempt({ purpose: "login" });
    const denied = await callback(
      new Request(
        `http://localhost/api/auth/github/callback?error=access_denied&error_description=<script>&state=${attempt.state}`,
        { headers: { cookie: `ur_oauth=${attempt.nonce}` } },
      ),
    );
    expect(denied.headers.get("location")).toBe("/en?signin_error=github_denied");
    expect((await signIn("mallory")).location).toBe("/en?signin_error=github_failed");
  });

  it("registers anyone in open mode, with a workspace of their own", async () => {
    vi.stubEnv("REGISTRATION", "open");
    const alice = await signIn("alice");
    expect(alice.location).toBe("/en");
    expect(await machinesSeenBy(alice.session!)).toEqual([]);
    const aliceId = (await userForGithub(ACCOUNTS.alice!.id))!;
    expect(await userTenants(aliceId)).toHaveLength(1);
  });

  it("confirms sudo only for the account that is signed in", async () => {
    vi.stubEnv("REGISTRATION", "open");
    const alice = await signIn("alice");
    const asBob = await startAttempt({ purpose: "sudo", returnTo: "/settings" }, alice.session!);
    expect(asBob.response.status).toBe(200);
    const mismatch = await finish({ account: "bob", state: asBob.state, nonce: asBob.nonce, session: alice.session! });
    expect(mismatch.location).toBe("/en?signin_error=sudo_mismatch");
    expect(mismatch.session).toBeNull();

    const asAlice = await startAttempt({ purpose: "sudo", returnTo: "/settings" }, alice.session!);
    const ok = await finish({ account: "alice", state: asAlice.state, nonce: asAlice.nonce, session: alice.session! });
    expect(ok.location).toBe("/en/settings");
    expect(ok.session).toBeNull(); // the same session, now with a fresh sign-in on it

    // Sudo without a session cannot even start.
    expect((await startAttempt({ purpose: "sudo" })).response.status).toBe(401);
  });

  it("drops a member the moment their membership goes, and a session whose tenant is gone", async () => {
    vi.stubEnv("REGISTRATION", "open");
    const alice = await signIn("alice");
    const aliceId = (await userForGithub(ACCOUNTS.alice!.id))!;
    const [{ tenantId } = { tenantId: "" as TenantId }] = await userTenants(aliceId);
    expect(await machinesSeenBy(alice.session!)).toEqual([]);

    await getRedis().hdel(GLOBAL_KEYS.tenantMembers(tenantId), aliceId);
    expect(await machinesSeenBy(alice.session!)).toEqual(["status 401"]);

    await getRedis().hset(GLOBAL_KEYS.tenantMembers(tenantId), { [aliceId]: JSON.stringify({ role: "owner" }) });
    expect(await machinesSeenBy(alice.session!)).toEqual([]);
    await getRedis().del(GLOBAL_KEYS.tenantRecord(tenantId));
    expect(await machinesSeenBy(alice.session!)).toEqual(["status 401"]);
  });

  it("never reads a PIN session as a user session, nor the other way round", async () => {
    vi.stubEnv("REGISTRATION", "open");
    vi.stubEnv("DASHBOARD_PIN", "12345");
    const alice = await signIn("alice");
    const sessionId = alice.session!.split("=")[1]!;
    // The same id under the PIN session's cookie name gets nothing in multi-tenant mode.
    expect(await machinesSeenBy(`usageratio_session=${sessionId}`)).toEqual(["status 401"]);
    vi.stubEnv("REGISTRATION", "closed");
    expect(await machinesSeenBy(alice.session!)).toEqual(["status 401"]);
  });

  it("sends the PKCE verifier and the fixed redirect URI with the code", async () => {
    vi.stubEnv("REGISTRATION", "open");
    await signIn("alice");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]!.body.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenCalls[0]!.body.redirect_uri).toBe(`${SITE}/api/auth/github/callback`);
    expect(tokenCalls[0]!.body.client_secret).toBe("client-secret-value");
  });
});

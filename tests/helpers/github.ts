import { expect, vi } from "vitest";
import { GET as callback } from "@/app/api/auth/github/callback/route";
import { POST as start } from "@/app/api/auth/github/start/route";

/**
 * GitHub, played by a fetch stub, for the sign-in tests: every account in
 * ACCOUNTS is a `code` the stub knows, and its access token names it back.
 * Plus the two halves of the flow through the real route handlers.
 */

export const SITE = "https://app.example.test";
export const ORIGIN = { origin: "http://localhost", host: "localhost" };
export const ACCOUNTS: Record<string, { id: number; login: string }> = {
  alice: { id: 1001, login: "alice" },
  bob: { id: 2002, login: "bob-dev" },
};

export let tokenCalls: { body: Record<string, unknown> }[] = [];

export function stubGithub(): void {
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
export function setCookies(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const [name, ...value] = pair!.split("=");
    result[name!] = value.join("=");
  }
  return result;
}

export async function startAttempt(body: Record<string, unknown>, cookie = "") {
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

export async function finish(params: { account: string; state: string; nonce?: string; session?: string }) {
  const cookies = [params.nonce && `ur_oauth=${params.nonce}`, params.session].filter(Boolean).join("; ");
  const response = await callback(
    new Request(`http://localhost/api/auth/github/callback?code=${params.account}&state=${params.state}`, {
      headers: cookies ? { cookie: cookies } : {},
    }),
  );
  const session = setCookies(response).ur_session;
  return { response, location: response.headers.get("location"), session: session ? `ur_session=${session}` : null };
}

export async function signIn(account: string, body: Record<string, unknown> = { purpose: "login" }) {
  const attempt = await startAttempt(body);
  expect(attempt.response.status).toBe(200);
  return finish({ account, state: attempt.state, nonce: attempt.nonce });
}

/** The environment a multi-tenant instance with a GitHub OAuth App runs in. */
export function stubGithubInstance(registration: "invite" | "open" = "invite"): void {
  vi.stubEnv("REGISTRATION", registration);
  vi.stubEnv("GITHUB_CLIENT_ID", "Iv1.client");
  vi.stubEnv("GITHUB_CLIENT_SECRET", "client-secret-value");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", SITE);
  stubGithub();
}

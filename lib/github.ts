import { createHash, randomBytes } from "node:crypto";
import { log } from "@/lib/log";

/**
 * GitHub sign-in: an OAuth App's web flow with PKCE (S256), written by hand
 * (no auth package). No scopes are asked for, so the access token can only
 * read the public profile; it is used once, for `GET /user`, and dropped:
 * never stored, never logged. Only the numeric id and the login are kept.
 *
 * The callback URL is fixed: NEXT_PUBLIC_SITE_URL + CALLBACK_PATH, never
 * taken from the request's Host header. It has to be the OAuth App's
 * callback URL exactly (and the app's wildcard matching should be off).
 */

export const CALLBACK_PATH = "/api/auth/github/callback";
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const TIMEOUT_MS = 5000;

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface GithubUser {
  id: number;
  login: string;
}

/**
 * What a GitHub login may look like here: letters, digits, hyphens and underscores (Enterprise
 * Managed Users have one, `octocat_acme`; old accounts may have doubled or trailing hyphens).
 * The login is display data only, so the rule only keeps markup and separators out of it.
 */
export const LOGIN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The site's own origin, from NEXT_PUBLIC_SITE_URL: https, or http on a loopback host for local development. */
function siteOrigin(raw: string | undefined): string | null {
  try {
    const url = new URL(raw?.trim() ?? "");
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The OAuth App's settings, or null while any of them is missing (sign-in then refuses to start). */
export function githubConfig(env: Record<string, string | undefined> = process.env): GithubConfig | null {
  const clientId = env.GITHUB_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim() ?? "";
  const origin = siteOrigin(env.NEXT_PUBLIC_SITE_URL);
  if (!clientId || !clientSecret || !origin) return null;
  return { clientId, clientSecret, redirectUri: `${origin}${CALLBACK_PATH}` };
}

/** A fresh PKCE pair: a 256-bit verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Where to send the browser: GitHub's authorize page, with the account picker shown. */
export function authorizeUrl(config: GithubConfig, params: { state: string; challenge: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", "");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** Trades the callback's code for an access token; null on any failure (logged without the code or the token). */
export async function exchangeCode(config: GithubConfig, code: string, verifier: string): Promise<string | null> {
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) {
      log.warn("github.token_failed", { status: response.status });
      return null;
    }
    const body = (await response.json()) as { access_token?: unknown; error?: unknown };
    if (typeof body.access_token === "string" && body.access_token.length > 0) return body.access_token;
    log.warn("github.token_refused", { reason: typeof body.error === "string" ? body.error.slice(0, 64) : "none" });
    return null;
  } catch (error) {
    log.warn("github.token_unreachable", { err: error });
    return null;
  }
}

/** The signed-in account's numeric id and login; null on any failure or an answer that does not look right. */
export async function fetchGithubUser(accessToken: string): Promise<GithubUser | null> {
  try {
    const response = await fetch(USER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "usageratio",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "error",
    });
    if (!response.ok) {
      log.warn("github.user_failed", { status: response.status });
      return null;
    }
    const body = (await response.json()) as { id?: unknown; login?: unknown };
    if (typeof body.id !== "number" || !Number.isSafeInteger(body.id) || body.id <= 0) return null;
    if (typeof body.login !== "string" || !LOGIN_PATTERN.test(body.login)) return null;
    return { id: body.id, login: body.login };
  } catch (error) {
    log.warn("github.user_unreachable", { err: error });
    return null;
  }
}

/**
 * The origin a link this instance hands out (a sign-up or invite link) should name: the configured
 * site's, the one GitHub sends people back to, or the request's own when there is none.
 */
export function publicOrigin(requestUrl: URL): string {
  const config = githubConfig();
  return config ? new URL(config.redirectUri).origin : requestUrl.origin;
}

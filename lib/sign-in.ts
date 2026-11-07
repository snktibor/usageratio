import { routing } from "@/i18n/routing";
import { clearCookie, hostCookieName, serializeCookie } from "@/lib/cookies";
import { authorizeUrl, exchangeCode, fetchGithubUser, githubConfig, pkcePair } from "@/lib/github";
import { consumeInvite, inviteHash, isInviteCodeShape, peekInvite } from "@/lib/invites";
import { log } from "@/lib/log";
import { addMember } from "@/lib/members";
import { consumeOAuthState, createOAuthState, OAUTH_STATE_TTL_SECONDS, type OAuthPurpose } from "@/lib/oauth-state";
import { hit, type RateLimitResult } from "@/lib/rate-limit";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { registrationMode } from "@/lib/registration";
import { clientIp, isHttpsRequest } from "@/lib/request-context";
import { sha256Hex } from "@/lib/security";
import { consumeSignupCode, isSignupCodeShape, signupCodeHash, signupCodeIsLive } from "@/lib/signup-codes";
import type { TenantId } from "@/lib/tenant-id";
import { loadTenantRecord, tenantIsActive } from "@/lib/tenants";
import { currentUserSession, markSessionAuthenticated, startUserSession } from "@/lib/user-session";
import {
  createTenantFor,
  findOrCreateGithubUser,
  hasGithubIdentity,
  membershipRole,
  userForGithub,
  userTenants,
} from "@/lib/users";

/**
 * The GitHub sign-in flow, between the two route handlers
 * (app/api/auth/github/start and /callback): what may start an attempt, and
 * what its callback does: sign a known user in, create a user and a
 * workspace when the mode allows it, or confirm sudo on the session that
 * asked. Every redirect target comes from the allow-list below, never from
 * the request as given.
 */

/** Where a sign-in may return to: the pages that show the sign-in screen. Anything else goes home. */
const RETURN_TO = new Set(["/", "/setup", "/settings", "/account", "/admin", "/workspace"]);
const OAUTH_COOKIE = "ur_oauth";

export function safeReturnTo(raw: unknown): string {
  return typeof raw === "string" && RETURN_TO.has(raw) ? raw : "/";
}

export function safeLocale(raw: unknown): string {
  return typeof raw === "string" && (routing.locales as readonly string[]).includes(raw) ? raw : routing.defaultLocale;
}

/** Sign-in requests (start and callback together) per address and window. */
const ATTEMPTS_PER_ADDRESS = 20;
/** Without a trusted proxy every request comes from "unknown": one shared, larger budget then. */
const ATTEMPTS_UNKNOWN_ADDRESS = 300;
const ATTEMPT_WINDOW_SECONDS = 600;

/** Counts one sign-in request against its address's budget (lib/rate-limit.ts). */
export async function countSignInAttempt(): Promise<RateLimitResult> {
  const ip = await clientIp();
  if (ip === "unknown") {
    return hit(GLOBAL_KEYS.rateLimit.oauth("unknown"), ATTEMPTS_UNKNOWN_ADDRESS, ATTEMPT_WINDOW_SECONDS);
  }
  return hit(GLOBAL_KEYS.rateLimit.oauth(sha256Hex(ip).slice(0, 32)), ATTEMPTS_PER_ADDRESS, ATTEMPT_WINDOW_SECONDS);
}

export type SignInErrorCode =
  | "rate_limited"
  | "misconfigured"
  | "state_invalid"
  | "github_denied"
  | "github_failed"
  | "registration_closed"
  | "signup_code_invalid"
  | "invite_invalid"
  | "invite_wrong_account"
  | "sudo_mismatch";

export type StartResult =
  | { ok: true; url: string; cookie: string }
  | {
      ok: false;
      reason: "misconfigured" | "unauthorized" | "signup_code_invalid" | "invite_invalid" | "registration_closed";
    };

/** Starts an attempt: the authorize URL to send the browser to, and the nonce cookie that binds the attempt to it. */
export async function startSignIn(params: {
  purpose: OAuthPurpose;
  returnTo: unknown;
  locale: unknown;
  signupCode?: unknown;
  inviteCode?: unknown;
}): Promise<StartResult> {
  const config = githubConfig();
  if (!config) {
    log.error("signin.misconfigured", {
      rule: "multi-tenant mode needs GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and an https NEXT_PUBLIC_SITE_URL",
    });
    return { ok: false, reason: "misconfigured" };
  }
  const mode = registrationMode();
  if (mode === "closed") return { ok: false, reason: "registration_closed" };

  let sid: string | undefined;
  let signup: string | undefined;
  let invite: string | undefined;
  if (params.purpose === "sudo") {
    const session = await currentUserSession();
    if (!session) return { ok: false, reason: "unauthorized" };
    sid = session.hash;
  }
  if (params.purpose === "signup") {
    const code = typeof params.signupCode === "string" ? params.signupCode.trim() : "";
    if (!isSignupCodeShape(code) || !(await signupCodeIsLive(signupCodeHash(code)))) {
      return { ok: false, reason: "signup_code_invalid" };
    }
    signup = signupCodeHash(code);
  }
  if (params.purpose === "join") {
    const code = typeof params.inviteCode === "string" ? params.inviteCode.trim() : "";
    if (!isInviteCodeShape(code) || !(await peekInvite(inviteHash(code))))
      return { ok: false, reason: "invite_invalid" };
    invite = inviteHash(code);
  }

  const { verifier, challenge } = pkcePair();
  const { state, nonce } = await createOAuthState({
    purpose: params.purpose,
    verifier,
    returnTo: safeReturnTo(params.returnTo),
    locale: safeLocale(params.locale),
    ...(signup && { signup }),
    ...(invite && { invite }),
    ...(sid && { sid }),
  });
  const secure = await isHttpsRequest();
  return {
    ok: true,
    url: authorizeUrl(config, { state, challenge }),
    cookie: serializeCookie(hostCookieName(OAUTH_COOKIE, secure), nonce, { maxAge: OAUTH_STATE_TTL_SECONDS, secure }),
  };
}

/** The first of the user's tenants (lib/users.ts `userTenants` order) that is not disabled or being deleted. */
export async function firstActiveTenant(userId: string): Promise<TenantId | null> {
  for (const { tenantId } of await userTenants(userId)) {
    if (tenantIsActive(tenantId, await loadTenantRecord(tenantId))) return tenantId;
  }
  return null;
}

/** The name of the nonce cookie on this connection, for the callback to read. */
export async function oauthCookieName(): Promise<string> {
  return hostCookieName(OAUTH_COOKIE, await isHttpsRequest());
}

export interface FinishResult {
  /** A same-site path: the page to land on, with `?signin_error=` on failure. */
  location: string;
  /** Set-Cookie headers: always the cleared nonce, plus the new session on success. */
  cookies: string[];
}

/** The callback: checks the attempt, asks GitHub who signed in, and does what the attempt was for. */
export async function finishSignIn(
  params: { code: string | null; state: string | null; error: string | null; nonce: string | undefined },
  now: Date,
): Promise<FinishResult> {
  const secure = await isHttpsRequest();
  const cookies = [clearCookie(hostCookieName(OAUTH_COOKIE, secure), secure)];
  const fail = (locale: string, code: SignInErrorCode): FinishResult => {
    log.warn("signin.failed", { reason: code });
    return { location: `/${locale}?signin_error=${code}`, cookies };
  };

  const attempt = params.state ? await consumeOAuthState(params.state, params.nonce) : null;
  if (!attempt) return fail(routing.defaultLocale, "state_invalid");
  const { locale } = attempt;
  const landing = `/${locale}${attempt.returnTo === "/" ? "" : attempt.returnTo}`;
  // A failed sudo goes back to the page that asked (the user is signed in there), the rest home.
  const failHere = (code: SignInErrorCode): FinishResult => {
    if (attempt.purpose !== "sudo") return fail(locale, code);
    log.warn("signin.failed", { reason: code, purpose: "sudo" });
    return { location: `${landing}?signin_error=${code}`, cookies };
  };
  const config = githubConfig();
  if (!config || registrationMode() === "closed") return failHere("misconfigured");
  if (params.error || !params.code) return failHere("github_denied");

  const token = await exchangeCode(config, params.code, attempt.verifier);
  const github = token ? await fetchGithubUser(token) : null;
  if (!github) return failHere("github_failed");

  if (attempt.purpose === "sudo") {
    const session = await currentUserSession();
    if (!session || session.hash !== attempt.sid || !(await hasGithubIdentity(session.userId, github.id))) {
      return failHere("sudo_mismatch");
    }
    await markSessionAuthenticated(session.hash, now);
    log.info("signin.sudo", { userId: session.userId });
    return { location: landing, cookies };
  }

  if (attempt.purpose === "join") return finishJoin(attempt.invite, github, { locale, landing, cookies }, now);

  let newTenant: TenantId | null = null;
  let userId: string;
  const known = await userForGithub(github.id);
  const hasWorkspace = known !== null && (await userTenants(known)).length > 0;
  if (attempt.purpose === "signup" && !hasWorkspace) {
    // The code is taken first: a code that is gone (used, revoked, expired) creates nothing.
    if (!attempt.signup) return fail(locale, "signup_code_invalid");
    const placeholder = `github:${github.id}`;
    const codeId = await consumeSignupCode(attempt.signup, placeholder, now);
    if (!codeId) return fail(locale, "signup_code_invalid");
    ({ userId } = await findOrCreateGithubUser(github, now));
    newTenant = await createTenantFor(userId, github.login, now);
    log.info("signin.signup", { userId, tenantId: newTenant, codeId });
  } else {
    // A sign-up link opened by someone who already has a workspace is just a sign-in: the code
    // stays unused, and nobody gets a second, empty workspace by accident.
    if (!known && registrationMode() !== "open") return fail(locale, "registration_closed");
    const result = await findOrCreateGithubUser(github, now);
    userId = result.userId;
    if (result.created) {
      newTenant = await createTenantFor(userId, github.login, now);
      log.info("signin.registered", { userId, tenantId: newTenant });
    }
  }

  const active = newTenant ?? (await firstActiveTenant(userId));
  cookies.push(await startUserSession(userId, active, now));
  log.info("signin.ok", { userId, purpose: attempt.purpose });
  return { location: landing, cookies };
}

/**
 * The callback of a workspace invite. The invite is looked at first and taken
 * only once everything else checks out, so an invite bound to another login,
 * or opened by someone who already belongs, is not used up. Taking it is the
 * GETDEL: of two callbacks racing for one invite, one gets in.
 */
async function finishJoin(
  hash: string | undefined,
  github: { id: number; login: string },
  context: {
    locale: string;
    landing: string;
    cookies: string[];
  },
  now: Date,
): Promise<FinishResult> {
  const { locale, landing, cookies } = context;
  // Back to the /join page, which shows why: home would show a signed-in user's dashboard instead.
  const fail = (code: SignInErrorCode): FinishResult => {
    log.warn("signin.failed", { reason: code, purpose: "join" });
    return { location: `/${locale}/join?signin_error=${code}`, cookies };
  };
  const target = hash ? await peekInvite(hash) : null;
  if (!hash || !target || !tenantIsActive(target.tenantId, await loadTenantRecord(target.tenantId))) {
    return fail("invite_invalid");
  }
  if (target.login !== null && target.login !== github.login.toLowerCase()) return fail("invite_wrong_account");

  const known = await userForGithub(github.id);
  if (known && (await membershipRole(target.tenantId, known))) {
    // Already in: just open the workspace, and leave the invite for whoever it was meant for.
    await findOrCreateGithubUser(github, now);
    cookies.push(await startUserSession(known, target.tenantId, now));
    log.info("signin.ok", { userId: known, purpose: "join", alreadyMember: true });
    return { location: landing, cookies };
  }

  const taken = await consumeInvite(hash);
  if (!taken || taken.tenantId !== target.tenantId) return fail("invite_invalid");
  // An invite is enough to create a user, never a workspace: the new user starts in this one.
  const { userId } = await findOrCreateGithubUser(github, now);
  await addMember(taken.tenantId, userId, taken.createdBy, now);
  cookies.push(await startUserSession(userId, taken.tenantId, now));
  log.info("signin.join", { userId, tenantId: taken.tenantId, inviteId: taken.inviteId });
  return { location: landing, cookies };
}

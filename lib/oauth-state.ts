import { randomBytes } from "node:crypto";
import { getRedis } from "@/lib/redis";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { safeEqual, sha256Hex } from "@/lib/security";

/**
 * One GitHub sign-in attempt, between `/api/auth/github/start` and the
 * callback. The `state` sent to GitHub names a server-side record (by its
 * hash) that holds the PKCE verifier and what the attempt is for; a second,
 * random nonce goes into a short-lived cookie in the browser that started it,
 * and the record holds only its hash. The callback needs both, and takes the
 * record with GETDEL, so a state works once, in that browser, for 10 minutes:
 * a link someone else started (login CSRF) or a replayed callback gets nowhere.
 */

export const OAUTH_STATE_TTL_SECONDS = 600;

export type OAuthPurpose = "login" | "signup" | "join" | "sudo";

export interface OAuthAttempt {
  purpose: OAuthPurpose;
  /** PKCE code verifier: only ever in this server-side record. */
  verifier: string;
  /** An internal path from the allow-list (lib/sign-in.ts `safeReturnTo`). */
  returnTo: string;
  locale: string;
  /** "signup": sha256 of the sign-up code, consumed in the callback. */
  signup?: string;
  /** "join": sha256 of the workspace invite code, consumed in the callback. */
  invite?: string;
  /** "sudo": sha256 of the session id that asked, which the callback must still be carrying. */
  sid?: string;
}

interface StoredAttempt extends OAuthAttempt {
  nonceHash: string;
}

/** Records an attempt; returns the `state` for GitHub and the nonce for the browser's cookie. */
export async function createOAuthState(attempt: OAuthAttempt): Promise<{ state: string; nonce: string }> {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const stored: StoredAttempt = { ...attempt, nonceHash: sha256Hex(nonce) };
  await getRedis().set(GLOBAL_KEYS.oauthState(sha256Hex(state)), JSON.stringify(stored), {
    ex: OAUTH_STATE_TTL_SECONDS,
  });
  return { state, nonce };
}

const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The attempt `state` names, taken out of the store (so it can never be used
 * again), when `nonce` is the one its browser was given; null otherwise. A
 * wrong nonce still burns the state.
 */
export async function consumeOAuthState(state: string, nonce: string | undefined): Promise<OAuthAttempt | null> {
  if (!STATE_PATTERN.test(state)) return null;
  const raw = await getRedis().getdel<string>(GLOBAL_KEYS.oauthState(sha256Hex(state)));
  if (raw === null || raw === undefined || !nonce) return null;
  let stored: StoredAttempt;
  try {
    stored = JSON.parse(String(raw)) as StoredAttempt;
  } catch {
    return null;
  }
  if (typeof stored.nonceHash !== "string" || !safeEqual(sha256Hex(nonce), stored.nonceHash)) return null;
  const { nonceHash: _, ...attempt } = stored;
  return attempt;
}

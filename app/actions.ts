"use server";

import { getLocale } from "next-intl/server";
import { redirect } from "@/i18n/routing";
import { attemptLogin, endSession, type LoginResult } from "@/lib/auth";
import { log } from "@/lib/log";
import { StorageNotConfiguredError } from "@/lib/redis";

export type LoginErrorCode =
  | "malformed"
  | "misconfigured"
  | "invalid"
  | "rate_limited"
  | "storage_not_configured"
  | "storage_unavailable";

/** Why the login failed, as a code: the PIN form translates it (messages `Auth.*`). */
export interface LoginError {
  code: LoginErrorCode;
  /** With `invalid`: guesses left from this address before it is locked out. */
  attemptsLeft?: number;
  /** With `rate_limited`: how long the lockout lasts. */
  retryAfterSeconds?: number;
}

export interface LoginState {
  error: LoginError | null;
}

/** Where a successful login may continue: the pages that show the PIN form. Anything else goes home. */
const AFTER_LOGIN = new Set(["/", "/setup"]);

/** Form action of the PIN screen. Returns the failure to display, or redirects to the page that asked (`next`). */
export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const pin = String(formData.get("pin") ?? "").trim();

  let result: LoginResult;
  try {
    result = await attemptLogin(pin);
  } catch (error) {
    log.error("login.store_unreachable", { err: error });
    return {
      error: { code: error instanceof StorageNotConfiguredError ? "storage_not_configured" : "storage_unavailable" },
    };
  }

  if (!result.ok) {
    switch (result.reason) {
      case "malformed":
      case "misconfigured":
        return { error: { code: result.reason } };
      case "rate_limited":
        return { error: { code: "rate_limited", retryAfterSeconds: result.retryAfterSeconds } };
      case "invalid":
        return { error: { code: "invalid", attemptsLeft: result.attemptsLeft } };
    }
  }

  const next = String(formData.get("next") ?? "/");
  const locale = await getLocale();
  return redirect({ href: AFTER_LOGIN.has(next) ? next : "/", locale });
}

export async function logout(): Promise<void> {
  try {
    await endSession();
  } catch (error) {
    // The cookie is already cleared; a stale Redis key simply expires.
    log.error("logout.store_unreachable", { err: error });
  }
  const locale = await getLocale();
  return redirect({ href: "/", locale });
}

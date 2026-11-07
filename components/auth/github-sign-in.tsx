"use client";

import { useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { type StartFailure, startGithubSignIn } from "@/components/auth/start-github";
import { StopCircleIcon } from "@/components/icons";

/** The sign-in failures the callback reports back (`?signin_error=`, lib/sign-in.ts) and the start can answer. */
const ERRORS = [
  "misconfigured",
  "state_invalid",
  "github_denied",
  "github_failed",
  "registration_closed",
  "signup_code_invalid",
  "sudo_mismatch",
  "rate_limited",
  "unavailable",
] as const;
type SignInError = (typeof ERRORS)[number];

function isSignInError(value: string | null): value is SignInError {
  return value !== null && (ERRORS as readonly string[]).includes(value);
}

/**
 * The "Sign in with GitHub" button of a multi-tenant instance, with the
 * failure of the last attempt, if any. `purpose: "signup"` redeems the
 * sign-up code from the /signup link (`code`).
 */
export function GithubSignIn({
  next = "/",
  purpose = "login",
  code,
}: {
  next?: string;
  purpose?: "login" | "signup";
  code?: string;
}) {
  const t = useTranslations("SignIn");
  const locale = useLocale();
  const fromCallback = useSearchParams().get("signin_error");
  const [failure, setFailure] = useState<StartFailure | null>(null);
  const [busy, setBusy] = useState(false);
  const error: SignInError | null = failure ?? (isSignInError(fromCallback) ? fromCallback : null);

  async function signIn() {
    setBusy(true);
    setFailure(null);
    const result = await startGithubSignIn({ purpose, locale, returnTo: next, ...(code && { code }) });
    setFailure(result);
    setBusy(false);
  }

  return (
    <div className="mt-10 max-w-xs">
      <button
        type="button"
        onClick={signIn}
        disabled={busy}
        className="w-full rounded-md bg-ink px-4 py-3 text-base font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {busy ? t("opening") : purpose === "signup" ? t("signup_button") : t("button")}
      </button>
      <p role="alert" className="mt-4 flex min-h-12 items-start gap-2.5 text-sm text-ink">
        {error && (
          <>
            <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />
            <span>{t(`error_${error}`)}</span>
          </>
        )}
      </p>
    </div>
  );
}

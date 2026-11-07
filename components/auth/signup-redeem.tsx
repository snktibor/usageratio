"use client";

import { useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";
import { GithubSignIn, isSignInError, type SignInError } from "@/components/auth/github-sign-in";
import { StopCircleIcon } from "@/components/icons";

/**
 * The /signup and /join links carry their code in the URL fragment
 * (`/signup#code`, `/join#code`), which the browser never sends to a server:
 * it is read here, and only ever leaves in the body of the sign-in's start
 * request.
 *
 * A failed attempt comes back to this page as `?signin_error=` without the
 * fragment (the callback's redirect cannot carry it): the error is shown
 * then, rather than a note that the link is incomplete.
 */
export function SignupRedeem({ purpose = "signup" }: { purpose?: "signup" | "join" }) {
  const t = useTranslations("SignIn");
  const [code, setCode] = useState<string | null | undefined>(undefined);
  const [failed, setFailed] = useState<SignInError | null>(null);

  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    setCode(/^[A-Za-z0-9_-]{43}$/.test(fromHash) ? fromHash : null);
    const error = new URLSearchParams(window.location.search).get("signin_error");
    setFailed(isSignInError(error) ? error : null);
  }, []);

  if (code === undefined) return null;
  if (code === null && failed) {
    return (
      <p role="alert" className="mt-10 flex max-w-md items-start gap-2.5 text-sm text-ink">
        <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />
        <span>{t(`error_${failed}`)}</span>
      </p>
    );
  }
  if (code === null) {
    return (
      <p className="mt-10 max-w-md text-sm text-ink">
        {purpose === "join" ? t("join_missing_code") : t("signup_missing_code")}
      </p>
    );
  }
  return (
    <Suspense>
      <GithubSignIn purpose={purpose} code={code} />
    </Suspense>
  );
}

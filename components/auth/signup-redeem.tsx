"use client";

import { useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";
import { GithubSignIn } from "@/components/auth/github-sign-in";

/**
 * The /signup link carries its code in the URL fragment (`/signup#code`),
 * which the browser never sends to a server: it is read here, and only ever
 * leaves in the body of the sign-in's start request.
 */
export function SignupRedeem() {
  const t = useTranslations("SignIn");
  const [code, setCode] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    setCode(/^[A-Za-z0-9_-]{43}$/.test(fromHash) ? fromHash : null);
  }, []);

  if (code === undefined) return null;
  if (code === null) return <p className="mt-10 max-w-md text-sm text-ink">{t("signup_missing_code")}</p>;
  return (
    <Suspense>
      <GithubSignIn purpose="signup" code={code} />
    </Suspense>
  );
}

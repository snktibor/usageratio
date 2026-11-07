import { getTranslations } from "next-intl/server";
import { Suspense } from "react";
import { logout } from "@/app/actions";
import { GithubSignIn } from "@/components/auth/github-sign-in";
import { LanguageSwitcher } from "@/components/language-switcher";
import { PinGate } from "@/components/pin-gate";
import { isMultiTenant } from "@/lib/registration";
import { currentUserSession } from "@/lib/user-session";

function Frame({
  heading,
  description,
  children,
}: {
  heading: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 pt-6 sm:px-8 sm:pt-8">
      <div className="flex items-center justify-between gap-4">
        <p className="text-lg font-medium tracking-tight">usageratio</p>
        <LanguageSwitcher />
      </div>
      <div className="mt-[18vh]">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">{heading}</h1>
        <p className="mt-4 max-w-md text-ink-2">{description}</p>
        {children}
      </div>
    </main>
  );
}

/**
 * What a visitor without access to a workspace gets: no usage data is ever
 * rendered here. On a single-user instance the PIN screen; in multi-tenant
 * mode the GitHub sign-in, or, for a signed-in user who belongs to no
 * workspace (any more), a note saying so with a way out.
 */
export async function SignInGate({ next = "/" }: { next?: string }) {
  if (!isMultiTenant()) return <PinGate next={next} />;
  const t = await getTranslations("SignIn");

  if (await currentUserSession()) {
    return (
      <Frame heading={t("no_workspace_heading")} description={t("no_workspace_description")}>
        <form action={logout} className="mt-10">
          <button
            type="submit"
            className="rounded-md border border-rule px-4 py-2.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
          >
            {t("sign_out")}
          </button>
        </form>
      </Frame>
    );
  }

  return (
    <Frame heading={t("heading")} description={t("description")}>
      <Suspense>
        <GithubSignIn next={next} />
      </Suspense>
    </Frame>
  );
}

/** The /signup page's frame (app/[locale]/signup/page.tsx). */
export async function SignupFrame({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("SignIn");
  return (
    <Frame heading={t("signup_heading")} description={t("signup_description")}>
      {children}
    </Frame>
  );
}

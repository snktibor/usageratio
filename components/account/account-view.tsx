"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import { PRIMARY_BUTTON, QUIET_BUTTON } from "@/components/ui/classes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Link } from "@/i18n/routing";
import type { AccountView as Account } from "@/lib/account";

function When({ ms }: { ms: number }) {
  const locale = useLocale();
  if (!ms) return <span>—</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} suppressHydrationWarning>
      {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(ms)}
    </time>
  );
}

type DeleteState =
  | { phase: "idle" }
  | { phase: "confirm" }
  | { phase: "busy" }
  | { phase: "sudo" }
  | { phase: "problem"; message: string };

/** The account page (multi-tenant mode): profile, workspaces, sessions, sign out everywhere, delete the account. */
export function AccountView({ account, admin }: { account: Account; admin: boolean }) {
  const t = useTranslations("Account");
  const locale = useLocale();
  const [ending, setEnding] = useState(false);
  const [state, setState] = useState<DeleteState>({ phase: "idle" });

  async function signOutEverywhere() {
    setEnding(true);
    const response = await fetch("/api/account/sessions", { method: "DELETE" }).catch(() => null);
    if (response?.ok) window.location.assign(`/${locale}`);
    else setEnding(false);
  }

  async function deleteAccount() {
    setState({ phase: "busy" });
    const response = await fetch("/api/account", { method: "DELETE" }).catch(() => null);
    if (response?.ok) {
      window.location.assign(`/${locale}`);
      return;
    }
    const error = ((await response?.json().catch(() => null)) as { error?: string } | null)?.error;
    if (error === "sudo_required") setState({ phase: "sudo" });
    else if (error === "owns_shared_workspace") setState({ phase: "problem", message: t("delete_owns_shared") });
    else if (error === "owns_default_workspace") setState({ phase: "problem", message: t("delete_owns_default") });
    else setState({ phase: "problem", message: t("delete_failed") });
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-16 pt-6 sm:px-8 sm:pt-8">
      <header className="flex items-center justify-between gap-4">
        <Link href="/" className="text-lg font-medium tracking-tight">
          usageratio
        </Link>
        {admin && (
          <Link href="/admin" className={QUIET_BUTTON}>
            {t("admin_link")}
          </Link>
        )}
      </header>

      <h1 className="mt-10 text-3xl font-semibold tracking-tight">{t("heading")}</h1>
      <p className="mt-2 text-ink-2">
        {t.rich("signed_in_as", { login: account.login || "—", strong: (chunks) => <strong>{chunks}</strong> })} ·{" "}
        {t("member_since")} <When ms={account.createdAt} />
      </p>

      <section className="mt-10">
        <h2 className="text-lg font-medium">{t("workspaces_heading")}</h2>
        <ul className="mt-3 divide-y divide-rule rounded-md border border-rule">
          {account.workspaces.map((workspace) => (
            <li key={workspace.tenantId} className="flex items-center justify-between gap-4 px-4 py-3">
              <span>
                {workspace.name}
                {workspace.current && <span className="ml-2 text-sm text-ink-3">{t("current")}</span>}
              </span>
              <span className="text-sm text-ink-2">
                {workspace.role === "owner" ? t("role_owner") : t("role_member")} ·{" "}
                {t("members", { count: workspace.members })}
              </span>
            </li>
          ))}
          {account.workspaces.length === 0 && <li className="px-4 py-3 text-ink-2">{t("no_workspaces")}</li>}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-medium">{t("sessions_heading")}</h2>
        <ul className="mt-3 divide-y divide-rule rounded-md border border-rule">
          {account.sessions.map((session) => (
            <li key={session.tag} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
              <span>
                {session.label || t("unknown_browser")}
                {session.current && <span className="ml-2 text-sm text-ink-3">{t("this_session")}</span>}
              </span>
              <span className="text-sm text-ink-2">
                {t("last_seen")} <When ms={session.seenAt} />
              </span>
            </li>
          ))}
        </ul>
        <button type="button" onClick={signOutEverywhere} disabled={ending} className={`mt-4 ${QUIET_BUTTON}`}>
          {t("sign_out_everywhere")}
        </button>
      </section>

      <section className="mt-12 rounded-md border border-critical/40 p-4">
        <h2 className="text-lg font-medium">{t("delete_heading")}</h2>
        <p className="mt-2 text-sm text-ink-2">{t("delete_description")}</p>
        <button
          type="button"
          onClick={() => setState({ phase: "confirm" })}
          disabled={state.phase === "busy"}
          className={`mt-4 ${PRIMARY_BUTTON} bg-critical`}
        >
          {t("delete_button")}
        </button>
        <div aria-live="polite" className="mt-3 space-y-3">
          {state.phase === "problem" && <StatusLine tone="problem">{state.message}</StatusLine>}
          {state.phase === "sudo" && <SudoUnlock prompt={t("delete_sudo")} onUnlocked={deleteAccount} />}
        </div>
      </section>

      {state.phase === "confirm" && (
        <ConfirmDialog
          danger
          countdownSeconds={3}
          title={t("delete_confirm_title")}
          body={t("delete_confirm_body")}
          cancelLabel={t("cancel")}
          confirmLabel={(secondsLeft) =>
            secondsLeft > 0 ? `${t("delete_button")} (${secondsLeft})` : t("delete_button")
          }
          onCancel={() => setState({ phase: "idle" })}
          onConfirm={deleteAccount}
        />
      )}
    </main>
  );
}

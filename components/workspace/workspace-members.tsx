"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from "@/components/ui/classes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { When } from "@/components/ui/when";
import { Link } from "@/i18n/routing";
import type { InviteEntry } from "@/lib/invites";
import type { Member } from "@/lib/members";
import type { WorkspaceView } from "@/lib/workspace";

type Pending = { kind: "remove"; member: Member } | { kind: "transfer"; member: Member } | { kind: "leave" } | null;

type Notice = { tone: "ok" | "problem"; text: string } | null;

async function errorOf(response: Response | null): Promise<string | null> {
  return ((await response?.json().catch(() => null)) as { error?: string } | null)?.error ?? null;
}

/**
 * The workspace page (multi-tenant mode): who belongs, and what the owner
 * (invite, revoke, remove, hand over) or a member (leave) can do about it.
 * Every change goes to /api/workspace/*, which checks the role again; this
 * only leaves out the buttons a role has no use for.
 */
export function WorkspaceMembers({ workspace }: { workspace: WorkspaceView }) {
  const t = useTranslations("Workspace");
  const locale = useLocale();
  const isOwner = workspace.role === "owner";
  const [members, setMembers] = useState(workspace.members);
  const [invites, setInvites] = useState<InviteEntry[]>(workspace.invites);
  const [login, setLogin] = useState("");
  const [newLink, setNewLink] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [revokeTokens, setRevokeTokens] = useState(true);
  const [busy, setBusy] = useState(false);
  const [needsSudo, setNeedsSudo] = useState<Member | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const problem = (error: string | null) => {
    const text =
      error === "too_many_invites"
        ? t("error_too_many_invites")
        : error === "invalid_payload"
          ? t("error_invalid_login")
          : error === "members_busy"
            ? t("error_busy")
            : t("error_failed");
    setNotice({ tone: "problem", text });
  };

  async function createInvite() {
    setBusy(true);
    setNotice(null);
    const response = await fetch("/api/workspace/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: login.trim() || null }),
    }).catch(() => null);
    setBusy(false);
    if (response?.status === 201) {
      const { url, entry } = (await response.json()) as { url: string; entry: InviteEntry };
      setNewLink(url);
      setInvites((list) => [entry, ...list]);
      setLogin("");
      return;
    }
    const error = await errorOf(response);
    if (error !== "tenant_changed") problem(error);
  }

  async function revokeInvite(id: string) {
    const response = await fetch(`/api/workspace/invites/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(
      () => null,
    );
    if (response?.ok || response?.status === 404) setInvites((list) => list.filter((invite) => invite.id !== id));
    else if ((await errorOf(response)) !== "tenant_changed") problem(null);
  }

  async function confirmPending() {
    if (!pending) return;
    setBusy(true);
    setNotice(null);
    const current = pending;
    setPending(null);
    if (current.kind === "remove") {
      const query = revokeTokens ? "?revokeTokens=1" : "";
      const response = await fetch(`/api/workspace/members/${encodeURIComponent(current.member.userId)}${query}`, {
        method: "DELETE",
      }).catch(() => null);
      setBusy(false);
      if (response?.ok) {
        const { tokensRevoked } = (await response.json()) as { tokensRevoked: number };
        setMembers((list) => list.filter((member) => member.userId !== current.member.userId));
        setNotice({ tone: "ok", text: t("removed", { login: current.member.login, count: tokensRevoked }) });
      } else {
        const error = await errorOf(response);
        if (error !== "tenant_changed") problem(error);
      }
      return;
    }
    if (current.kind === "transfer") {
      await transfer(current.member);
      return;
    }
    const response = await fetch("/api/workspace/leave", { method: "POST" }).catch(() => null);
    if (response?.ok) {
      window.location.assign(`/${locale}`);
      return;
    }
    setBusy(false);
    const error = await errorOf(response);
    if (error !== "tenant_changed") problem(error);
  }

  async function transfer(member: Member) {
    setBusy(true);
    setNeedsSudo(null);
    const response = await fetch("/api/workspace/transfer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: member.userId }),
    }).catch(() => null);
    if (response?.ok) {
      window.location.reload();
      return;
    }
    setBusy(false);
    const error = await errorOf(response);
    if (error === "sudo_required") setNeedsSudo(member);
    else if (error !== "tenant_changed") problem(error);
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 pb-16 pt-6 sm:px-8 sm:pt-8">
      <header className="flex items-center justify-between gap-4">
        <Link href="/" className="text-lg font-medium tracking-tight">
          usageratio
        </Link>
        <Link href="/account" className={QUIET_BUTTON}>
          {t("account_link")}
        </Link>
      </header>

      <h1 className="mt-10 text-3xl font-semibold tracking-tight">{workspace.name}</h1>
      <p className="mt-2 text-ink-2">{isOwner ? t("you_own") : t("you_member")}</p>

      <div aria-live="polite" className="mt-6 space-y-3">
        {notice && <StatusLine tone={notice.tone === "ok" ? "good" : "problem"}>{notice.text}</StatusLine>}
        {needsSudo && <SudoUnlock prompt={t("transfer_sudo")} onUnlocked={() => transfer(needsSudo)} />}
      </div>

      <section className="mt-8">
        <h2 className="text-lg font-medium">{t("members_heading")}</h2>
        <ul className="mt-3 divide-y divide-rule rounded-md border border-rule">
          {members.map((member) => (
            <li key={member.userId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
              <span>
                {member.login || "—"}
                {member.userId === workspace.you && <span className="ml-2 text-sm text-ink-3">{t("you")}</span>}
                <span className="ml-2 text-sm text-ink-2">
                  {member.role === "owner" ? t("role_owner") : t("role_member")} · {t("joined")}{" "}
                  <When ms={member.joinedAt} />
                </span>
              </span>
              {isOwner && member.role === "member" && (
                <span className="flex gap-2">
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    disabled={busy}
                    onClick={() => setPending({ kind: "transfer", member })}
                  >
                    {t("make_owner")}
                  </button>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    disabled={busy}
                    onClick={() => {
                      setRevokeTokens(true);
                      setPending({ kind: "remove", member });
                    }}
                  >
                    {t("remove")}
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {!isOwner && <p className="mt-3 text-sm text-ink-2">{t("owner_only_note")}</p>}
      </section>

      {isOwner && (
        <section className="mt-12">
          <h2 className="text-lg font-medium">{t("invites_heading")}</h2>
          <p className="mt-2 max-w-2xl text-sm text-ink-2">{t("invites_description")}</p>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm text-ink-2">
              {t("invite_login_label")}
              <input
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                placeholder={t("invite_login_placeholder")}
                maxLength={65}
                autoComplete="off"
                spellCheck={false}
                className={FIELD}
              />
            </label>
            <button type="button" onClick={createInvite} disabled={busy} className={PRIMARY_BUTTON}>
              {t("create_invite")}
            </button>
          </div>
          {newLink && (
            <div className="mt-4 max-w-2xl space-y-2">
              <p className="text-sm text-ink">{t("new_invite_once")}</p>
              <input
                readOnly
                value={newLink}
                aria-label={t("new_invite_label")}
                className={`w-full font-mono text-xs ${FIELD}`}
                onFocus={(event) => event.currentTarget.select()}
              />
            </div>
          )}
          <ul className="mt-6 divide-y divide-rule rounded-md border border-rule text-sm">
            {invites.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                <span>{invite.login ? t("invite_for", { login: invite.login }) : t("invite_anyone")}</span>
                <span className="text-ink-2">
                  {t("invite_expires")} <When ms={invite.expiresAt} />
                </span>
                <button type="button" onClick={() => revokeInvite(invite.id)} className={QUIET_BUTTON}>
                  {t("revoke")}
                </button>
              </li>
            ))}
            {invites.length === 0 && <li className="px-4 py-3 text-ink-2">{t("no_invites")}</li>}
          </ul>
        </section>
      )}

      {!isOwner && (
        <section className="mt-12 rounded-md border border-rule p-4">
          <h2 className="text-lg font-medium">{t("leave_heading")}</h2>
          <p className="mt-2 text-sm text-ink-2">{t("leave_description")}</p>
          <button
            type="button"
            onClick={() => setPending({ kind: "leave" })}
            disabled={busy}
            className={`mt-4 ${QUIET_BUTTON}`}
          >
            {t("leave_button")}
          </button>
        </section>
      )}

      {pending && (
        <ConfirmDialog
          danger={pending.kind !== "transfer"}
          countdownSeconds={pending.kind === "transfer" ? 3 : 0}
          title={
            pending.kind === "remove"
              ? t("remove_title", { login: pending.member.login })
              : pending.kind === "transfer"
                ? t("transfer_title", { login: pending.member.login })
                : t("leave_title", { name: workspace.name })
          }
          body={
            pending.kind === "remove"
              ? t("remove_body")
              : pending.kind === "transfer"
                ? t("transfer_body")
                : t("leave_description")
          }
          cancelLabel={t("cancel")}
          confirmLabel={(secondsLeft) => {
            const label =
              pending.kind === "remove"
                ? t("remove")
                : pending.kind === "transfer"
                  ? t("make_owner")
                  : t("leave_button");
            return secondsLeft > 0 ? `${label} (${secondsLeft})` : label;
          }}
          onCancel={() => setPending(null)}
          onConfirm={confirmPending}
        >
          {pending.kind === "remove" && (
            <label className="mt-4 flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={revokeTokens}
                onChange={(event) => setRevokeTokens(event.target.checked)}
              />
              {t("remove_tokens")}
            </label>
          )}
        </ConfirmDialog>
      )}
    </main>
  );
}

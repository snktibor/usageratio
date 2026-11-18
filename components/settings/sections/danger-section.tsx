"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { DraftGroup, DraftProvider } from "@/components/settings/draft";
import { ForceDeleteDialog, useDeleteImpact } from "@/components/settings/force-delete-dialog";
import { ManageHistory } from "@/components/settings/sections/manage-history";
import { RecentlyDeleted } from "@/components/settings/sections/recently-deleted";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import { QUIET_BUTTON } from "@/components/ui/classes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Toast } from "@/components/ui/toast";
import { TRASH_RETENTION_DAYS } from "@/lib/config";

/** How long the plain delete confirm button stays disabled after opening. */
const CONFIRM_DELAY_SECONDS = 3;

/** `typed`: the plain confirmation is not enough (the server said the provider has reports after all). */
type Confirm = { id: string; label: string; typed: boolean };
type SudoRetry = { id: string; label: string; force: boolean };

async function errorCode(response: Response): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? null;
}

/**
 * The bottom of the settings panel: what was deleted and can still be
 * restored (Recently deleted), and deleting a provider, offered only for one
 * switched off in the Providers section (accounts-section.tsx). A provider
 * with stored reports needs its name typed, next to a line saying what it
 * deletes, and every delete a fresh PIN (sudo). A forced delete stays in
 * Recently deleted for TRASH_RETENTION_DAYS.
 */
export function DangerSection({
  titleId,
  providers,
  timeZone,
  history,
  canPurge,
  trashVersion,
  onDeleted,
  onGroupRestored,
  onProviderRestored,
  onManaged,
}: {
  titleId: string;
  providers: DraftProvider[];
  timeZone: string;
  /** Whether to show the history of destructive actions: the owner's (false for a workspace member). */
  history: boolean;
  /** Whether Recently deleted offers Delete permanently: the owner's (false for a workspace member). */
  canPurge: boolean;
  /** Changes when something was deleted elsewhere on the panel (a group): Recently deleted loads again. */
  trashVersion: number;
  /** Takes the provider off the panel's lists. */
  onDeleted: (id: string) => void;
  /** A restored group goes back on the panel's lists. */
  onGroupRestored: (group: DraftGroup) => void;
  /** A restored provider goes back on the panel's lists. */
  onProviderRestored: (id: string) => void;
  /** After a provider is deleted, so the rest of the dashboard (outside this dialog) catches up. */
  onManaged: () => void;
}) {
  const t = useTranslations("Settings");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [sudoRetry, setSudoRetry] = useState<SudoRetry | null>(null);
  const deleteImpact = useDeleteImpact(
    confirm ? `/api/providers/${encodeURIComponent(confirm.id)}?force=1&dryRun=1` : null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function performDelete(id: string, label: string, force: boolean) {
    const response = await fetch(`/api/providers/${encodeURIComponent(id)}${force ? "?force=1" : ""}`, {
      method: "DELETE",
    });
    if (response.ok) {
      onDeleted(id);
      setToast(t("manage_provider_deleted_toast", { label }));
      onManaged();
      return;
    }
    const error = await errorCode(response);
    if (error === "sudo_required") {
      setSudoRetry({ id, label, force });
      return;
    }
    if (error === "provider_has_events" && !force) {
      setConfirm({ id, label, typed: true });
      return;
    }
    setProblem(t("manage_provider_delete_failed"));
  }

  const hidden = providers.filter((provider) => !provider.visible);

  return (
    <section aria-labelledby={`${titleId}-danger`} className="rounded-lg border border-critical/40 p-4">
      <h3 id={`${titleId}-danger`} className="font-medium">
        {t("danger_heading")}
      </h3>

      <div className="mt-3">
        <RecentlyDeleted
          timeZone={timeZone}
          canPurge={canPurge}
          reloadKey={trashVersion}
          onGroupRestored={onGroupRestored}
          onProviderRestored={onProviderRestored}
          onManaged={onManaged}
        />
      </div>

      <h4 className="mt-6 text-sm font-medium">{t("provider_delete_heading")}</h4>
      <p className="mt-1 text-sm text-ink-3">{t("provider_delete_explanation")}</p>
      {hidden.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">{t("provider_delete_none")}</p>
      ) : (
        // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none
        <ul role="list" className="mt-3 border-t border-hairline">
          {hidden.map((provider) => (
            <li key={provider.id} className="flex items-center justify-between gap-3 border-b border-hairline py-2">
              <span className="min-w-0 wrap-anywhere">{provider.label}</span>
              <button
                type="button"
                onClick={() => setConfirm({ id: provider.id, label: provider.label, typed: false })}
                aria-label={t("manage_provider_delete_aria", { label: provider.label })}
                className={`shrink-0 text-sm ${QUIET_BUTTON}`}
              >
                {t("provider_delete_button")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div aria-live="polite" className="mt-3 space-y-2.5">
        {problem && <StatusLine tone="problem">{problem}</StatusLine>}
        {sudoRetry && (
          <SudoUnlock
            onUnlocked={() => {
              const retry = sudoRetry;
              setSudoRetry(null);
              void performDelete(retry.id, retry.label, retry.force);
            }}
          />
        )}
      </div>
      {toast && (
        <Toast onDismiss={() => setToast(null)}>
          <StatusLine tone="good">{toast}</StatusLine>
        </Toast>
      )}

      {history && <ManageHistory timeZone={timeZone} />}

      {confirm &&
        // Until the count says the provider has no reports, the typed dialog is the safe default.
        (confirm.typed || deleteImpact.phase !== "ready" || deleteImpact.impact.events > 0 ? (
          <ForceDeleteDialog
            kind="provider"
            name={confirm.id}
            title={t("manage_provider_delete_title")}
            body={t("manage_provider_delete_force_body", { label: confirm.label, days: TRASH_RETENTION_DAYS })}
            impact={deleteImpact}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const { id, label } = confirm;
              setConfirm(null);
              void performDelete(id, label, true);
            }}
          />
        ) : (
          <ConfirmDialog
            title={t("manage_provider_delete_title")}
            body={t("manage_provider_delete_body", { label: confirm.label })}
            cancelLabel={t("cancel")}
            confirmLabel={(secondsLeft) =>
              secondsLeft > 0 ? t("confirm_yes_countdown", { seconds: secondsLeft }) : t("confirm_yes")
            }
            danger
            countdownSeconds={CONFIRM_DELAY_SECONDS}
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              const { id, label } = confirm;
              setConfirm(null);
              void performDelete(id, label, false);
            }}
          />
        ))}
    </section>
  );
}

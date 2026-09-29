"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import type { DraftProvider } from "@/components/settings/draft";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import { QUIET_BUTTON } from "@/components/ui/classes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Toast } from "@/components/ui/toast";

/** How long the force-delete confirm button stays disabled after opening. */
const CONFIRM_DELAY_SECONDS = 3;

type Confirm = { id: string; label: string; force: boolean };
type SudoRetry = { id: string; label: string; force: boolean };

async function errorCode(response: Response): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? null;
}

/**
 * The bottom of the settings panel: actions that cannot be undone. For now
 * that is deleting a provider, offered only for one switched off in the
 * Providers section (accounts-section.tsx). A provider with stored reports
 * needs a second, forced confirmation, and every delete a fresh PIN (sudo).
 */
export function DangerSection({
  titleId,
  providers,
  onDeleted,
  onManaged,
}: {
  titleId: string;
  providers: DraftProvider[];
  /** Takes the provider off the panel's lists. */
  onDeleted: (id: string) => void;
  /** After a provider is deleted, so the rest of the dashboard (outside this dialog) catches up. */
  onManaged: () => void;
}) {
  const t = useTranslations("Settings");
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [sudoRetry, setSudoRetry] = useState<SudoRetry | null>(null);
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
      setConfirm({ id, label, force: true });
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

      <h4 className="mt-3 text-sm font-medium">{t("provider_delete_heading")}</h4>
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
                onClick={() => setConfirm({ id: provider.id, label: provider.label, force: false })}
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

      {confirm && (
        <ConfirmDialog
          title={t("manage_provider_delete_title")}
          body={
            confirm.force
              ? t("manage_provider_delete_force_body", { label: confirm.label })
              : t("manage_provider_delete_body", { label: confirm.label })
          }
          cancelLabel={t("cancel")}
          confirmLabel={(secondsLeft) =>
            secondsLeft > 0 ? t("confirm_yes_countdown", { seconds: secondsLeft }) : t("confirm_yes")
          }
          danger
          countdownSeconds={CONFIRM_DELAY_SECONDS}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { id, label, force } = confirm;
            setConfirm(null);
            void performDelete(id, label, force);
          }}
        />
      )}
    </section>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { XIcon } from "@/components/icons";
import type { DraftProvider } from "@/components/settings/draft";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Toast } from "@/components/ui/toast";
import { ToggleChip } from "@/components/ui/toggle-chip";

/** How long the force-delete confirm button stays disabled after opening. */
const CONFIRM_DELAY_SECONDS = 3;

type Confirm = { id: string; label: string; force: boolean };
type SudoRetry = { id: string; label: string; force: boolean };

async function errorCode(response: Response): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? null;
}

export function AccountsSection({
  titleId,
  providers,
  visibleCount,
  onToggle,
  onManaged,
}: {
  titleId: string;
  providers: DraftProvider[];
  visibleCount: number;
  onToggle: (id: string, visible: boolean) => void;
  /** After a provider is deleted, so the rest of the dashboard (outside this dialog) catches up. */
  onManaged: () => void;
}) {
  const t = useTranslations("Settings");
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [sudoRetry, setSudoRetry] = useState<SudoRetry | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  async function performDelete(id: string, label: string, force: boolean) {
    const response = await fetch(`/api/providers/${encodeURIComponent(id)}${force ? "?force=1" : ""}`, {
      method: "DELETE",
    });
    if (response.ok) {
      setRemovedIds((current) => [...current, id]);
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

  const visible = providers.filter((provider) => !removedIds.includes(provider.id));

  return (
    <section aria-labelledby={`${titleId}-providers`}>
      <h3 id={`${titleId}-providers`} className="font-medium">
        {t("ai_accounts")}
      </h3>
      <div role="group" aria-label={t("visible_ai_accounts")} className="mt-3 flex flex-wrap gap-2">
        {visible.map((provider) => {
          const isLastVisible = provider.visible && visibleCount === 1;
          return (
            <span key={provider.id} className="inline-flex items-center">
              <ToggleChip
                checked={provider.visible}
                onChange={(checked) => onToggle(provider.id, checked)}
                disabled={isLastVisible}
                title={isLastVisible ? t("at_least_one_account_must_be_visible") : undefined}
              >
                {provider.label}
              </ToggleChip>
              {!provider.visible && (
                <button
                  type="button"
                  onClick={() => setConfirm({ id: provider.id, label: provider.label, force: false })}
                  aria-label={t("manage_provider_delete_aria", { label: provider.label })}
                  title={t("manage_provider_delete_aria", { label: provider.label })}
                  className="-ml-1.5 rounded-full p-1.5 text-ink-3 transition-colors hover:text-ink"
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </span>
          );
        })}
      </div>
      <p className="mt-3 text-sm text-ink-3">{t("hidden_account_explanation")}</p>

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

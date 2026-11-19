"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DraftGroup } from "@/components/settings/draft";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import { QUIET_BUTTON } from "@/components/ui/classes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Toast } from "@/components/ui/toast";
import { TRASH_RETENTION_DAYS } from "@/lib/config";
import { formatTimestamp } from "@/lib/format";
import type { TrashEntry } from "@/lib/trash";

/** How long the permanent-delete confirm button stays disabled after opening. */
const CONFIRM_DELAY_SECONDS = 3;

type Load = { phase: "loading" } | { phase: "failed" } | { phase: "ready"; entries: TrashEntry[] };
type Action = { kind: "restore" | "purge"; entry: TrashEntry };

/** The 200 answer of POST /api/trash/[id]/restore that the panel needs. */
interface RestoreAnswer {
  kind: "group" | "provider";
  id: string;
  merged: boolean;
  group?: { id: string; color: string; excluded: string[] };
}

/** A restore refused by a quota (lib/quotas.ts), by its code: the message names what is full and its limit. */
const QUOTA_REFUSALS = {
  too_many_groups: "trash_too_many_groups",
  too_many_providers: "trash_too_many_providers",
  too_many_machines: "trash_too_many_machines",
} as const;
type QuotaRefusalCode = keyof typeof QUOTA_REFUSALS;

/**
 * The groups and providers that were force-deleted, kept for TRASH_RETENTION_DAYS (GET /api/trash,
 * newest first), each with Restore and, for the owner (`canPurge`), Delete permanently. Both need a
 * fresh PIN (sudo), asked for here and the action then tried again. Loads when it mounts; the
 * "loading" line is gone as soon as the list has come back, or failed.
 */
export function RecentlyDeleted({
  timeZone,
  canPurge,
  reloadKey,
  onGroupRestored,
  onProviderRestored,
  onManaged,
}: {
  timeZone: string;
  /** Whether to offer Delete permanently: the owner's (false for a workspace member). */
  canPurge: boolean;
  /** Loads the list again whenever it changes (something was deleted elsewhere on the panel). */
  reloadKey: number;
  /** A group is back: adds it to the lists (or marks the one a report re-created as having reports again). */
  onGroupRestored: (group: DraftGroup) => void;
  /** A provider is back: takes it off the panel's "deleted" set. */
  onProviderRestored: (id: string) => void;
  /** After a restore or a permanent delete, so the rest of the dashboard catches up. */
  onManaged: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Settings");
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [purgeConfirm, setPurgeConfirm] = useState<TrashEntry | null>(null);
  const [sudoRetry, setSudoRetry] = useState<Action | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const mounted = useRef(true);

  const fetchEntries = useCallback(async (): Promise<Load> => {
    try {
      const response = await fetch("/api/trash", { cache: "no-store" });
      if (!response.ok) return { phase: "failed" };
      const payload = (await response.json()) as { entries?: TrashEntry[] };
      return Array.isArray(payload.entries) ? { phase: "ready", entries: payload.entries } : { phase: "failed" };
    } catch {
      return { phase: "failed" };
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `reloadKey` is the trigger: a new value loads the list again
  useEffect(() => {
    mounted.current = true;
    void fetchEntries().then((next) => {
      if (mounted.current) setLoad(next);
    });
    return () => {
      mounted.current = false;
    };
  }, [fetchEntries, reloadKey]);

  /** After an action: the list is replaced without going back to "loading". */
  async function reload() {
    const next = await fetchEntries();
    if (mounted.current) setLoad(next);
  }

  async function perform({ kind, entry }: Action) {
    setProblem(null);
    setBusy(entry.id);
    try {
      const url = `/api/trash/${encodeURIComponent(entry.id)}`;
      const response =
        kind === "restore" ? await fetch(`${url}/restore`, { method: "POST" }) : await fetch(url, { method: "DELETE" });
      if (response.ok) {
        if (kind === "restore") {
          const answer = (await response.json()) as RestoreAnswer;
          if (answer.kind === "group" && answer.group) {
            onGroupRestored({
              id: answer.group.id,
              color: answer.group.color,
              colorText: answer.group.color,
              hasReports: true,
              excluded: answer.group.excluded,
            });
          } else if (answer.kind === "provider") {
            onProviderRestored(answer.id);
          }
          setToast(
            answer.merged
              ? t("trash_restored_merged_toast", { name: entry.name })
              : t("trash_restored_toast", { name: entry.name }),
          );
        }
        onManaged();
        await reload();
        return;
      }
      const payload = (await response.json().catch(() => null)) as { error?: string; limit?: number } | null;
      const error = payload?.error ?? null;
      if (error === "sudo_required") {
        setSudoRetry({ kind, entry });
        return;
      }
      if (response.status === 404) {
        setProblem(t("trash_gone"));
        await reload();
        return;
      }
      setProblem(
        response.status === 409 && error !== null && error in QUOTA_REFUSALS
          ? t(QUOTA_REFUSALS[error as QuotaRefusalCode], { limit: Number(payload?.limit) })
          : t("trash_action_failed"),
      );
    } catch {
      setProblem(t("trash_action_failed"));
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  return (
    <div>
      <h4 className="text-sm font-medium">{t("trash_heading")}</h4>

      {load.phase === "loading" ? (
        <p className="mt-3 text-sm text-ink-3">{t("loading_status")}</p>
      ) : load.phase === "failed" ? (
        <p className="mt-3 text-sm text-ink-2">{t("trash_load_failed")}</p>
      ) : load.entries.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">{t("trash_empty")}</p>
      ) : (
        // Folded away like the history below it: the panel shows how many there are, the list opens on demand.
        <details className="mt-2">
          <summary className="cursor-pointer text-sm text-ink-2">
            {t("trash_show", { count: load.entries.length })}
          </summary>
          <p className="mt-3 text-sm text-ink-3">{t("trash_explanation", { days: TRASH_RETENTION_DAYS })}</p>
          {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none */}
          <ul role="list" className="mt-3 border-t border-hairline">
            {load.entries.map((entry) => (
              <li key={entry.id} className="border-b border-hairline py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 wrap-anywhere">{entry.name}</span>
                    <span className="shrink-0 rounded-full border border-ink-3 px-2.5 py-0.5 text-xs text-ink">
                      {t(`trash_kind_${entry.kind}`)}
                    </span>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void perform({ kind: "restore", entry })}
                      aria-label={t("trash_restore_aria", { name: entry.name })}
                      className={`text-sm ${QUIET_BUTTON}`}
                    >
                      {t("trash_restore_button")}
                    </button>
                    {canPurge && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => setPurgeConfirm(entry)}
                        aria-label={t("trash_purge_aria", { name: entry.name })}
                        className={`text-sm ${QUIET_BUTTON}`}
                      >
                        {t("trash_purge_button")}
                      </button>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-sm text-ink-3">
                  {t("trash_entry_meta", {
                    deletedAt: formatTimestamp(entry.deletedAt, timeZone, locale),
                    events: entry.affected.events,
                    expiresAt: formatTimestamp(entry.expiresAt, timeZone, locale),
                  })}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div aria-live="polite" className="mt-3 space-y-2.5">
        {problem && <StatusLine tone="problem">{problem}</StatusLine>}
        {sudoRetry && (
          <SudoUnlock
            onUnlocked={() => {
              const retry = sudoRetry;
              setSudoRetry(null);
              void perform(retry);
            }}
          />
        )}
      </div>
      {toast && (
        <Toast onDismiss={() => setToast(null)}>
          <StatusLine tone="good">{toast}</StatusLine>
        </Toast>
      )}

      {purgeConfirm && (
        <ConfirmDialog
          title={t("trash_purge_title")}
          body={t("trash_purge_body", { name: purgeConfirm.name, events: purgeConfirm.affected.events })}
          cancelLabel={t("cancel")}
          confirmLabel={(secondsLeft) =>
            secondsLeft > 0 ? t("confirm_yes_countdown", { seconds: secondsLeft }) : t("confirm_yes")
          }
          danger
          countdownSeconds={CONFIRM_DELAY_SECONDS}
          onCancel={() => setPurgeConfirm(null)}
          onConfirm={() => {
            const entry = purgeConfirm;
            setPurgeConfirm(null);
            void perform({ kind: "purge", entry });
          }}
        />
      )}
    </div>
  );
}

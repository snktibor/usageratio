"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { Swatch } from "@/components/group-breakdown";
import { XIcon } from "@/components/icons";
import type { DraftGroup } from "@/components/settings/draft";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import { FIELD, QUIET_BUTTON } from "@/components/ui/classes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Toast } from "@/components/ui/toast";
import { INACTIVE_MACHINE_DAYS } from "@/lib/config";
import { formatAgo } from "@/lib/format";
import { providerLabel } from "@/lib/providers";

/** How long the delete/prune confirm buttons stay disabled after opening. */
const CONFIRM_DELAY_SECONDS = 3;
const INACTIVE_MS = INACTIVE_MACHINE_DAYS * 24 * 60 * 60 * 1000;

interface Machine {
  providerId: string;
  machineId: string;
  groupId: string;
  lastSeenAt: number;
  lastTokens: number;
}

type Load = { phase: "loading" } | { phase: "failed" } | { phase: "ready"; machines: Machine[] };
type SudoRetry = { kind: "delete"; machine: Machine } | { kind: "prune" };

function machineKey(machine: Pick<Machine, "providerId" | "machineId">): string {
  return `${machine.providerId}:${machine.machineId}`;
}

async function errorCode(response: Response): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? null;
}

/**
 * The settings panel's Machines section: lists every known machine (grouped
 * implicitly by provider through the provider label next to each row), with
 * an inline rename and a delete button per row, and a bulk "remove N silent
 * machines" action. Fetches its own data (GET /api/machines) independently of
 * the panel's draft, the same way TokenSection owns the API token's status.
 */
export function MachinesSection({
  titleId,
  groups,
  onManaged,
}: {
  titleId: string;
  groups: DraftGroup[];
  onManaged: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Settings");
  const tWidgets = useTranslations("Widgets");
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [rowProblem, setRowProblem] = useState<{ key: string; message: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Machine | null>(null);
  const [pendingPrune, setPendingPrune] = useState(false);
  const [sudoRetry, setSudoRetry] = useState<SudoRetry | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function reload() {
    setLoad({ phase: "loading" });
    fetch("/api/machines", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw response.status;
        const payload = (await response.json()) as { machines: Machine[] };
        setLoad({ phase: "ready", machines: payload.machines });
      })
      .catch(() => setLoad({ phase: "failed" }));
  }

  useEffect(reload, []);

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const machines = load.phase === "ready" ? load.machines : [];
  const now = Date.now();
  const silentCount = machines.filter((machine) => now - machine.lastSeenAt > INACTIVE_MS).length;

  function cancelEdit() {
    setEditing(null);
  }

  async function commitEdit(machine: Machine) {
    setEditing((current) => {
      if (!current || current.key !== machineKey(machine)) return current;
      const newId = current.value.trim();
      if (newId === machine.machineId || newId.length === 0) return null;
      void (async () => {
        const response = await fetch(
          `/api/machines/${encodeURIComponent(machine.providerId)}/${encodeURIComponent(machine.machineId)}`,
          { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: newId }) },
        );
        if (response.ok) {
          setEditing(null);
          setRowProblem(null);
          setLoad((load) =>
            load.phase === "ready"
              ? {
                  phase: "ready",
                  machines: load.machines.map((entry) => (entry === machine ? { ...entry, machineId: newId } : entry)),
                }
              : load,
          );
          setToast(t("manage_machines_renamed_toast", { from: machine.machineId, to: newId }));
          onManaged();
          return;
        }
        const error = await errorCode(response);
        setRowProblem({
          key: machineKey(machine),
          message:
            error === "machine_exists"
              ? t("manage_machines_rename_exists", { id: newId })
              : error === "invalid_payload"
                ? t("manage_machines_rename_invalid")
                : t("manage_machines_action_failed"),
        });
      })();
      return current;
    });
  }

  async function performDelete(machine: Machine) {
    const response = await fetch(
      `/api/machines/${encodeURIComponent(machine.providerId)}/${encodeURIComponent(machine.machineId)}`,
      { method: "DELETE" },
    );
    if (response.ok) {
      setLoad((load) =>
        load.phase === "ready"
          ? { phase: "ready", machines: load.machines.filter((entry) => entry !== machine) }
          : load,
      );
      setToast(t("manage_machines_deleted_toast", { id: machine.machineId }));
      onManaged();
      return;
    }
    const error = await errorCode(response);
    if (error === "sudo_required") {
      setSudoRetry({ kind: "delete", machine });
      return;
    }
    setProblem(t("manage_machines_action_failed"));
  }

  async function performPrune() {
    const response = await fetch("/api/machines/prune", { method: "POST" });
    if (response.ok) {
      const payload = (await response.json()) as { affected: { machines: number } };
      setToast(t("manage_machines_pruned_toast", { count: payload.affected.machines }));
      reload();
      onManaged();
      return;
    }
    const error = await errorCode(response);
    if (error === "sudo_required") {
      setSudoRetry({ kind: "prune" });
      return;
    }
    setProblem(t("manage_machines_action_failed"));
  }

  return (
    <section aria-labelledby={`${titleId}-machines`}>
      <h3 id={`${titleId}-machines`} className="font-medium">
        {t("manage_machines_heading")}
      </h3>

      {load.phase === "loading" ? (
        <p className="mt-3 text-sm text-ink-3">{t("loading_status")}</p>
      ) : load.phase === "failed" ? (
        <StatusLine tone="problem">{t("manage_machines_load_failed")}</StatusLine>
      ) : machines.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">{t("manage_machines_empty")}</p>
      ) : (
        // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none
        <ul role="list" className="mt-3 border-t border-hairline">
          {machines.map((machine) => {
            const key = machineKey(machine);
            const group = groupById.get(machine.groupId);
            const isEditing = editing?.key === key;
            return (
              <li key={key} className="border-b border-hairline py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  {isEditing ? (
                    <input
                      // biome-ignore lint/a11y/noAutofocus: opened by the user's own click, into the field they meant to edit
                      autoFocus
                      type="text"
                      value={editing.value}
                      maxLength={64}
                      onChange={(event) => setEditing({ key, value: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void commitEdit(machine);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelEdit();
                        }
                      }}
                      onBlur={cancelEdit}
                      aria-label={t("manage_machines_rename_aria", { id: machine.machineId })}
                      className={`min-w-0 grow font-mono text-sm ${FIELD}`}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setRowProblem(null);
                        setEditing({ key, value: machine.machineId });
                      }}
                      title={t("manage_machines_rename_hint")}
                      className="min-w-0 grow truncate text-left wrap-anywhere hover:underline"
                    >
                      {machine.machineId}
                    </button>
                  )}
                  <span className="flex shrink-0 items-center gap-1.5 text-sm text-ink-3">
                    <Swatch color={group?.color ?? "#6b6a65"} />
                    <span className="wrap-anywhere">{machine.groupId}</span>
                  </span>
                  <span className="shrink-0 text-sm text-ink-3">{providerLabel(machine.providerId)}</span>
                  <time dateTime={new Date(machine.lastSeenAt).toISOString()} className="shrink-0 text-sm text-ink-3">
                    {formatAgo(machine.lastSeenAt, now, locale, tWidgets("now"))}
                  </time>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(machine)}
                    aria-label={t("manage_machines_delete_aria", { id: machine.machineId })}
                    className="rounded-md p-2 text-ink-3 transition-colors hover:text-ink"
                  >
                    <XIcon />
                  </button>
                </div>
                {rowProblem?.key === key && (
                  <p role="alert" className="mt-1.5 text-sm text-critical">
                    {rowProblem.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {load.phase === "ready" && silentCount > 0 && (
        <button type="button" onClick={() => setPendingPrune(true)} className={`mt-4 ${QUIET_BUTTON}`}>
          {t("manage_machines_prune_button", { count: silentCount })}
        </button>
      )}

      <div aria-live="polite" className="mt-3 space-y-2.5">
        {problem && <StatusLine tone="problem">{problem}</StatusLine>}
        {sudoRetry && (
          <SudoUnlock
            onUnlocked={() => {
              const retry = sudoRetry;
              setSudoRetry(null);
              if (retry.kind === "delete") void performDelete(retry.machine);
              else void performPrune();
            }}
          />
        )}
      </div>
      {toast && (
        <Toast onDismiss={() => setToast(null)}>
          <StatusLine tone="good">{toast}</StatusLine>
        </Toast>
      )}

      <p className="mt-4 text-sm text-ink-3">{t("manage_clients_note")}</p>

      {pendingDelete && (
        <ConfirmDialog
          title={t("manage_machines_delete_title")}
          body={t("manage_machines_delete_body", { id: pendingDelete.machineId })}
          cancelLabel={t("cancel")}
          confirmLabel={(secondsLeft) =>
            secondsLeft > 0 ? t("confirm_yes_countdown", { seconds: secondsLeft }) : t("confirm_yes")
          }
          danger
          countdownSeconds={CONFIRM_DELAY_SECONDS}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const machine = pendingDelete;
            setPendingDelete(null);
            void performDelete(machine);
          }}
        />
      )}

      {pendingPrune && (
        <ConfirmDialog
          title={t("manage_machines_prune_confirm_title")}
          body={t("manage_machines_prune_confirm_body", { count: silentCount, days: INACTIVE_MACHINE_DAYS })}
          cancelLabel={t("cancel")}
          confirmLabel={(secondsLeft) =>
            secondsLeft > 0 ? t("confirm_yes_countdown", { seconds: secondsLeft }) : t("confirm_yes")
          }
          danger
          countdownSeconds={CONFIRM_DELAY_SECONDS}
          onCancel={() => setPendingPrune(false)}
          onConfirm={() => {
            setPendingPrune(false);
            void performPrune();
          }}
        />
      )}
    </section>
  );
}

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
import { type MachineEntry, type MachineRow, machineRows, renameConflicts } from "@/lib/machine-rows";
import { providerLabel } from "@/lib/providers";

/** How long the delete/prune confirm buttons stay disabled after opening. */
const CONFIRM_DELAY_SECONDS = 3;
const INACTIVE_MS = INACTIVE_MACHINE_DAYS * 24 * 60 * 60 * 1000;

type Load = { phase: "loading" } | { phase: "failed" } | { phase: "ready"; machines: MachineEntry[] };
/** A delete resumes with the entries it has not removed yet. */
type SudoRetry = { kind: "delete"; machineId: string; entries: MachineEntry[] } | { kind: "prune" };

async function errorCode(response: Response): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? null;
}

function entryUrl(entry: MachineEntry): string {
  return `/api/machines/${encodeURIComponent(entry.providerId)}/${encodeURIComponent(entry.machineId)}`;
}

function sameEntry(a: MachineEntry, b: MachineEntry): boolean {
  return a.providerId === b.providerId && a.machineId === b.machineId;
}

function providerList(providerIds: string[]): string {
  return providerIds.map(providerLabel).join(", ");
}

/**
 * The settings panel's Machines section: one row per machine (lib/machine-rows.ts),
 * tagged with the providers it reports for, with an inline rename and a
 * delete button per row, and a bulk "remove N silent machines" action. A
 * rename or delete runs on every provider's entry of the machine, one
 * request each, and stops at the first failure; when that leaves the
 * machine half done, it says so and reloads the list. Fetches its own data
 * (GET /api/machines) independently of the panel's draft, the same way
 * TokenSection owns the API token's status.
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
  const [renaming, setRenaming] = useState(false);
  const [rowProblem, setRowProblem] = useState<{ key: string; message: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MachineRow | null>(null);
  const [pendingPrune, setPendingPrune] = useState(false);
  const [sudoRetry, setSudoRetry] = useState<SudoRetry | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function reload() {
    setLoad({ phase: "loading" });
    fetch("/api/machines", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw response.status;
        const payload = (await response.json()) as { machines: MachineEntry[] };
        setLoad({ phase: "ready", machines: payload.machines });
      })
      .catch(() => setLoad({ phase: "failed" }));
  }

  useEffect(reload, []);

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const entries = load.phase === "ready" ? load.machines : [];
  const rows = useMemo(() => machineRows(entries), [entries]);
  const now = Date.now();
  const silentCount = rows.filter((row) => now - row.lastSeenAt > INACTIVE_MS).length;

  function updateEntries(change: (machines: MachineEntry[]) => MachineEntry[]) {
    setLoad((current) =>
      current.phase === "ready" ? { phase: "ready", machines: change(current.machines) } : current,
    );
  }

  function cancelEdit() {
    if (!renaming) setEditing(null);
  }

  async function commitEdit(row: MachineRow) {
    if (!editing || editing.key !== row.machineId || renaming) return;
    const newId = editing.value.trim();
    if (newId === row.machineId || newId.length === 0) {
      setEditing(null);
      return;
    }
    // Refused for one provider means refused for all: nothing is renamed rather than half of it.
    const conflicts = renameConflicts(entries, row, newId);
    if (conflicts.length > 0) {
      setRowProblem({
        key: row.machineId,
        message: t("manage_machines_rename_exists", { id: newId, providers: providerList(conflicts) }),
      });
      return;
    }

    setRenaming(true);
    setProblem(null);
    const done: string[] = [];
    let failure: { entry: MachineEntry; error: string | null } | null = null;
    for (const entry of row.entries) {
      const response = await fetch(entryUrl(entry), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: newId }),
      }).catch(() => null);
      if (response?.ok) {
        done.push(entry.providerId);
        continue;
      }
      failure = { entry, error: response ? await errorCode(response) : null };
      break;
    }
    setRenaming(false);

    if (!failure) {
      setEditing(null);
      setRowProblem(null);
      updateEntries((machines) =>
        machines.map((machine) =>
          row.entries.some((entry) => sameEntry(entry, machine)) ? { ...machine, machineId: newId } : machine,
        ),
      );
      setToast(t("manage_machines_renamed_toast", { from: row.machineId, to: newId }));
      onManaged();
      return;
    }

    if (done.length === 0) {
      setRowProblem({
        key: row.machineId,
        message:
          failure.error === "machine_exists"
            ? t("manage_machines_rename_exists", { id: newId, providers: providerLabel(failure.entry.providerId) })
            : failure.error === "invalid_payload"
              ? t("manage_machines_rename_invalid")
              : t("manage_machines_action_failed"),
      });
      return;
    }

    // Half renamed: say which providers moved and which did not, and show the list as it now is.
    setEditing(null);
    setRowProblem(null);
    setProblem(
      t("manage_machines_rename_partial", {
        from: row.machineId,
        to: newId,
        done: providerList(done),
        failed: providerList(row.entries.slice(done.length).map((entry) => entry.providerId)),
      }),
    );
    reload();
    onManaged();
  }

  async function performDelete(machineId: string, toDelete: MachineEntry[]) {
    setProblem(null);
    const done: string[] = [];
    for (const [index, entry] of toDelete.entries()) {
      const response = await fetch(entryUrl(entry), { method: "DELETE" }).catch(() => null);
      // Already gone (404) is as good as deleted.
      if (response && (response.ok || response.status === 404)) {
        done.push(entry.providerId);
        updateEntries((machines) => machines.filter((machine) => !sameEntry(machine, entry)));
        continue;
      }
      const error = response ? await errorCode(response) : null;
      if (error === "sudo_required") {
        setSudoRetry({ kind: "delete", machineId, entries: toDelete.slice(index) });
        return;
      }
      setProblem(
        done.length === 0
          ? t("manage_machines_action_failed")
          : t("manage_machines_delete_partial", {
              id: machineId,
              done: providerList(done),
              failed: providerList(toDelete.slice(index).map((rest) => rest.providerId)),
            }),
      );
      if (done.length > 0) {
        reload();
        onManaged();
      }
      return;
    }
    setToast(t("manage_machines_deleted_toast", { id: machineId }));
    onManaged();
  }

  async function performPrune() {
    const count = silentCount;
    const response = await fetch("/api/machines/prune", { method: "POST" });
    if (response.ok) {
      setToast(t("manage_machines_pruned_toast", { count }));
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
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">{t("manage_machines_empty")}</p>
      ) : (
        // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none
        <ul role="list" className="mt-3 border-t border-hairline">
          {rows.map((row) => {
            const key = row.machineId;
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
                      readOnly={renaming}
                      onChange={(event) => setEditing({ key, value: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void commitEdit(row);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelEdit();
                        }
                      }}
                      onBlur={cancelEdit}
                      aria-label={t("manage_machines_rename_aria", { id: row.machineId })}
                      className={`min-w-0 grow font-mono text-sm ${FIELD}`}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setRowProblem(null);
                        setEditing({ key, value: row.machineId });
                      }}
                      title={t("manage_machines_rename_hint")}
                      className="min-w-0 grow truncate text-left wrap-anywhere hover:underline"
                    >
                      {row.machineId}
                    </button>
                  )}
                  {row.groupIds.map((groupId) => (
                    <span key={groupId} className="flex shrink-0 items-center gap-1.5 text-sm text-ink-3">
                      <Swatch color={groupById.get(groupId)?.color ?? "#6b6a65"} />
                      <span className="wrap-anywhere">{groupId}</span>
                    </span>
                  ))}
                  <time dateTime={new Date(row.lastSeenAt).toISOString()} className="shrink-0 text-sm text-ink-3">
                    {formatAgo(row.lastSeenAt, now, locale, tWidgets("now"))}
                  </time>
                  <button
                    type="button"
                    onClick={() => setPendingDelete(row)}
                    aria-label={t("manage_machines_delete_aria", { id: row.machineId })}
                    className="rounded-md p-2 text-ink-3 transition-colors hover:text-ink"
                  >
                    <XIcon />
                  </button>
                </div>
                <ul
                  // biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none
                  role="list"
                  aria-label={t("manage_machines_providers_aria")}
                  className="mt-1 flex flex-wrap gap-1.5"
                >
                  {row.entries.map((entry) => (
                    <li
                      key={entry.providerId}
                      className="rounded-full border border-rule px-2 py-0.5 text-xs text-ink-2"
                    >
                      {providerLabel(entry.providerId)}
                    </li>
                  ))}
                </ul>
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
              if (retry.kind === "delete") void performDelete(retry.machineId, retry.entries);
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
          body={t("manage_machines_delete_body", {
            id: pendingDelete.machineId,
            providers: providerList(pendingDelete.entries.map((entry) => entry.providerId)),
          })}
          cancelLabel={t("cancel")}
          confirmLabel={(secondsLeft) =>
            secondsLeft > 0 ? t("confirm_yes_countdown", { seconds: secondsLeft }) : t("confirm_yes")
          }
          danger
          countdownSeconds={CONFIRM_DELAY_SECONDS}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const row = pendingDelete;
            setPendingDelete(null);
            void performDelete(row.machineId, row.entries);
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

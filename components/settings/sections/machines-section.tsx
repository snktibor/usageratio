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

/** How long the delete/merge/prune confirm buttons stay disabled after opening. */
const CONFIRM_DELAY_SECONDS = 3;
const INACTIVE_MS = INACTIVE_MACHINE_DAYS * 24 * 60 * 60 * 1000;

type Load = { phase: "loading" } | { phase: "failed" } | { phase: "ready"; machines: MachineEntry[] };
/** A merge of `row` into the machine called `to`, which keeps its name and `groupId`. */
type PendingMerge = { row: MachineRow; to: string; groupId: string };
/**
 * The merge dialog: the question, then the merge running inside it, asking for
 * the PIN there when it needs one; `entries` are the ones not merged yet.
 */
type MergeDialog = { merge: PendingMerge; entries: MachineEntry[]; phase: "confirm" | "busy" | "pin" };
/** A delete resumes with the entries it has not removed yet. */
type SudoRetry = { kind: "delete"; machineId: string; entries: MachineEntry[] } | { kind: "prune" };
/** The body of PATCH /api/machines/[provider]/[machine]. */
type Move = { id?: string; group?: string; merge?: true };
type MoveOutcome = { done: MachineEntry[]; failure: { entry: MachineEntry; error: string | null } | null };

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

/** Sends `move` for each entry in turn, stopping at the first failure. */
async function patchEntries(entries: MachineEntry[], move: Move): Promise<MoveOutcome> {
  const done: MachineEntry[] = [];
  for (const entry of entries) {
    const response = await fetch(entryUrl(entry), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(move),
    }).catch(() => null);
    if (response?.ok) {
      done.push(entry);
      continue;
    }
    return { done, failure: { entry, error: response ? await errorCode(response) : null } };
  }
  return { done, failure: null };
}

/**
 * The settings panel's Machines section: one row per machine (lib/machine-rows.ts),
 * tagged with the providers it reports for, with an inline rename, a group
 * picker and a delete button per row, and a bulk "remove N silent machines"
 * action. Renaming onto another machine's name offers to merge the two
 * (lib/machine-merge.ts). Every action runs on each provider's entry of the
 * machine, one request each, and stops at the first failure; when that leaves
 * the machine half done, it says so and reloads the list. Fetches its own data
 * (GET /api/machines) independently of the panel's draft, the same way
 * TokenSection owns the API token's status.
 */
export function MachinesSection({
  titleId,
  groups,
  onManaged,
  onMachineIds,
}: {
  titleId: string;
  groups: DraftGroup[];
  onManaged: () => void;
  /** Every machine id on the list, sorted, each time the list changes: the token section binds tokens to them. */
  onMachineIds?: (ids: string[]) => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Settings");
  const tWidgets = useTranslations("Widgets");
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [editing, setEditing] = useState<{ key: string; value: string } | null>(null);
  const [moving, setMoving] = useState(false);
  const [rowProblem, setRowProblem] = useState<{ key: string; message: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<MachineRow | null>(null);
  const [pendingPrune, setPendingPrune] = useState(false);
  const [mergeDialog, setMergeDialog] = useState<MergeDialog | null>(null);
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

  useEffect(() => {
    if (load.phase === "ready") onMachineIds?.(rows.map((row) => row.machineId).sort((a, b) => a.localeCompare(b)));
  }, [load.phase, rows, onMachineIds]);

  function updateEntries(change: (machines: MachineEntry[]) => MachineEntry[]) {
    setLoad((current) =>
      current.phase === "ready" ? { phase: "ready", machines: change(current.machines) } : current,
    );
  }

  function cancelEdit() {
    if (!moving) setEditing(null);
  }

  /** What to say when a move was refused outright. */
  function moveProblem(failure: NonNullable<MoveOutcome["failure"]>, move: Move): string {
    switch (failure.error) {
      case "machine_exists":
        return t("manage_machines_rename_exists", {
          id: move.id ?? "",
          providers: providerLabel(failure.entry.providerId),
        });
      case "invalid_payload":
        return t("manage_machines_rename_invalid");
      case "group_not_found":
        return t("manage_machines_group_not_saved", { group: move.group ?? "" });
      case "merge_unsupported":
        return t("manage_machines_merge_unsupported");
      default:
        return t("manage_machines_action_failed");
    }
  }

  async function commitEdit(row: MachineRow) {
    if (!editing || editing.key !== row.machineId || moving) return;
    const newId = editing.value.trim();
    if (newId === row.machineId || newId.length === 0) {
      setEditing(null);
      return;
    }
    // Onto a name another machine already has: that is a merge, which asks first.
    if (renameConflicts(entries, row, newId).length > 0) {
      const target = rows.find((candidate) => candidate.machineId === newId);
      setEditing(null);
      setRowProblem(null);
      const merge = { row, to: newId, groupId: target?.groupIds[0] ?? row.groupIds[0] ?? "" };
      setMergeDialog({ merge, entries: row.entries, phase: "confirm" });
      return;
    }

    setMoving(true);
    setProblem(null);
    const move: Move = { id: newId };
    const { done, failure } = await patchEntries(row.entries, move);
    setMoving(false);

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
      setRowProblem({ key: row.machineId, message: moveProblem(failure, move) });
      return;
    }

    // Half renamed: say which providers moved and which did not, and show the list as it now is.
    setEditing(null);
    setRowProblem(null);
    setProblem(
      t("manage_machines_rename_partial", {
        from: row.machineId,
        to: newId,
        done: providerList(done.map((entry) => entry.providerId)),
        failed: providerList(row.entries.slice(done.length).map((entry) => entry.providerId)),
      }),
    );
    reload();
    onManaged();
  }

  async function changeGroup(row: MachineRow, groupId: string) {
    if (moving || groupId.length === 0) return;
    setMoving(true);
    setProblem(null);
    setRowProblem(null);
    const move: Move = { group: groupId };
    const { done, failure } = await patchEntries(row.entries, move);
    setMoving(false);

    if (!failure) {
      updateEntries((machines) =>
        machines.map((machine) =>
          row.entries.some((entry) => sameEntry(entry, machine)) ? { ...machine, groupId } : machine,
        ),
      );
      setToast(t("manage_machines_group_moved_toast", { id: row.machineId, group: groupId }));
      onManaged();
      return;
    }
    if (done.length === 0) {
      setRowProblem({ key: row.machineId, message: moveProblem(failure, move) });
      return;
    }
    setProblem(
      t("manage_machines_move_partial", {
        id: row.machineId,
        done: providerList(done.map((entry) => entry.providerId)),
        failed: providerList(row.entries.slice(done.length).map((entry) => entry.providerId)),
      }),
    );
    reload();
    onManaged();
  }

  /** Runs inside the merge dialog, which stays open until it is done or asks for the PIN. */
  async function performMerge(merge: PendingMerge, toMerge: MachineEntry[]) {
    setMergeDialog({ merge, entries: toMerge, phase: "busy" });
    setMoving(true);
    setProblem(null);
    const move: Move = { id: merge.to, group: merge.groupId, merge: true };
    const { done, failure } = await patchEntries(toMerge, move);
    setMoving(false);

    if (failure?.error === "sudo_required") {
      setMergeDialog({ merge, entries: toMerge.slice(done.length), phase: "pin" });
    } else {
      setMergeDialog(null);
    }
    if (!failure) {
      setToast(t("manage_machines_merged_toast", { from: merge.row.machineId, to: merge.to }));
    } else if (failure.error === "sudo_required") {
      // Asked for in the dialog.
    } else if (done.length === 0) {
      setProblem(moveProblem(failure, move));
    } else {
      setProblem(
        t("manage_machines_move_partial", {
          id: merge.row.machineId,
          done: providerList(done.map((entry) => entry.providerId)),
          failed: providerList(toMerge.slice(done.length).map((entry) => entry.providerId)),
        }),
      );
    }
    // A merge reshapes both rows: show the list as the store now has it.
    if (done.length > 0) {
      reload();
      onManaged();
    }
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

  const sudoPrompt = sudoRetry && (
    <SudoUnlock
      autoFocus
      prompt={t("manage_sudo_prompt")}
      onUnlocked={() => {
        const retry = sudoRetry;
        setSudoRetry(null);
        if (retry.kind === "delete") void performDelete(retry.machineId, retry.entries);
        else void performPrune();
      }}
    />
  );

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
                      readOnly={moving}
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
                  <span className="flex shrink-0 items-center gap-1.5 text-sm text-ink-3">
                    <Swatch color={groupById.get(row.groupIds[0] ?? "")?.color ?? "#6b6a65"} />
                    <select
                      value={row.groupIds.length === 1 ? row.groupIds[0] : ""}
                      disabled={moving}
                      onChange={(event) => void changeGroup(row, event.target.value)}
                      aria-label={t("manage_machines_group_aria", { id: row.machineId })}
                      className="w-32 rounded-md border border-rule bg-page px-2 py-1 text-sm text-ink-2 disabled:opacity-50"
                    >
                      {row.groupIds.length > 1 && (
                        <option value="" disabled>
                          {row.groupIds.join(" + ")}
                        </option>
                      )}
                      {[...new Set([...groups.map((group) => group.id), ...row.groupIds])].map((groupId) => (
                        <option key={groupId} value={groupId}>
                          {groupId}
                        </option>
                      ))}
                    </select>
                  </span>
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
                {sudoRetry?.kind === "delete" && sudoRetry.machineId === key && (
                  // Right under the machine it is for: at the bottom of a long list it went unseen.
                  <div className="mt-2.5">{sudoPrompt}</div>
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
        {sudoRetry?.kind === "prune" && sudoPrompt}
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

      {mergeDialog && (
        <ConfirmDialog
          title={t("manage_machines_merge_title", { from: mergeDialog.merge.row.machineId, to: mergeDialog.merge.to })}
          body={t("manage_machines_merge_body", {
            from: mergeDialog.merge.row.machineId,
            to: mergeDialog.merge.to,
            group: mergeDialog.merge.groupId,
          })}
          cancelLabel={t("cancel")}
          confirmLabel={(secondsLeft) =>
            secondsLeft > 0 ? t("confirm_yes_countdown", { seconds: secondsLeft }) : t("confirm_yes")
          }
          danger
          countdownSeconds={CONFIRM_DELAY_SECONDS}
          stayOpenOnConfirm
          busy={mergeDialog.phase === "busy"}
          confirmDisabled={mergeDialog.phase !== "confirm"}
          onCancel={() => setMergeDialog(null)}
          onConfirm={() => void performMerge(mergeDialog.merge, mergeDialog.entries)}
        >
          {mergeDialog.phase === "pin" && (
            <SudoUnlock
              autoFocus
              prompt={t("manage_sudo_prompt")}
              onUnlocked={() => void performMerge(mergeDialog.merge, mergeDialog.entries)}
            />
          )}
        </ConfirmDialog>
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

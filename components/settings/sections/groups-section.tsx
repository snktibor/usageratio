"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { PlusIcon, XIcon } from "@/components/icons";
import type { DraftGroup, DraftProvider } from "@/components/settings/draft";
import { SudoUnlock } from "@/components/setup/sudo-unlock";
import { StatusLine } from "@/components/status-line";
import { FIELD, QUIET_BUTTON } from "@/components/ui/classes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Toast } from "@/components/ui/toast";
import { ToggleChip } from "@/components/ui/toggle-chip";
import { normalizeHexColor, PRESET_COLORS } from "@/lib/settings";

/** How long the force-delete/merge confirm buttons stay disabled after opening. */
const CONFIRM_DELAY_SECONDS = 3;

type MergeConfirm = { fromId: string; toId: string; sharedMachine: boolean };
type ForceDeleteConfirm = { id: string };
type SudoRetry = { kind: "merge"; fromId: string; toId: string } | { kind: "force-delete"; id: string };

async function errorCode(response: Response): Promise<string | null> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? null;
}

/** Whether any machine (any provider) currently sits in both `a` and `b`, worth a warning before merging them. */
async function machineInBothGroups(a: string, b: string): Promise<boolean> {
  try {
    const response = await fetch("/api/machines", { cache: "no-store" });
    if (!response.ok) return false;
    const payload = (await response.json()) as { machines: { machineId: string; groupId: string }[] };
    const inA = new Set(
      payload.machines.filter((machine) => machine.groupId === a).map((machine) => machine.machineId),
    );
    return payload.machines.some((machine) => machine.groupId === b && inA.has(machine.machineId));
  } catch {
    return false;
  }
}

export function GroupsSection({
  titleId,
  groups,
  savedGroupIds,
  newGroupName,
  visibleProviders,
  onPatchGroup,
  onSetCounted,
  onRemoveGroup,
  onGroupsChanged,
  onAddGroup,
  onNewGroupNameChange,
  onManaged,
}: {
  titleId: string;
  groups: DraftGroup[];
  /** Group ids the server already knows: only these can be renamed, merged or force-deleted live (the rest exist only in this draft, until Save). */
  savedGroupIds: string[];
  newGroupName: string;
  visibleProviders: DraftProvider[];
  onPatchGroup: (id: string, changes: Partial<DraftGroup>) => void;
  onSetCounted: (groupId: string, providerId: string, counted: boolean) => void;
  onRemoveGroup: (group: DraftGroup) => void;
  /** Replaces the group list in place: for a merge or a force-delete, which remove an entry rather than just editing one. */
  onGroupsChanged: (updater: (groups: DraftGroup[]) => DraftGroup[]) => void;
  onAddGroup: () => void;
  onNewGroupNameChange: (name: string) => void;
  /** After any live rename/merge/delete, so the rest of the dashboard (outside this dialog) catches up. */
  onManaged: () => void;
}) {
  const t = useTranslations("Settings");
  const presetsId = useId();
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);
  const [rowProblem, setRowProblem] = useState<{ id: string; message: string } | null>(null);
  const [mergeConfirm, setMergeConfirm] = useState<MergeConfirm | null>(null);
  const [forceDeleteConfirm, setForceDeleteConfirm] = useState<ForceDeleteConfirm | null>(null);
  const [sudoRetry, setSudoRetry] = useState<SudoRetry | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  function cancelEdit() {
    setEditing(null);
  }

  async function renameOnServer(fromId: string, toId: string, merge: boolean) {
    const response = await fetch(`/api/groups/${encodeURIComponent(fromId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: toId, ...(merge && { merge: true }) }),
    });
    if (response.ok) {
      if (merge) {
        onGroupsChanged((current) =>
          current
            .filter((group) => group.id !== fromId)
            .map((group) => (group.id === toId ? { ...group, hasReports: true } : group)),
        );
        setToast(t("manage_group_merged_toast", { from: fromId, to: toId }));
      } else {
        onPatchGroup(fromId, { id: toId });
        setToast(t("manage_group_renamed_toast", { from: fromId, to: toId }));
      }
      setEditing(null);
      setRowProblem(null);
      onManaged();
      return;
    }
    const error = await errorCode(response);
    if (error === "sudo_required") {
      setSudoRetry({ kind: "merge", fromId, toId });
      return;
    }
    setRowProblem({ id: fromId, message: t("manage_groups_action_failed") });
  }

  async function commitEdit(group: DraftGroup) {
    setEditing((current) => {
      if (!current || current.id !== group.id) return current;
      const toId = current.value.trim();
      if (toId === group.id || toId.length === 0) return null;

      const colliding = groups.find((other) => other.id === toId && other.id !== group.id);
      if (colliding) {
        if (savedGroupIds.includes(toId)) {
          void machineInBothGroups(group.id, toId).then((sharedMachine) => {
            setMergeConfirm({ fromId: group.id, toId, sharedMachine });
          });
        } else {
          setRowProblem({ id: group.id, message: t("group_already_exists", { id: toId }) });
        }
        return current;
      }

      if (savedGroupIds.includes(group.id)) {
        void renameOnServer(group.id, toId, false);
        return current;
      }
      onPatchGroup(group.id, { id: toId });
      return null;
    });
  }

  async function performForceDelete(id: string) {
    const response = await fetch(`/api/groups/${encodeURIComponent(id)}?force=1`, { method: "DELETE" });
    if (response.ok) {
      onGroupsChanged((current) => current.filter((group) => group.id !== id));
      setToast(t("manage_group_deleted_toast", { id }));
      onManaged();
      return;
    }
    const error = await errorCode(response);
    if (error === "sudo_required") {
      setSudoRetry({ kind: "force-delete", id });
      return;
    }
    setProblem(t("manage_groups_action_failed"));
  }

  return (
    <section aria-labelledby={`${titleId}-groups`}>
      <h3 id={`${titleId}-groups`} className="font-medium">
        {t("groups")}
      </h3>

      {groups.length > 0 && (
        <ul className="mt-3 border-t border-hairline">
          {groups.map((group) => {
            const isEditing = editing?.id === group.id;
            return (
              <li key={group.id} className="border-b border-hairline py-2.5">
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    list={presetsId}
                    value={group.color}
                    onChange={(event) =>
                      onPatchGroup(group.id, { color: event.target.value, colorText: event.target.value })
                    }
                    aria-label={t("group_color_aria", { id: group.id })}
                    className="color-well"
                  />
                  {isEditing ? (
                    <input
                      // biome-ignore lint/a11y/noAutofocus: opened by the user's own click, into the field they meant to edit
                      autoFocus
                      type="text"
                      maxLength={64}
                      value={editing.value}
                      onChange={(event) => setEditing({ id: group.id, value: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void commitEdit(group);
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelEdit();
                        }
                      }}
                      onBlur={cancelEdit}
                      aria-label={t("group_rename_aria", { id: group.id })}
                      className={`min-w-0 grow font-mono text-sm ${FIELD}`}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setRowProblem(null);
                        setEditing({ id: group.id, value: group.id });
                      }}
                      title={t("group_rename_hint")}
                      className="min-w-0 grow truncate text-left wrap-anywhere hover:underline"
                    >
                      {group.id}
                    </button>
                  )}
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={7}
                    value={group.colorText}
                    onChange={(event) => {
                      const color = normalizeHexColor(event.target.value);
                      onPatchGroup(group.id, { colorText: event.target.value, ...(color && { color }) });
                    }}
                    onBlur={() => onPatchGroup(group.id, { colorText: group.color })}
                    aria-label={t("group_color_hex_aria", { id: group.id })}
                    aria-invalid={normalizeHexColor(group.colorText) === null || undefined}
                    className={`w-[6.5rem] font-mono text-sm ${FIELD}`}
                  />
                  <button
                    type="button"
                    onClick={() => (group.hasReports ? setForceDeleteConfirm({ id: group.id }) : onRemoveGroup(group))}
                    aria-label={t("group_delete_aria", { id: group.id })}
                    title={group.hasReports ? t("group_force_delete_hint") : t("delete")}
                    className="rounded-md p-2 text-ink-3 transition-colors hover:text-ink"
                  >
                    <XIcon />
                  </button>
                </div>
                {rowProblem?.id === group.id && (
                  <p role="alert" className="mt-1.5 pl-11 text-sm text-critical">
                    {rowProblem.message}
                  </p>
                )}
                {/* Aligned with the name: the colour well is 2rem wide, the gap 0.75rem. */}
                <div
                  role="group"
                  aria-label={t("group_accounts_aria", { id: group.id })}
                  className="mt-2 flex flex-wrap items-center gap-1.5 pl-11"
                >
                  <span className="mr-1 text-sm text-ink-3" aria-hidden="true">
                    {t("counts_towards")}
                  </span>
                  {visibleProviders.map((provider) => (
                    <ToggleChip
                      key={provider.id}
                      checked={!group.excluded.includes(provider.id)}
                      onChange={(counted) => onSetCounted(group.id, provider.id, counted)}
                    >
                      {provider.label}
                    </ToggleChip>
                  ))}
                  {visibleProviders.every((provider) => group.excluded.includes(provider.id)) && (
                    <span className="ml-1 text-sm text-ink-3">{t("no_visible_account")}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <datalist id={presetsId}>
        {PRESET_COLORS.map((color) => (
          <option key={color} value={color} />
        ))}
      </datalist>

      <div className="mt-4 flex gap-3">
        <input
          type="text"
          autoComplete="off"
          maxLength={64}
          placeholder={t("new_group_placeholder")}
          value={newGroupName}
          onChange={(event) => onNewGroupNameChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter adds the group; it must not submit the whole form.
            if (event.key !== "Enter") return;
            event.preventDefault();
            onAddGroup();
          }}
          aria-label={t("new_group_name")}
          className={`min-w-0 grow ${FIELD}`}
        />
        <button type="button" onClick={onAddGroup} className={`flex shrink-0 items-center gap-2 ${QUIET_BUTTON}`}>
          <PlusIcon />
          {t("add")}
        </button>
      </div>

      <div aria-live="polite" className="mt-3 space-y-2.5">
        {problem && <StatusLine tone="problem">{problem}</StatusLine>}
        {sudoRetry && (
          <SudoUnlock
            onUnlocked={() => {
              const retry = sudoRetry;
              setSudoRetry(null);
              if (retry.kind === "merge") void renameOnServer(retry.fromId, retry.toId, true);
              else void performForceDelete(retry.id);
            }}
          />
        )}
      </div>
      {toast && (
        <Toast onDismiss={() => setToast(null)}>
          <StatusLine tone="good">{toast}</StatusLine>
        </Toast>
      )}

      <p className="mt-4 text-sm text-ink-3">
        {t.rich("group_name_explanation", {
          code: (chunks) => <code className="text-ink-2">{chunks}</code>,
        })}
      </p>

      {mergeConfirm && (
        <ConfirmDialog
          title={t("group_merge_confirm_title")}
          body={
            <>
              {t("group_merge_confirm_body", { from: mergeConfirm.fromId, to: mergeConfirm.toId })}
              {mergeConfirm.sharedMachine && <> {t("group_merge_shared_machine_warning")}</>}
            </>
          }
          cancelLabel={t("cancel")}
          confirmLabel={(secondsLeft) =>
            secondsLeft > 0 ? t("confirm_yes_countdown", { seconds: secondsLeft }) : t("confirm_yes")
          }
          danger
          countdownSeconds={CONFIRM_DELAY_SECONDS}
          onCancel={() => setMergeConfirm(null)}
          onConfirm={() => {
            const { fromId, toId } = mergeConfirm;
            setMergeConfirm(null);
            void renameOnServer(fromId, toId, true);
          }}
        />
      )}

      {forceDeleteConfirm && (
        <ConfirmDialog
          title={t("group_force_delete_title")}
          body={t("group_force_delete_body", { id: forceDeleteConfirm.id })}
          cancelLabel={t("cancel")}
          confirmLabel={(secondsLeft) =>
            secondsLeft > 0 ? t("confirm_yes_countdown", { seconds: secondsLeft }) : t("confirm_yes")
          }
          danger
          countdownSeconds={CONFIRM_DELAY_SECONDS}
          onCancel={() => setForceDeleteConfirm(null)}
          onConfirm={() => {
            const { id } = forceDeleteConfirm;
            setForceDeleteConfirm(null);
            void performForceDelete(id);
          }}
        />
      )}
    </section>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";
import { PlusIcon, XIcon } from "@/components/icons";
import type { DraftGroup, DraftProvider } from "@/components/settings/draft";
import { FIELD, QUIET_BUTTON } from "@/components/ui/classes";
import { ToggleChip } from "@/components/ui/toggle-chip";
import { normalizeHexColor, PRESET_COLORS } from "@/lib/settings";

export function GroupsSection({
  titleId,
  groups,
  newGroupName,
  visibleProviders,
  onPatchGroup,
  onSetCounted,
  onRemoveGroup,
  onAddGroup,
  onNewGroupNameChange,
}: {
  titleId: string;
  groups: DraftGroup[];
  newGroupName: string;
  visibleProviders: DraftProvider[];
  onPatchGroup: (id: string, changes: Partial<DraftGroup>) => void;
  onSetCounted: (groupId: string, providerId: string, counted: boolean) => void;
  onRemoveGroup: (group: DraftGroup) => void;
  onAddGroup: () => void;
  onNewGroupNameChange: (name: string) => void;
}) {
  const t = useTranslations("Settings");
  const presetsId = useId();

  return (
    <section aria-labelledby={`${titleId}-groups`}>
      <h3 id={`${titleId}-groups`} className="font-medium">
        {t("groups")}
      </h3>

      {groups.length > 0 && (
        <ul className="mt-3 border-t border-hairline">
          {groups.map((group) => (
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
                <span className="min-w-0 grow wrap-anywhere">{group.id}</span>
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
                  onClick={() => onRemoveGroup(group)}
                  disabled={group.hasReports}
                  aria-label={t("group_delete_aria", { id: group.id })}
                  title={group.hasReports ? t("group_has_reports_cannot_delete") : t("delete")}
                  className="rounded-md p-2 text-ink-3 transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-30"
                >
                  <XIcon />
                </button>
              </div>
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
          ))}
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

      <p className="mt-4 text-sm text-ink-3">
        {t.rich("group_name_explanation", {
          code: (chunks) => <code className="text-ink-2">{chunks}</code>,
        })}
      </p>
    </section>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { StopCircleIcon, XIcon } from "@/components/icons";
import { AccountsSection } from "@/components/settings/sections/accounts-section";
import { BudgetSection } from "@/components/settings/sections/budget-section";
import { GroupsSection } from "@/components/settings/sections/groups-section";
import { LanguageSection } from "@/components/settings/sections/language-section";
import { ResetSection } from "@/components/settings/sections/reset-section";
import { SubLimitsSection } from "@/components/settings/sections/sub-limits-section";
import { TokenSection } from "@/components/settings/sections/token-section";
import { useSettingsForm } from "@/components/settings/use-settings-form";
import { PRIMARY_BUTTON, QUIET_BUTTON } from "@/components/ui/classes";
import type { SettingsView } from "@/lib/settings";

/** Composes every settings section around one `useSettingsForm` draft, plus the sticky footer. */
export function SettingsForm({ view, titleId, onClose }: { view: SettingsView; titleId: string; onClose: () => void }) {
  const t = useTranslations("Settings");
  const { draft, actions, problem, saving } = useSettingsForm(view, onClose);
  const visibleProviders = draft.providers.filter((provider) => provider.visible);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void actions.save();
      }}
    >
      <header className="flex items-center justify-between gap-4 px-6 pt-5">
        <h2 id={titleId} className="text-xl font-medium">
          {t("settings_title")}
        </h2>
        <div className="flex items-center gap-3">
          <LanguageSection />
          <button
            type="button"
            onClick={onClose}
            aria-label={t("close")}
            className="-mr-2 rounded-md p-2 text-ink-3 transition-colors hover:text-ink"
          >
            <XIcon />
          </button>
        </div>
      </header>

      <div className="space-y-9 px-6 pb-7 pt-6">
        <AccountsSection
          titleId={titleId}
          providers={draft.providers}
          visibleCount={visibleProviders.length}
          onToggle={(id, visible) => actions.patchProvider(id, { visible })}
        />

        <BudgetSection
          titleId={titleId}
          draft={draft}
          visibleProviders={visibleProviders}
          onPatch={actions.patch}
          onPatchProvider={actions.patchProvider}
        />

        <SubLimitsSection
          titleId={titleId}
          useTokenLimits={draft.useTokenLimits}
          visibleProviders={visibleProviders}
          onAddSubLimit={actions.addSubLimit}
          onPatchSubLimit={actions.patchSubLimit}
          onRemoveSubLimit={actions.removeSubLimit}
        />

        <ResetSection titleId={titleId} draft={draft} timeZone={view.timeZone} onPatch={actions.patch} />

        <GroupsSection
          titleId={titleId}
          groups={draft.groups}
          newGroupName={draft.newGroupName}
          visibleProviders={visibleProviders}
          onPatchGroup={actions.patchGroup}
          onSetCounted={actions.setCounted}
          onRemoveGroup={actions.removeGroup}
          onAddGroup={actions.addGroup}
          onNewGroupNameChange={(newGroupName) => actions.patch({ newGroupName })}
        />

        <TokenSection
          headingId={`${titleId}-token`}
          value={draft.apiToken}
          onChange={(apiToken) => actions.patch({ apiToken })}
          timeZone={view.timeZone}
        />
      </div>

      <footer className="sticky bottom-0 border-t border-hairline bg-raised px-6 py-4">
        {problem && (
          <div role="alert" className="mb-4 flex items-start gap-2.5 text-sm text-ink">
            <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />
            <div>{problem}</div>
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className={QUIET_BUTTON}>
            {t("cancel")}
          </button>
          <button type="submit" disabled={saving} className={PRIMARY_BUTTON}>
            {saving ? t("saving") : t("save")}
          </button>
        </div>
      </footer>
    </form>
  );
}

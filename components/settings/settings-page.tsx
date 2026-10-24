"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { ArrowLeftIcon, StopCircleIcon } from "@/components/icons";
import { AccountsSection } from "@/components/settings/sections/accounts-section";
import { AlertsSection } from "@/components/settings/sections/alerts-section";
import { BudgetSection } from "@/components/settings/sections/budget-section";
import { DangerSection } from "@/components/settings/sections/danger-section";
import { GroupsSection } from "@/components/settings/sections/groups-section";
import { LanguageSection } from "@/components/settings/sections/language-section";
import { MachinesSection } from "@/components/settings/sections/machines-section";
import { ResetSection } from "@/components/settings/sections/reset-section";
import { SubLimitsSection } from "@/components/settings/sections/sub-limits-section";
import { TokenSection } from "@/components/settings/sections/token-section";
import { TokensSection } from "@/components/settings/sections/tokens-section";
import { useLeaveGuard } from "@/components/settings/use-leave-guard";
import { useSettingsForm } from "@/components/settings/use-settings-form";
import { PRIMARY_BUTTON } from "@/components/ui/classes";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Link } from "@/i18n/routing";
import type { SettingsView } from "@/lib/settings";

/** The menu's entries, in page order; each is a `<section id="settings-…">` below. */
const SECTIONS = ["general", "budgets", "providers", "groups", "machines", "alerts", "tokens", "danger"] as const;
type SectionKey = (typeof SECTIONS)[number];

const anchorId = (key: SectionKey) => `settings-${key}`;

/**
 * The menu entry to highlight: the last section whose top has scrolled past a
 * line near the top of the viewport. At the bottom of the page the last
 * sections can no longer reach that line, so there the one just jumped to
 * (`pinned`) wins while it is on screen, and the last section otherwise.
 */
function useActiveSection(): [SectionKey, (key: SectionKey) => void] {
  const [active, setActive] = useState<SectionKey>(SECTIONS[0]);
  const pinned = useRef<SectionKey | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const root = document.documentElement;
      const line = Math.min(160, window.innerHeight * 0.3);
      const atBottom = window.innerHeight + window.scrollY >= root.scrollHeight - 4;
      if (atBottom) {
        const pin = pinned.current;
        const pinTop = pin ? document.getElementById(anchorId(pin))?.getBoundingClientRect().top : undefined;
        setActive(pin && pinTop !== undefined && pinTop < window.innerHeight ? pin : SECTIONS[SECTIONS.length - 1]!);
        return;
      }
      pinned.current = null;
      let current: SectionKey = SECTIONS[0];
      for (const key of SECTIONS) {
        const top = document.getElementById(anchorId(key))?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) current = key;
      }
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return [
    active,
    (key) => {
      pinned.current = key;
      setActive(key);
    },
  ];
}

/** One menu entry's part of the page: its heading, then the settings sections that belong to it. */
function SettingsGroup({
  sectionKey,
  title,
  single = false,
  children,
}: {
  sectionKey: SectionKey;
  title: string;
  /** One section only: its own heading would repeat this one, so it is kept for screen readers alone. */
  single?: boolean;
  children: ReactNode;
}) {
  const id = anchorId(sectionKey);
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="scroll-mt-22">
      <h2 id={`${id}-heading`} className="text-xl font-medium tracking-tight">
        {title}
      </h2>
      <div className={`mt-5 space-y-9 ${single ? "[&_h3]:sr-only" : ""}`}>{children}</div>
    </section>
  );
}

/**
 * The settings page: a menu that follows the scrolling, every section on one
 * form around one `useSettingsForm` draft, and a sticky bar with the one save
 * button. Leaving with unsaved changes asks first (use-leave-guard.ts).
 */
export function SettingsPage({ view }: { view: SettingsView }) {
  const t = useTranslations("Settings");
  const titleId = useId();
  const [justSaved, setJustSaved] = useState(false);
  const { draft, actions, problem, saving, dirty } = useSettingsForm(view, () => setJustSaved(true));
  const guard = useLeaveGuard(dirty);
  const [active, jumpTo] = useActiveSection();
  const [deletedProviderIds, setDeletedProviderIds] = useState<string[]>([]);
  const [machineIds, setMachineIds] = useState<string[]>([]);
  const listedProviders = draft.providers.filter((provider) => !deletedProviderIds.includes(provider.id));
  const visibleProviders = draft.providers.filter((provider) => provider.visible);

  // "Saved" lasts until the next change.
  useEffect(() => {
    if (dirty) setJustSaved(false);
  }, [dirty]);

  return (
    <div className="mx-auto w-full max-w-5xl px-5 pt-3 sm:px-8 sm:pt-5">
      {/* Stays in view while the page scrolls, so the way back is always one click away. */}
      <header className="sticky top-0 z-20 -mx-5 flex items-center justify-between gap-4 bg-page px-5 py-3 sm:-mx-8 sm:px-8">
        <Link href="/" className="text-lg font-medium tracking-tight">
          usageratio
        </Link>
        <Link
          href="/"
          className="flex items-center gap-2 rounded-md border border-rule px-3 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
        >
          <ArrowLeftIcon />
          {t("back_to_dashboard")}
        </Link>
      </header>

      <h1 id={titleId} className="mt-12 text-4xl font-semibold tracking-tight sm:mt-16 sm:text-5xl">
        {t("settings_title")}
      </h1>

      <div className="mt-8 lg:mt-12 lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-12">
        <nav aria-label={t("sections_nav_aria")} className="lg:sticky lg:top-22 lg:self-start">
          <ul className="flex flex-wrap gap-2 lg:flex-col lg:gap-0.5">
            {SECTIONS.map((key) => {
              const current = key === active;
              return (
                <li key={key}>
                  <a
                    href={`#${anchorId(key)}`}
                    onClick={() => jumpTo(key)}
                    aria-current={current ? "location" : undefined}
                    className={`block rounded-md border px-3 py-1.5 text-sm transition-colors lg:border-0 lg:border-l-2 lg:rounded-none lg:py-2 ${
                      current
                        ? "border-ink-3 text-ink lg:border-ink"
                        : "border-rule text-ink-2 hover:border-ink-3 hover:text-ink lg:border-transparent"
                    }`}
                  >
                    {t(`section_${key}`)}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>

        <form
          noValidate
          aria-labelledby={titleId}
          onSubmit={(event) => {
            event.preventDefault();
            void actions.save();
          }}
          className="mt-10 min-w-0 lg:mt-0"
        >
          <div className="space-y-16">
            <SettingsGroup sectionKey="general" title={t("section_general")}>
              <LanguageSection titleId={titleId} confirmLeave={guard.confirmLeave} />
              <ResetSection
                titleId={titleId}
                draft={draft}
                onPatch={actions.patch}
                onOwnReset={actions.ownReset}
                onPatchOwnReset={actions.patchOwnReset}
              />
            </SettingsGroup>

            <SettingsGroup sectionKey="budgets" title={t("section_budgets")}>
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
            </SettingsGroup>

            <SettingsGroup sectionKey="providers" title={t("section_providers")} single>
              <AccountsSection
                titleId={titleId}
                providers={listedProviders}
                visibleCount={visibleProviders.length}
                onToggle={(id, visible) => actions.patchProvider(id, { visible })}
              />
            </SettingsGroup>

            <SettingsGroup sectionKey="groups" title={t("section_groups")} single>
              <GroupsSection
                titleId={titleId}
                groups={draft.groups}
                savedGroupIds={view.groups.map((group) => group.id)}
                newGroupName={draft.newGroupName}
                visibleProviders={visibleProviders}
                onPatchGroup={actions.patchGroup}
                onSetCounted={actions.setCounted}
                onRemoveGroup={actions.removeGroup}
                onGroupsChanged={actions.setGroups}
                onAddGroup={actions.addGroup}
                onNewGroupNameChange={(newGroupName) => actions.patch({ newGroupName })}
                onManaged={actions.refresh}
              />
            </SettingsGroup>

            <SettingsGroup sectionKey="machines" title={t("section_machines")} single>
              <MachinesSection
                titleId={titleId}
                groups={draft.groups}
                onManaged={actions.refresh}
                onMachineIds={setMachineIds}
              />
            </SettingsGroup>

            <SettingsGroup sectionKey="alerts" title={t("section_alerts")} single>
              <AlertsSection
                titleId={titleId}
                alerts={draft.alerts}
                useTokenLimits={draft.useTokenLimits}
                onPatch={actions.patchAlerts}
              />
            </SettingsGroup>

            <SettingsGroup sectionKey="tokens" title={t("section_tokens")}>
              <TokenSection
                headingId={`${titleId}-token`}
                value={draft.apiToken}
                onChange={(apiToken) => actions.patch({ apiToken })}
                timeZone={view.timeZone}
              />
              <TokensSection
                titleId={titleId}
                timeZone={view.timeZone}
                knownMachines={machineIds}
                onManaged={actions.refresh}
              />
            </SettingsGroup>

            <SettingsGroup sectionKey="danger" title={t("section_danger")} single>
              <DangerSection
                titleId={titleId}
                providers={listedProviders}
                onDeleted={(id) => setDeletedProviderIds((current) => [...current, id])}
                onManaged={actions.refresh}
              />
            </SettingsGroup>
          </div>

          <footer className="sticky bottom-0 z-10 mt-12 border-t border-hairline bg-page py-4">
            {problem && (
              <div role="alert" className="mb-4 flex items-start gap-2.5 text-sm text-ink">
                <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />
                <div className="min-w-0">{problem}</div>
              </div>
            )}
            <div className="flex items-center justify-end gap-4">
              <p role="status" className="text-sm text-ink-3">
                {dirty ? t("unsaved_changes") : justSaved ? t("saved_notice") : ""}
              </p>
              <button type="submit" disabled={saving} className={PRIMARY_BUTTON}>
                {saving ? t("saving") : t("save")}
              </button>
            </div>
          </footer>
        </form>
      </div>

      {guard.pending && (
        <ConfirmDialog
          title={t("leave_title")}
          body={t("leave_body")}
          cancelLabel={t("leave_stay")}
          confirmLabel={() => t("leave_confirm")}
          danger
          onCancel={guard.stay}
          onConfirm={guard.leave}
        />
      )}
    </div>
  );
}

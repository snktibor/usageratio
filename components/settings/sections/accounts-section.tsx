"use client";

import { useTranslations } from "next-intl";
import type { DraftProvider } from "@/components/settings/draft";
import { ToggleChip } from "@/components/ui/toggle-chip";

/** Which providers the dashboard shows. Deleting one lives in the danger zone at the bottom (danger-section.tsx). */
export function AccountsSection({
  titleId,
  providers,
  visibleCount,
  onToggle,
}: {
  titleId: string;
  providers: DraftProvider[];
  visibleCount: number;
  onToggle: (id: string, visible: boolean) => void;
}) {
  const t = useTranslations("Settings");

  return (
    <section aria-labelledby={`${titleId}-providers`}>
      <h3 id={`${titleId}-providers`} className="font-medium">
        {t("providers_heading")}
      </h3>
      <p className="mt-1 text-sm text-ink-3">{t("providers_explanation")}</p>
      <div role="group" aria-label={t("providers_visible_aria")} className="mt-3 flex flex-wrap gap-2">
        {providers.map((provider) => {
          const isLastVisible = provider.visible && visibleCount === 1;
          return (
            <ToggleChip
              key={provider.id}
              checked={provider.visible}
              onChange={(checked) => onToggle(provider.id, checked)}
              disabled={isLastVisible}
              title={isLastVisible ? t("providers_last_visible") : undefined}
            >
              {provider.label}
            </ToggleChip>
          );
        })}
      </div>
      <p className="mt-3 text-sm text-ink-3">{t("providers_hidden_explanation")}</p>
    </section>
  );
}

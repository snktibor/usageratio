"use client";

import { useTranslations } from "next-intl";
import type { DraftProvider } from "@/components/settings/draft";
import { ToggleChip } from "@/components/ui/toggle-chip";

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
        {t("ai_accounts")}
      </h3>
      <div role="group" aria-label={t("visible_ai_accounts")} className="mt-3 flex flex-wrap gap-2">
        {providers.map((provider) => {
          const isLastVisible = provider.visible && visibleCount === 1;
          return (
            <ToggleChip
              key={provider.id}
              checked={provider.visible}
              onChange={(visible) => onToggle(provider.id, visible)}
              disabled={isLastVisible}
              title={isLastVisible ? t("at_least_one_account_must_be_visible") : undefined}
            >
              {provider.label}
            </ToggleChip>
          );
        })}
      </div>
      <p className="mt-3 text-sm text-ink-3">{t("hidden_account_explanation")}</p>
    </section>
  );
}

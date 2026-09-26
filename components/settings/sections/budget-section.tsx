"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import { type Draft, type DraftProvider, parseLimit } from "@/components/settings/draft";
import { FIELD } from "@/components/ui/classes";
import { Segmented } from "@/components/ui/segmented";
import { formatTokens } from "@/lib/format";

export function BudgetSection({
  titleId,
  draft,
  visibleProviders,
  onPatch,
  onPatchProvider,
}: {
  titleId: string;
  draft: Draft;
  visibleProviders: DraftProvider[];
  onPatch: (changes: Partial<Draft>) => void;
  onPatchProvider: (id: string, changes: Partial<DraftProvider>) => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Settings");
  const periodName = useId();

  return (
    <section aria-labelledby={`${titleId}-budget`} className="space-y-4">
      <h3 id={`${titleId}-budget`} className="font-medium">
        {t("budget")}
      </h3>

      <fieldset>
        <legend className="text-sm text-ink-3">{t("type")}</legend>
        <Segmented
          name={periodName}
          value={draft.period}
          onChange={(period) => onPatch({ period })}
          className="mt-1.5"
          options={[
            { value: "weekly", label: t("weekly") },
            { value: "monthly", label: t("monthly") },
          ]}
        />
      </fieldset>

      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={draft.useTokenLimits}
          onChange={(event) => onPatch({ useTokenLimits: event.target.checked })}
          className="mt-1 size-4 shrink-0 cursor-pointer accent-ink"
        />
        <span>
          {t("use_token_limits")}
          <span className="mt-0.5 block text-sm text-ink-3">{t("use_token_limits_explanation")}</span>
        </span>
      </label>

      {/* Hidden while off, yet kept in the draft: switching back on restores the limits as they were. */}
      {draft.useTokenLimits && (
        <div className="space-y-4 border-l border-hairline pl-4 sm:pl-7">
          <fieldset>
            <legend className="text-sm text-ink-3">{t("provider_limits_label")}</legend>
            <div className="mt-2 grid gap-3 sm:grid-cols-2">
              {visibleProviders.map((provider) => {
                const limit = parseLimit(provider.limitText);
                return (
                  <label key={provider.id} className="rounded-lg border border-hairline bg-page/40 p-3">
                    <span className="font-medium text-ink">{provider.label}</span>
                    <span className="mt-2 flex items-center gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        value={provider.limitText}
                        onChange={(event) => onPatchProvider(provider.id, { limitText: event.target.value })}
                        aria-invalid={limit === null || undefined}
                        aria-label={t("provider_limit_aria", { label: provider.label })}
                        className={`min-w-0 grow tabular-nums ${FIELD}`}
                      />
                    </span>
                    <span className="mt-1.5 block text-sm text-ink-3">
                      {limit === null
                        ? t("positive_integer")
                        : draft.period === "weekly"
                          ? t("weekly_limit", { tokens: formatTokens(limit, locale) })
                          : t("monthly_limit", { tokens: formatTokens(limit, locale) })}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={draft.showRemaining}
              onChange={(event) => onPatch({ showRemaining: event.target.checked })}
              className="mt-1 size-4 shrink-0 cursor-pointer accent-ink"
            />
            <span>
              {t("show_remaining_tokens")}
              <span className="mt-0.5 block text-sm text-ink-3">{t("show_remaining_tokens_explanation")}</span>
            </span>
          </label>
        </div>
      )}
    </section>
  );
}

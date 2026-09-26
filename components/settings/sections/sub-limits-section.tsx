"use client";

import { useTranslations } from "next-intl";
import { PlusIcon } from "@/components/icons";
import type { DraftProvider, DraftSubLimit } from "@/components/settings/draft";
import { SubLimitEditor } from "@/components/settings/sub-limit-editor";
import { QUIET_BUTTON } from "@/components/ui/classes";
import { MAX_SUB_LIMITS } from "@/lib/sub-limits";

export function SubLimitsSection({
  titleId,
  useTokenLimits,
  visibleProviders,
  onAddSubLimit,
  onPatchSubLimit,
  onRemoveSubLimit,
}: {
  titleId: string;
  useTokenLimits: boolean;
  visibleProviders: DraftProvider[];
  onAddSubLimit: (provider: DraftProvider) => void;
  onPatchSubLimit: (providerId: string, key: string, changes: Partial<DraftSubLimit>) => void;
  onRemoveSubLimit: (providerId: string, key: string) => void;
}) {
  const t = useTranslations("Settings");

  return (
    <section aria-labelledby={`${titleId}-sub-limits`}>
      <h3 id={`${titleId}-sub-limits`} className="font-medium">
        {t("sublimits")}
      </h3>
      <p className="mt-1.5 text-sm text-ink-3">
        {t.rich("sublimits_explanation", {
          strong: (chunks) => <strong className="font-medium text-ink-2">{chunks}</strong>,
        })}
      </p>

      <div className="mt-4 space-y-4">
        {visibleProviders.map((provider) => (
          <div key={provider.id}>
            <div className="flex items-center justify-between gap-3">
              <span className="text-ink-2">{provider.label}</span>
              <button
                type="button"
                onClick={() => onAddSubLimit(provider)}
                disabled={provider.subLimits.length >= MAX_SUB_LIMITS}
                aria-label={t("add_sublimit_aria", { label: provider.label })}
                className={`flex shrink-0 items-center gap-2 text-sm ${QUIET_BUTTON}`}
              >
                <PlusIcon />
                {t("sublimit")}
              </button>
            </div>

            {provider.subLimits.length > 0 && (
              <ul className="mt-2.5 space-y-3">
                {provider.subLimits.map((sub) => (
                  <SubLimitEditor
                    key={sub.key}
                    sub={sub}
                    provider={provider}
                    useTokenLimits={useTokenLimits}
                    onChange={(changes) => onPatchSubLimit(provider.id, sub.key, changes)}
                    onRemove={() => onRemoveSubLimit(provider.id, sub.key)}
                  />
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

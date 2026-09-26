"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId } from "react";
import { XIcon } from "@/components/icons";
import {
  type DraftProvider,
  type DraftSubLimit,
  parseLimit,
  parseModelParts,
  parseSharePercent,
} from "@/components/settings/draft";
import { FIELD } from "@/components/ui/classes";
import { Segmented } from "@/components/ui/segmented";
import { formatTokens } from "@/lib/format";
import type { Translator } from "@/lib/i18n";
import { modelLabel } from "@/lib/models";
import { MAX_SUB_LIMIT_NAME_LENGTH } from "@/lib/sub-limits";

/** Which of the provider's models this cycle a sub-limit takes, as its parts are typed. */
function matchNote(sub: DraftSubLimit, provider: DraftProvider, t: Translator<"Settings">): string {
  const parts = parseModelParts(sub.modelsText);
  if (parts === null) {
    const known = provider.models.slice(0, 6).join(", ");
    return known === "" ? t("models_hint_multiple") : t("models_hint_example", { known });
  }
  // A model an earlier sub-limit takes stays there: the first match wins (lib/sub-limits.ts).
  const earlier = provider.subLimits
    .slice(0, provider.subLimits.indexOf(sub))
    .flatMap((other) => parseModelParts(other.modelsText) ?? []);
  const takes = (model: string, list: string[]) => list.some((part) => model.includes(part));
  const matches = provider.models.filter((model) => takes(model, parts) && !takes(model, earlier));
  if (matches.length === 0) return t("no_matching_models");
  return t("matching_models", { matches: matches.map(modelLabel).join(", ") });
}

export function SubLimitEditor({
  sub,
  provider,
  useTokenLimits,
  onChange,
  onRemove,
}: {
  sub: DraftSubLimit;
  provider: DraftProvider;
  useTokenLimits: boolean;
  onChange: (changes: Partial<DraftSubLimit>) => void;
  onRemove: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Settings");
  const modeName = useId();
  const label = sub.name.trim() || t("new_sublimit");
  const share = parseSharePercent(sub.shareText);
  const limit = parseLimit(sub.limitText);

  return (
    <li className="rounded-lg border border-hairline bg-page/40 p-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          autoComplete="off"
          maxLength={MAX_SUB_LIMIT_NAME_LENGTH}
          placeholder={t("sublimit_name_placeholder")}
          value={sub.name}
          onChange={(event) => onChange({ name: event.target.value })}
          aria-label={t("sublimit_name_aria", { label: provider.label })}
          className={`min-w-0 grow font-medium ${FIELD}`}
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("sublimit_delete_aria", { label })}
          title={t("delete")}
          className="rounded-md p-2 text-ink-3 transition-colors hover:text-ink"
        >
          <XIcon />
        </button>
      </div>

      <label className="mt-3 block">
        <span className="text-sm text-ink-3">{t("models")}</span>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="fable"
          value={sub.modelsText}
          onChange={(event) => onChange({ modelsText: event.target.value })}
          className={`mt-1 block w-full font-mono text-sm ${FIELD}`}
        />
        <span className="mt-1 block text-sm text-ink-3">{matchNote(sub, provider, t)}</span>
      </label>

      <fieldset className="mt-3">
        <legend className="sr-only">{t("sublimit_type_legend", { label })}</legend>
        <Segmented
          name={modeName}
          value={sub.mode}
          onChange={(mode) => onChange({ mode })}
          size="sm"
          options={[
            { value: "separate", label: t("separate_limit") },
            { value: "share", label: t("shared_limit") },
          ]}
        />
      </fieldset>

      {sub.mode === "share" ? (
        <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-3">
          {t("max_share")}
          <span className="relative">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={sub.shareText}
              onChange={(event) => onChange({ shareText: event.target.value })}
              aria-invalid={share === null || undefined}
              className={`w-20 pr-7 text-base tabular-nums ${FIELD}`}
            />
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
              %
            </span>
          </span>
          {t("of_provider_limit", { label: provider.label })}
        </label>
      ) : (
        <>
          {useTokenLimits && (
            <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-3">
              {t("token_limit")}
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={sub.limitText}
                onChange={(event) => onChange({ limitText: event.target.value })}
                aria-invalid={limit === null || undefined}
                className={`w-36 text-base tabular-nums ${FIELD}`}
              />
              {limit !== null && <span>{t("token_count", { count: formatTokens(limit, locale) })}</span>}
            </label>
          )}
          <p className="mt-2 text-sm text-ink-3">{t("sublimit_models_dont_count", { label: provider.label })}</p>
        </>
      )}
    </li>
  );
}

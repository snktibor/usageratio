"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useState } from "react";
import { CycleHistory } from "@/components/cycle-history";
import type { HistoryContext } from "@/components/dashboard-view";
import { writeProviderCookie } from "@/components/dashboard-view";
import { useRouter } from "@/i18n/routing";
import { periodOfCycle } from "@/lib/cycle-options";
import { formatCost, formatHeroPercent, formatPercent, formatTokens } from "@/lib/format";
import type { CycleSummary } from "@/lib/history";
import { modelKey, modelLabel } from "@/lib/models";
import { NEUTRAL_COLOR } from "@/lib/settings";

/** One provider's archived summary of the cycle on screen; null when it has none (it did not report then). */
export interface PastSummary {
  id: string;
  label: string;
  summary: CycleSummary | null;
}

/** Rows of a name and an amount, heaviest first, each with a bar of its share. */
function ShareList({
  rows,
  locale,
}: {
  rows: { key: string; label: string; tokens: number; color: string }[];
  locale: string;
}) {
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return (
    <ul className="mt-3 border-t border-hairline">
      {rows.map((row) => {
        const share = total > 0 ? row.tokens / total : 0;
        return (
          <li key={row.key} className="border-b border-hairline py-2.5">
            <div className="flex items-baseline justify-between gap-4">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-2.5 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: row.color }}
                />
                <span className="wrap-anywhere">{row.label}</span>
              </span>
              <span className="shrink-0 tabular-nums">
                {formatTokens(row.tokens, locale)} <span className="text-ink-3">· {formatPercent(share, locale)}</span>
              </span>
            </div>
            <span aria-hidden="true" className="mt-1.5 block h-1.5 w-full rounded-r-[3px] bg-hairline">
              <span
                className="block h-full rounded-r-[3px]"
                style={{ width: `${share * 100}%`, backgroundColor: row.color }}
              />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A cycle older than the raw reports' retention: all that is left of it is
 * each provider's archived summary (lib/history.ts), shown as it was frozen.
 * No chart over time, no machine list: those needed the reports.
 */
export function ArchivedCycleView({
  summaries,
  historyByProvider,
  historyContext,
  timeZone,
  selectedStartMs,
  pastCycle,
}: {
  summaries: PastSummary[];
  historyByProvider: Record<string, CycleSummary[]>;
  historyContext: HistoryContext;
  timeZone: string;
  selectedStartMs: number;
  pastCycle: boolean;
}) {
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const [selectedId, setSelectedId] = useState(summaries[0]?.id ?? "");
  const selectProvider = useCallback(
    (providerId: string) => {
      writeProviderCookie(providerId);
      setSelectedId(providerId);
      // A past cycle is the selected provider's own: another provider's would be a different week.
      if (pastCycle) router.push("/");
    },
    [pastCycle, router],
  );
  const selected = summaries.find((entry) => entry.id === selectedId) ?? summaries[0];
  if (!selected) return null;
  const { summary } = selected;
  const limitShare = summary && summary.limit !== null && summary.limit > 0 ? summary.total / summary.limit : null;

  return (
    <main className="mt-10 space-y-16 sm:mt-12">
      <section
        aria-label={t("official_consumption_aria", { label: selected.label })}
        className="rounded-lg border border-rule bg-raised px-5 py-5 sm:px-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-4">
          <h1 className="text-base font-medium">{t("summary_heading")}</h1>
          <label className="flex items-center gap-2 text-sm text-ink-3">
            <span>{t("ai_account")}</span>
            <select
              value={selected.id}
              onChange={(event) => selectProvider(event.target.value)}
              className="rounded-md border border-rule bg-page px-3 py-2 font-medium text-ink outline-none transition-colors hover:border-ink-3 focus:border-ink-3"
            >
              {summaries.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {summary ? (
          <dl className="mt-5 grid grid-cols-1 gap-x-10 gap-y-5 sm:grid-cols-3">
            <div>
              <dt className="text-sm text-ink-3">{t("final_official_consumption")}</dt>
              <dd className="mt-1 text-2xl font-medium tabular-nums">
                {summary.official !== null
                  ? formatHeroPercent(summary.official / 100, locale)
                  : limitShare !== null
                    ? formatHeroPercent(limitShare, locale)
                    : "–"}
              </dd>
              <dd className="text-sm text-ink-3">
                {summary.official !== null
                  ? t("history_final_official")
                  : limitShare !== null
                    ? t("history_final_limit")
                    : t("history_final_unknown")}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-ink-3">{t("measured_usage")}</dt>
              <dd className="mt-1 text-2xl font-medium">
                {t("token_count", { count: formatTokens(summary.total, locale) })}
              </dd>
              <dd className="text-sm text-ink-3">
                {t("summary_machines", { count: summary.machines })}
                {summary.limit !== null &&
                  ` · ${t("of_token_limit", {
                    period: periodOfCycle({ startMs: summary.start, endMs: summary.end }),
                    tokens: formatTokens(summary.limit, locale),
                  })}`}
              </dd>
            </div>
            {summary.cost !== undefined && (
              <div>
                <dt className="text-sm text-ink-3">{t("cost")}</dt>
                <dd className="mt-1 text-2xl font-medium">{formatCost(summary.cost, locale)}</dd>
                <dd className="text-sm text-ink-3">{t("summary_cost_note")}</dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="mt-5 text-ink-2">{t("summary_none", { label: selected.label })}</p>
        )}
      </section>

      {summary && Object.keys(summary.groups).length > 0 && (
        <section aria-labelledby="summary-groups-heading">
          <h2 id="summary-groups-heading" className="text-xl font-medium">
            {t("groups")}
          </h2>
          <ShareList
            locale={locale}
            rows={Object.entries(summary.groups)
              .filter(([, tokens]) => tokens > 0)
              .sort(([, a], [, b]) => b - a)
              .map(([groupId, tokens]) => ({
                key: groupId,
                label: groupId,
                tokens,
                color: historyContext.groupColors[groupId] ?? NEUTRAL_COLOR,
              }))}
          />
        </section>
      )}

      {summary && Object.keys(summary.models).length > 0 && (
        <section aria-labelledby="summary-models-heading">
          <h2 id="summary-models-heading" className="text-xl font-medium">
            {t("models")}
          </h2>
          <p className="mt-1 text-sm text-ink-3">{t("summary_models_note")}</p>
          <ShareList
            locale={locale}
            rows={Object.entries(summary.models)
              .sort(([, a], [, b]) => b - a)
              .map(([modelId, tokens]) => ({
                key: modelId,
                label: modelLabel(modelKey(modelId)),
                tokens,
                color: "var(--color-ink-3)",
              }))}
          />
        </section>
      )}

      <CycleHistory
        history={historyByProvider[selected.id] ?? []}
        timeZone={timeZone}
        groupColors={historyContext.groupColors}
        kinds={historyContext.kinds}
        selectedStartMs={selectedStartMs}
      />
    </main>
  );
}

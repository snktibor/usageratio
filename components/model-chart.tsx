"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ChartLegend, type ChartSeries, CycleChart } from "@/components/cycle-chart";
import { formatTokenTick } from "@/lib/chart";
import type { DashboardModel } from "@/lib/dashboard";
import { formatCost } from "@/lib/format";
import { NEUTRAL_COLOR } from "@/lib/settings";

/** The token axis never shrinks below this, so a handful of tokens does not fill the chart. */
const MIN_AXIS_TOKENS = 1_000;

/**
 * One model of the selected provider at a time: each group's measured tokens
 * of it, accumulated since the start of the cycle. Only the reports of
 * clients that send the split by model count here.
 */
export function ModelChart({ model }: { model: DashboardModel }) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const { models } = model.timeline;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = models.find((m) => m.modelId === selectedId) ?? models[0];
  const switchName = useId();
  const colorOf = new Map(model.groups.map((group) => [group.groupId, group.color]));

  const series: ChartSeries[] = (selected?.groups ?? []).map((group) => ({
    id: `group:${group.groupId}`,
    label: group.groupId,
    color: colorOf.get(group.groupId) ?? NEUTRAL_COLOR,
    values: group.values,
  }));

  return (
    <section aria-labelledby="models-heading">
      <h2 id="models-heading" className="text-xl font-medium">
        {t("models")}
      </h2>

      {selected ? (
        <>
          <p className="mt-1 text-sm text-ink-3">{t("measured_tokens_by_group")}</p>

          <fieldset className="mt-5">
            <legend className="sr-only">{t("model")}</legend>
            <div className="flex flex-wrap gap-2">
              {models.map((m) => (
                <label key={m.modelId} className="relative">
                  <input
                    type="radio"
                    name={switchName}
                    value={m.modelId}
                    checked={m.modelId === selected.modelId}
                    onChange={() => setSelectedId(m.modelId)}
                    className="peer sr-only"
                  />
                  <span
                    title={m.cost !== undefined ? `${m.modelId} · ${formatCost(m.cost, locale)}` : m.modelId}
                    className="flex cursor-pointer items-baseline gap-2 rounded-full border border-rule px-3.5 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink peer-checked:border-ink peer-checked:bg-ink peer-checked:text-page peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink"
                  >
                    <span className="font-medium">{m.label}</span>
                    <span className="tabular-nums opacity-70">{formatTokenTick(m.tokens, locale)}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Even one line gets its key: the heading names the model, not the group. */}
          {series.length > 0 && (
            <div className="mt-5">
              <ChartLegend series={series} />
            </div>
          )}
          <div className="mt-5">
            <CycleChart
              key={selected.modelId}
              model={model}
              series={series}
              minAxis={MIN_AXIS_TOKENS}
              formatTick={(tokens) => formatTokenTick(tokens, locale)}
              formatValue={(tokens) => t("token_amount", { count: tokens })}
              formatEndLabel={(tokens) => formatTokenTick(tokens, locale)}
              label={t("model_chart_aria", { label: selected.label })}
            />
          </div>
        </>
      ) : (
        <p className="mt-3 max-w-xl text-ink-2">
          {t.rich("no_model_breakdown", { code: (chunks) => <code className="text-ink">{chunks}</code> })}
        </p>
      )}
    </section>
  );
}

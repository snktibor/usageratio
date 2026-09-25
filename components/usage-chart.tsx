import { ChartLegend, CycleChart, type ChartSeries } from "@/components/cycle-chart";
import { formatPercentTick, niceScale } from "@/lib/chart";
import type { DashboardModel } from "@/lib/dashboard";
import { formatHeroPercent } from "@/lib/format";
import { subLimitTimeline, type DashboardView, type SubLimitView } from "@/lib/ground-truth";
import { NEUTRAL_COLOR } from "@/lib/settings";
import { useTranslations, useLocale } from "next-intl";
/** The percentage axis never shrinks below this: a quiet start of the cycle stays low on the chart. */
const MIN_AXIS_FRACTION = 0.1;

/** A sub-limit's line: a fainter shade of the total's, fainter still for each further one. */
function subLimitColor(index: number): string {
  const inkPercent = [60, 45, 34, 26, 20][index] ?? 20;
  return `color-mix(in srgb, var(--color-ink) ${inkPercent}%, var(--color-page))`;
}

/**
 * How the budget went over the cycle: each group's share of it and, dashed,
 * all of them together. The measured tokens become a share of the budget at
 * one rate, the headline figure over all measured tokens, so the dashed line
 * ends on the headline percentage and the groups split it as their tokens do.
 * Each sub-limit whose figure is known runs beside them in a fainter shade,
 * as the share of its own budget: the same rule, ending on its own figure.
 */
export function UsageChart({
  model,
  view,
  subLimits,
}: {
  model: DashboardModel;
  view: DashboardView;
  subLimits: SubLimitView[];
}) {
    const locale = useLocale();
  const t = useTranslations("Widgets");
  // Per measured token: the official figure's share of it, or 1/limit when measured against a token limit.
  const fractionPerToken = view.quota && model.total > 0 ? view.quota.usedFraction / model.total : null;
  const colorOf = new Map(model.groups.map((group) => [group.groupId, group.color]));

  const subLimitSeries: ChartSeries[] = subLimits.flatMap((subView, index) => {
    const values = subLimitTimeline(subView);
    return values
      ? [{ id: `sub:${subView.sub.id}`, label: t("sublimit_label", { name: subView.sub.name }), color: subLimitColor(index), values, faint: true }]
      : [];
  });

  let body: React.ReactNode;
  if (model.total === 0) {
    body = <p className="mt-3 max-w-xl text-ink-2">{t("no_measured_usage_chart")}</p>;
  } else if (fractionPerToken === null) {
    body = (
      <p className="mt-3 max-w-xl text-ink-2">
        {t("chart_official_explanation")}
      </p>
    );
  } else {
    const groups: ChartSeries[] = model.timeline.groups.map((group) => ({
      id: `group:${group.groupId}`,
      label: group.groupId,
      color: colorOf.get(group.groupId) ?? NEUTRAL_COLOR,
      values: group.values.map((tokens) => tokens * fractionPerToken),
    }));
    const total: ChartSeries = {
      id: "total",
      label: t("total"),
      color: "var(--color-ink)",
      values: model.timeline.times.map((_, index) =>
        groups.reduce((sum, group) => sum + group.values[index]!, 0),
      ),
      dashed: true,
    };
    // Drawn in reverse: the sub-limits' fainter lines lie beneath the groups'.
    const series = [total, ...groups, ...subLimitSeries];
    const scale = niceScale(Math.max(...series.flatMap((s) => s.values)), MIN_AXIS_FRACTION);

    body = (
      <>
        <div className="mt-4">
          <ChartLegend series={series} />
        </div>
        <div className="mt-5">
          <CycleChart
            model={model}
            series={series}
            scale={scale}
            formatTick={(fraction) => formatPercentTick(fraction, scale.step)}
            formatValue={(val) => formatHeroPercent(val, locale)}
            label={
              subLimitSeries.length > 0
                ? t("chart_aria_with_sublimits")
                : t("chart_aria_no_sublimits")
            }
          />
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="usage-chart-heading">
      <h2 id="usage-chart-heading" className="text-xl font-medium">
        {t("burn_over_time")}
      </h2>
      {fractionPerToken !== null && (
        <p className="mt-1 text-sm text-ink-3">
          {view.calibrated
            ? t("chart_desc_official")
            : t("chart_desc_measured")}
          {subLimitSeries.length > 0 && t("chart_desc_sublimits")}
        </p>
      )}
      {body}
    </section>
  );
}

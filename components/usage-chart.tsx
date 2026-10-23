import { useLocale, useTranslations } from "next-intl";
import { ChartLegend, type ChartSeries, CycleChart } from "@/components/cycle-chart";
import { formatPercentTick } from "@/lib/chart";
import type { DashboardModel } from "@/lib/dashboard";
import { formatHeroPercent } from "@/lib/format";
import { type DashboardView, type SubLimitView, subLimitTimeline, timelineRates } from "@/lib/ground-truth";
import { NEUTRAL_COLOR } from "@/lib/settings";

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
 * the rates of lib/ground-truth.ts `timelineRates`: the current segment's at
 * the headline figure over its measured tokens, so the dashed line ends on
 * the headline percentage and the groups split it as their tokens do; a
 * segment a keep reset ended at that reset's own figure, every line starting
 * again from 0 at the reset. Each sub-limit whose figure is known runs beside
 * them in a fainter shade, as the share of its own budget: the same rule,
 * ending on its own figure.
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
  const rates = timelineRates(model, view);
  const colorOf = new Map(Object.entries(model.groupColors));
  const keeps = model.resets.filter((reset) => reset.kind === "keep");
  // Under an official reading, a finished segment without a figure of its own is only an estimate at the current rate.
  const paleSpans = view.calibrated
    ? keeps.flatMap((reset, index) =>
        reset.before === null ? [{ startMs: keeps[index - 1]?.atMs ?? model.cycle.startMs, endMs: reset.atMs }] : [],
      )
    : [];
  // Right after a reset the segment has nothing measured yet, but the cycle has.
  const measured = model.total > 0 || keeps.some((reset) => (reset.tokens ?? 0) > 0);

  const subLimitSeries: ChartSeries[] = subLimits.flatMap((subView, index) => {
    const values = subLimitTimeline(subView);
    return values
      ? [
          {
            id: `sub:${subView.sub.id}`,
            label: t("sublimit_label", { name: subView.sub.name }),
            color: subLimitColor(index),
            values,
            faint: true,
          },
        ]
      : [];
  });

  let body: React.ReactNode;
  if (!measured) {
    body = <p className="mt-3 max-w-xl text-ink-2">{t("no_measured_usage_chart")}</p>;
  } else if (rates === null) {
    body = (
      <p className="mt-3 max-w-xl text-ink-2">
        {model.closed ? t("chart_closed_no_official") : t("chart_official_explanation")}
      </p>
    );
  } else {
    const groups: ChartSeries[] = model.timeline.groups.map((group) => ({
      id: `group:${group.groupId}`,
      label: group.groupId,
      color: colorOf.get(group.groupId) ?? NEUTRAL_COLOR,
      values: group.values.map((tokens, index) => tokens * rates[index]!),
    }));
    const total: ChartSeries = {
      id: "total",
      label: t("total"),
      color: "var(--color-ink)",
      values: model.timeline.times.map((_, index) => groups.reduce((sum, group) => sum + group.values[index]!, 0)),
      dashed: true,
    };
    // Drawn in reverse: the sub-limits' fainter lines lie beneath the groups'.
    const series = [total, ...groups, ...subLimitSeries];

    body = (
      <>
        <div className="mt-4">
          <ChartLegend series={series} />
        </div>
        <div className="mt-5">
          <CycleChart
            model={model}
            series={series}
            minAxis={MIN_AXIS_FRACTION}
            formatTick={(fraction, scale) => formatPercentTick(fraction, scale.step, locale)}
            formatValue={(val) => formatHeroPercent(val, locale)}
            label={subLimitSeries.length > 0 ? t("chart_aria_with_sublimits") : t("chart_aria_no_sublimits")}
            paleSpans={paleSpans}
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
      {measured && rates !== null && (
        <p className="mt-1 text-sm text-ink-3">
          {view.calibrated ? t("chart_desc_official") : t("chart_desc_measured")}
          {subLimitSeries.length > 0 && t("chart_desc_sublimits")}
          {keeps.length > 0 && t("chart_desc_resets")}
          {paleSpans.length > 0 && t("chart_desc_pale")}
        </p>
      )}
      {body}
    </section>
  );
}

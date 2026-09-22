import { ChartLegend, CycleChart, type ChartSeries } from "@/components/cycle-chart";
import { formatPercentTick, niceScale } from "@/lib/chart";
import type { DashboardModel } from "@/lib/dashboard";
import { formatHeroPercent } from "@/lib/format";
import type { DashboardView } from "@/lib/ground-truth";
import { NEUTRAL_COLOR } from "@/lib/settings";

/** The percentage axis never shrinks below this: a quiet start of the cycle stays low on the chart. */
const MIN_AXIS_FRACTION = 0.1;

/**
 * How the budget went over the cycle: each group's share of it and, dashed,
 * all of them together. The measured tokens become a share of the budget at
 * one rate, the headline figure over all measured tokens, so the dashed line
 * ends on the headline percentage and the groups split it as their tokens do.
 */
export function UsageChart({ model, view }: { model: DashboardModel; view: DashboardView }) {
  // Per measured token: the official figure's share of it, or 1/limit when measured against a token limit.
  const fractionPerToken = view.quota && model.total > 0 ? view.quota.usedFraction / model.total : null;
  const colorOf = new Map(model.groups.map((group) => [group.groupId, group.color]));

  let body: React.ReactNode;
  if (model.total === 0) {
    body = <p className="mt-3 max-w-xl text-ink-2">Ebben a ciklusban még nincs mért fogyasztás.</p>;
  } else if (fractionPerToken === null) {
    body = (
      <p className="mt-3 max-w-xl text-ink-2">
        A grafikon a hivatalos százalékból számol: írd be fent, és a csoportok a mért tokenjeik arányában
        osztoznak rajta az idő mentén.
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
      label: "Összesen",
      color: "var(--color-ink)",
      values: model.timeline.times.map((_, index) =>
        groups.reduce((sum, group) => sum + group.values[index]!, 0),
      ),
      dashed: true,
    };
    const series = [total, ...groups];
    const scale = niceScale(Math.max(...total.values), MIN_AXIS_FRACTION);

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
            formatValue={formatHeroPercent}
            label="A keret fogyása a ciklusban, csoportonként és összesen"
          />
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="usage-chart-heading">
      <h2 id="usage-chart-heading" className="text-xl font-medium">
        Fogyás időben
      </h2>
      {fractionPerToken !== null && (
        <p className="mt-1 text-sm text-ink-3">
          {view.calibrated
            ? "A hivatalos százalék, a csoportok között a mért tokenjeik arányában elosztva."
            : "A tokenkeret százalékában, a gépek mérése szerint."}
        </p>
      )}
      {body}
    </section>
  );
}

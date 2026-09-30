import { useLocale, useTranslations } from "next-intl";
import { CycleChart, LineKey } from "@/components/cycle-chart";
import { formatPercentTick, formatTokenTick } from "@/lib/chart";
import type { DashboardModel } from "@/lib/dashboard";
import { formatHeroPercent, formatPercent, formatTokens } from "@/lib/format";
import type { DashboardView } from "@/lib/ground-truth";
import { groupMachineChart } from "@/lib/group-machines";

type Group = DashboardModel["groups"][number];

/** The percentage axis never shrinks below this: a quiet start of the cycle stays low on the chart. */
const MIN_AXIS_FRACTION = 0.05;
/** The same for the token axis, while there is no budget to take a share of. */
const MIN_AXIS_TOKENS = 1_000;

/**
 * The machines of one group against each other: what opens under a row of
 * the groups table. Each machine's share of the budget over the cycle, as its
 * own line, by the same rule as the usage chart's groups; the key above
 * carries each machine's tokens and its share of the group.
 */
export function GroupMachines({ group, model, view }: { group: Group; model: DashboardModel; view: DashboardView }) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const { basis, series } = groupMachineChart(model, view, group);
  // Without a token limit and an official figure there is no budget: the lines stay in tokens.
  const inFractions = basis !== "tokens";

  return (
    <>
      <p className="max-w-2xl text-sm text-ink-3">{t("group_machines_desc", { basis })}</p>
      <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-1.5 text-sm">
        {series.map(({ machine, color }) => (
          <li key={machine.machineId} className="flex min-w-0 items-center gap-2">
            <LineKey series={{ color }} />
            <span className="wrap-anywhere text-ink-2">{machine.machineId}</span>
            <span className="shrink-0">{formatTokens(machine.tokens, locale)}</span>
            <span className="shrink-0 text-ink-3">{formatPercent(machine.groupShare, locale)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-5">
        <CycleChart
          model={model}
          series={series.map(({ machine, color, values }) => ({
            id: `machine:${machine.machineId}`,
            label: machine.machineId,
            color,
            values,
          }))}
          minAxis={inFractions ? MIN_AXIS_FRACTION : MIN_AXIS_TOKENS}
          formatTick={(value, scale) =>
            inFractions ? formatPercentTick(value, scale.step, locale) : formatTokenTick(value, locale)
          }
          formatValue={(value) =>
            inFractions ? formatHeroPercent(value, locale) : t("token_amount", { count: Math.round(value) })
          }
          formatEndLabel={inFractions ? undefined : (value) => formatTokenTick(value, locale)}
          label={t("group_machines_aria", { id: group.groupId })}
        />
      </div>
    </>
  );
}

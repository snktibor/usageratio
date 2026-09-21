import { seriesColor, Swatch } from "@/components/group-breakdown";
import { CheckCircleIcon, ClockIcon, MoonIcon } from "@/components/icons";
import type { DashboardModel, MachineHealth } from "@/lib/dashboard";
import { formatAgo, formatDateTime, formatPercent, formatTokens } from "@/lib/format";

type Machine = DashboardModel["machines"][number];

const HEALTH: Record<
  MachineHealth,
  { label: string; icon: typeof CheckCircleIcon; iconColor: string }
> = {
  active: { label: "Aktív", icon: CheckCircleIcon, iconColor: "text-good" },
  late: { label: "Késik", icon: ClockIcon, iconColor: "text-warning" },
  inactive: { label: "Inaktív", icon: MoonIcon, iconColor: "text-ink-3" },
};

function rowKey(machine: Machine): string {
  return JSON.stringify([machine.machineId, machine.groupId]);
}

function LastReport({ machine, model }: { machine: Machine; model: DashboardModel }) {
  const health = HEALTH[machine.health];
  const HealthIcon = health.icon;
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <HealthIcon className={`shrink-0 ${health.iconColor}`} />
      <span>{health.label}</span>
      <time
        dateTime={new Date(machine.lastSeenAt).toISOString()}
        title={formatDateTime(machine.lastSeenAt, model.timeZone)}
        className="text-sm text-ink-3"
      >
        {formatAgo(machine.lastSeenAt, model.generatedAt)}
      </time>
    </span>
  );
}

export function MachineTable({ model }: { model: DashboardModel }) {
  return (
    <section aria-labelledby="machines-heading">
      <h2 id="machines-heading" className="text-xl font-medium">
        Gépek
      </h2>

      {/* Narrow screens: one stacked entry per machine instead of five squeezed columns. */}
      <ul className="mt-3 sm:hidden">
        {model.machines.map((machine) => (
          <li key={rowKey(machine)} className="border-t border-hairline py-3.5">
            <div className="flex items-baseline justify-between gap-4">
              <span className="min-w-0 wrap-anywhere">{machine.machineId}</span>
              <span className="shrink-0 tabular-nums">{formatTokens(machine.tokens)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-4 text-sm text-ink-3">
              <span className="flex min-w-0 items-center gap-2">
                <Swatch slot={machine.colorSlot} />
                <span className="wrap-anywhere">{machine.groupId}</span>
              </span>
              <span className="shrink-0 tabular-nums">{formatPercent(machine.share)}</span>
            </div>
            <div className="mt-2">
              <LastReport machine={machine} model={model} />
            </div>
          </li>
        ))}
      </ul>

      <table className="mt-3 hidden w-full border-collapse text-left sm:table">
        <thead>
          <tr className="text-sm text-ink-3">
            <th scope="col" className="py-2 pr-4 font-normal">
              Gép
            </th>
            <th scope="col" className="py-2 pr-4 font-normal">
              Csoport
            </th>
            <th scope="col" className="py-2 pl-4 text-right font-normal">
              Token
            </th>
            <th scope="col" className="py-2 pl-4 text-right font-normal">
              Részesedés
            </th>
            <th scope="col" className="py-2 pl-8 font-normal">
              Utolsó jelentés
            </th>
          </tr>
        </thead>
        <tbody>
          {model.machines.map((machine) => (
            <tr key={rowKey(machine)} className="border-t border-hairline">
              <th scope="row" className="py-3 pr-4 font-normal">
                <span className="wrap-anywhere">{machine.machineId}</span>
              </th>
              <td className="py-3 pr-4">
                <span className="flex items-center gap-2.5 text-ink-2">
                  <Swatch slot={machine.colorSlot} />
                  <span className="wrap-anywhere">{machine.groupId}</span>
                </span>
              </td>
              <td className="py-3 pl-4 text-right tabular-nums">{formatTokens(machine.tokens)}</td>
              <td className="py-3 pl-4 text-right tabular-nums">
                <span className="flex items-center justify-end gap-3">
                  <span aria-hidden="true" className="hidden h-1.5 w-24 rounded-r-[3px] bg-hairline md:block">
                    <span
                      className="block h-full rounded-r-[3px]"
                      style={{
                        width: `${machine.share * 100}%`,
                        backgroundColor: seriesColor(machine.colorSlot),
                      }}
                    />
                  </span>
                  <span className="w-12">{formatPercent(machine.share)}</span>
                </span>
              </td>
              <td className="py-3 pl-8">
                <LastReport machine={machine} model={model} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

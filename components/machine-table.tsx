import { CalibratedNote, Swatch } from "@/components/group-breakdown";
import { CheckCircleIcon, ClockIcon, MoonIcon } from "@/components/icons";
import type { DashboardModel, MachineHealth } from "@/lib/dashboard";
import { formatAgo, formatDateTime, formatLimitShare, formatPercent, formatTokens } from "@/lib/format";
import type { DashboardView } from "@/lib/ground-truth";

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

export function MachineTable({ model, view }: { model: DashboardModel; view: DashboardView }) {
  // No token limit and no official figure: there is no limit to take a share of.
  const hasLimitShare = view.quota !== null;

  return (
    <section aria-labelledby="machines-heading">
      <h2 id="machines-heading" className="flex flex-wrap items-baseline gap-x-3 text-xl font-medium">
        Gépek
        {view.calibrated && model.total > 0 && <CalibratedNote view={view} />}
      </h2>

      {/* Narrow screens: one stacked entry per machine instead of six squeezed columns. */}
      <ul className="mt-3 sm:hidden">
        {view.machines.map((machine) => (
          <li key={rowKey(machine)} className="border-t border-hairline py-3.5">
            <div className="flex items-baseline justify-between gap-4">
              <span className="min-w-0 wrap-anywhere">{machine.machineId}</span>
              <span className="shrink-0 tabular-nums">{formatTokens(machine.tokens)}</span>
            </div>
            <div className="mt-1 flex items-center justify-between gap-4 text-sm text-ink-3">
              <span className="flex min-w-0 items-center gap-2">
                <Swatch color={machine.color} />
                <span className="wrap-anywhere">{machine.groupId}</span>
              </span>
              <span className="shrink-0 tabular-nums">
                {formatPercent(machine.share)}
                {hasLimitShare && <> · a keret {formatLimitShare(machine.limitShare)}-a</>}
              </span>
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
            {hasLimitShare && (
              <th scope="col" className="whitespace-nowrap py-2 pl-4 text-right font-normal">
                A keretből
              </th>
            )}
            <th scope="col" className="py-2 pl-8 font-normal">
              Utolsó jelentés
            </th>
          </tr>
        </thead>
        <tbody>
          {view.machines.map((machine) => (
            <tr key={rowKey(machine)} className="border-t border-hairline">
              <th scope="row" className="py-3 pr-4 font-normal">
                <span className="wrap-anywhere">{machine.machineId}</span>
              </th>
              <td className="py-3 pr-4">
                <span className="flex items-center gap-2.5 text-ink-2">
                  <Swatch color={machine.color} />
                  <span className="wrap-anywhere">{machine.groupId}</span>
                </span>
              </td>
              <td className="py-3 pl-4 text-right tabular-nums">{formatTokens(machine.tokens)}</td>
              <td className="py-3 pl-4 text-right tabular-nums text-ink-2">
                <span className="flex items-center justify-end gap-3">
                  <span aria-hidden="true" className="hidden h-1.5 w-16 rounded-r-[3px] bg-hairline lg:block">
                    <span
                      className="block h-full rounded-r-[3px]"
                      style={{ width: `${machine.share * 100}%`, backgroundColor: machine.color }}
                    />
                  </span>
                  <span className="w-12">{formatPercent(machine.share)}</span>
                </span>
              </td>
              {hasLimitShare && (
                <td className="py-3 pl-4 text-right tabular-nums">{formatLimitShare(machine.limitShare)}</td>
              )}
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

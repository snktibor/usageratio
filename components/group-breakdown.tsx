import type { DashboardModel } from "@/lib/dashboard";
import { formatLimitShare, formatPercent, formatTokens } from "@/lib/format";
import type { DashboardView } from "@/lib/ground-truth";

type Group = DashboardModel["groups"][number];

/** `color` is the group's "#rrggbb": it comes from the settings, so it cannot be a Tailwind class. */
export function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 rounded-[2px]"
      style={{ backgroundColor: color }}
    />
  );
}

/** Next to a section heading while an official figure restates the figures below it. */
export function CalibratedNote({ view }: { view: DashboardView }) {
  return (
    <span className="text-sm font-normal text-ink-3">
      {/* Without a token limit the token counts stay as measured: only the shares of the limit follow the figure. */}
      {view.inTokens ? "a hivatalos értékhez igazítva" : "a hivatalos százalék a mért arányok szerint elosztva"}
    </span>
  );
}

/** Part-to-whole bar: 100% is this cycle's usage. The table below is its accessible twin. */
function ShareBar({ groups }: { groups: Group[] }) {
  const visible = groups.filter((group) => group.share > 0);

  return (
    <div role="group" aria-label="A csoportok részesedése a fogyasztásból" className="flex h-3.5 w-full gap-0.5">
      {visible.map((group, index) => {
        const isFirst = index === 0;
        const isLast = index === visible.length - 1;
        const tipAlign = isFirst
          ? "left-0"
          : isLast
            ? "right-0"
            : "left-1/2 -translate-x-1/2";
        return (
          <div
            key={group.groupId}
            role="img"
            tabIndex={0}
            aria-label={`${group.groupId}: ${formatTokens(group.tokens)} token, ${formatPercent(group.share)}`}
            className={`group/segment relative h-full min-w-1 transition-[filter] hover:brightness-125 focus-visible:brightness-125 ${isLast ? "rounded-r-[4px]" : ""}`}
            style={{ flex: `${group.share} 1 0%`, backgroundColor: group.color }}
          >
            <span
              role="tooltip"
              className={`pointer-events-none absolute top-full z-10 mt-2.5 whitespace-nowrap rounded-md bg-raised px-3 py-2 text-sm opacity-0 shadow-lg ring-1 ring-white/10 transition-opacity group-hover/segment:opacity-100 group-focus-visible/segment:opacity-100 ${tipAlign}`}
            >
              <strong className="font-medium text-ink">{formatTokens(group.tokens)} token</strong>
              <span className="ml-2 text-ink-2">
                {group.groupId}, {formatPercent(group.share)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function GroupBreakdown({ model, view }: { model: DashboardModel; view: DashboardView }) {
  // The split itself always comes from the machines: without measurements there is nothing to show.
  const hasUsage = model.total > 0;
  // No token limit and no official figure: there is no limit to take a share of.
  const hasLimitShare = view.quota !== null;

  return (
    <section aria-labelledby="groups-heading">
      <h2 id="groups-heading" className="flex flex-wrap items-baseline gap-x-3 text-xl font-medium">
        Csoportok
        {view.calibrated && hasUsage && <CalibratedNote view={view} />}
      </h2>

      {hasUsage ? (
        <>
          <div className="mt-5">
            <ShareBar groups={view.groups} />
          </div>

          <table className="mt-5 w-full border-collapse text-left">
            <thead>
              <tr className="text-sm text-ink-3">
                <th scope="col" className="py-2 pr-4 font-normal">
                  Csoport
                </th>
                <th scope="col" className="py-2 pl-4 text-right font-normal">
                  Token
                </th>
                <th scope="col" className="hidden py-2 pl-4 text-right font-normal sm:table-cell">
                  Részesedés
                </th>
                {hasLimitShare && (
                  <th scope="col" className="whitespace-nowrap py-2 pl-4 text-right font-normal">
                    A keretből
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {view.groups.map((group) => (
                <tr key={group.groupId} className="border-t border-hairline">
                  <th scope="row" className="py-3 pr-4 font-normal">
                    <span className="flex items-center gap-2.5">
                      <Swatch color={group.color} />
                      <span className="wrap-anywhere">{group.groupId}</span>
                      <span className="hidden shrink-0 text-sm text-ink-3 sm:inline">{group.machines} gép</span>
                    </span>
                    {/* Narrow screens have no room for a fourth column: the share moves under the name. */}
                    <span className="mt-0.5 block pl-5 text-sm text-ink-3 sm:hidden">
                      {formatPercent(group.share)} · {group.machines} gép
                    </span>
                  </th>
                  <td className="py-3 pl-4 text-right">{formatTokens(group.tokens)}</td>
                  <td className="hidden py-3 pl-4 text-right text-ink-2 sm:table-cell">
                    {formatPercent(group.share)}
                  </td>
                  {hasLimitShare && (
                    <td className="py-3 pl-4 text-right">{formatLimitShare(group.limitShare)}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="mt-4 max-w-xl text-ink-2">
          Ebben a ciklusban még nincs fogyasztás. A bontás az első tokeneket jelentő beküldés után jelenik meg.
        </p>
      )}
    </section>
  );
}

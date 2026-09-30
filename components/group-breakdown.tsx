import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { GroupMachines } from "@/components/group-machines";
import { ChevronRightIcon } from "@/components/icons";
import type { DashboardModel } from "@/lib/dashboard";
import { formatCostOrDash, formatLimitShare, formatPercent, formatTokens } from "@/lib/format";
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
  const t = useTranslations("Widgets");
  return (
    <span className="text-sm font-normal text-ink-3">
      {/* Without a token limit the token counts stay as measured: only the shares of the limit follow the figure. */}
      {view.inTokens ? t("adjusted_to_official") : t("official_allocated_by_measured")}
    </span>
  );
}

/** Part-to-whole bar: 100% is this cycle's usage. The table below is its accessible twin. */
function ShareBar({ groups }: { groups: Group[] }) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const visible = groups.filter((group) => group.share > 0);

  return (
    <div role="group" aria-label={t("group_share_aria")} className="flex h-3.5 w-full gap-0.5">
      {visible.map((group, index) => {
        const isFirst = index === 0;
        const isLast = index === visible.length - 1;
        const tipAlign = isFirst ? "left-0" : isLast ? "right-0" : "left-1/2 -translate-x-1/2";
        return (
          <div
            key={group.groupId}
            role="img"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users reach each segment's tooltip
            tabIndex={0}
            aria-label={`${group.groupId}: ${t("token_amount", { count: group.tokens })}, ${formatPercent(group.share, locale)}`}
            className={`group/segment relative h-full min-w-1 transition-[filter] hover:brightness-125 focus-visible:brightness-125 ${isLast ? "rounded-r-[4px]" : ""}`}
            style={{ flex: `${group.share} 1 0%`, backgroundColor: group.color }}
          >
            <span
              role="tooltip"
              className={`pointer-events-none absolute top-full z-10 mt-2.5 whitespace-nowrap rounded-md bg-raised px-3 py-2 text-sm opacity-0 shadow-lg ring-1 ring-ink/10 transition-opacity group-hover/segment:opacity-100 group-focus-visible/segment:opacity-100 ${tipAlign}`}
            >
              <strong className="font-medium text-ink">{t("token_amount", { count: group.tokens })}</strong>
              <span className="ml-2 text-ink-2">
                {group.groupId}, {formatPercent(group.share, locale)}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One group's row, and under it, while open, the chart of its machines against each other. */
function GroupRows({
  group,
  model,
  view,
  open,
  onToggle,
}: {
  group: Group;
  model: DashboardModel;
  view: DashboardView;
  open: boolean;
  onToggle: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const panelId = useId();
  const hasLimitShare = view.quota !== null;
  const hasCost = Boolean(model.cost);
  const chevron = `shrink-0 text-ink-3 transition group-hover/row:text-ink motion-reduce:transition-none ${open ? "rotate-90" : ""}`;

  return (
    <>
      {/* The button in the first cell is the keyboard's way in, and its click bubbles up here: the row only widens the pointer's target. */}
      <tr className="group/row cursor-pointer border-t border-hairline" onClick={onToggle}>
        <th scope="row" className="py-3 pr-4 font-normal">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            className="block w-full cursor-pointer text-left"
          >
            <span className="flex items-center gap-2.5">
              <ChevronRightIcon className={`hidden sm:block ${chevron}`} />
              <Swatch color={group.color} />
              <span className="wrap-anywhere">{group.groupId}</span>
              <span className="hidden shrink-0 text-sm text-ink-3 sm:inline">
                {t("machines_count", { count: group.machines })}
              </span>
            </span>
            {/*
              Narrow screens have no room for a fourth column: the share moves under the name. Nor for a
              chevron before the name, which would break it mid-word: it takes the indent under the swatch.
            */}
            <span className="mt-0.5 flex items-center text-sm text-ink-3 sm:hidden">
              <span className="w-5 shrink-0">
                <ChevronRightIcon className={`-ml-0.5 size-3.5 ${chevron}`} />
              </span>
              {formatPercent(group.share, locale)} · {t("machines_count", { count: group.machines })}
            </span>
          </button>
        </th>
        <td className="py-3 pl-4 text-right">{formatTokens(group.tokens, locale)}</td>
        <td className="hidden py-3 pl-4 text-right text-ink-2 sm:table-cell">{formatPercent(group.share, locale)}</td>
        {hasLimitShare && <td className="py-3 pl-4 text-right">{formatLimitShare(group.limitShare, locale)}</td>}
        {hasCost && (
          <td className="py-3 pl-4 text-right text-ink-2">
            {formatCostOrDash(model.cost?.byGroup[group.groupId], locale)}
          </td>
        )}
      </tr>
      {open && (
        <tr>
          {/* On the page's own ground, like the other charts: their labels and tooltips are drawn for it. */}
          <td colSpan={3 + Number(hasLimitShare) + Number(hasCost)} className="pb-8 pt-1">
            {/* No width of its own, then all of the cell's: its long lines must not move the columns above. */}
            <div id={panelId} className="w-0 min-w-full">
              <GroupMachines group={group} model={model} view={view} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export function GroupBreakdown({ model, view }: { model: DashboardModel; view: DashboardView }) {
  const t = useTranslations("Widgets");
  // One at a time: opening a group closes the one that was open.
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  // The split itself always comes from the machines: without measurements there is nothing to show.
  const hasUsage = model.total > 0;
  // No token limit and no official figure: there is no limit to take a share of.
  const hasLimitShare = view.quota !== null;
  const hasCost = Boolean(model.cost);

  const toggle = (groupId: string) => setOpenGroup((current) => (current === groupId ? null : groupId));

  return (
    <section aria-labelledby="groups-heading">
      <h2 id="groups-heading" className="flex flex-wrap items-baseline gap-x-3 text-xl font-medium">
        {t("groups")}
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
                  {t("group")}
                </th>
                <th scope="col" className="py-2 pl-4 text-right font-normal">
                  {t("token")}
                </th>
                <th scope="col" className="hidden py-2 pl-4 text-right font-normal sm:table-cell">
                  {t("share")}
                </th>
                {hasLimitShare && (
                  <th scope="col" className="whitespace-nowrap py-2 pl-4 text-right font-normal">
                    {t("of_quota")}
                  </th>
                )}
                {hasCost && (
                  <th scope="col" className="py-2 pl-4 text-right font-normal">
                    {t("cost")}
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {view.groups.map((group) => (
                <GroupRows
                  key={group.groupId}
                  group={group}
                  model={model}
                  view={view}
                  open={openGroup === group.groupId}
                  onToggle={() => toggle(group.groupId)}
                />
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="mt-4 max-w-xl text-ink-2">{t("no_usage_yet")}</p>
      )}
    </section>
  );
}

"use client";

import { useLocale, useTranslations } from "next-intl";
import { ChevronRightIcon } from "@/components/icons";
import type { AllTimeSummary } from "@/lib/all-time";
import { formatDate, formatFactor, formatPercent, formatTokens } from "@/lib/format";
import { NEUTRAL_COLOR } from "@/lib/settings";

/** How many groups the closed section names after its bar; the rest are counted. */
const NAMED_GROUPS = 3;

/**
 * "All time": the selected provider's usage by group over every cycle it
 * ever archived, and the current one so far (lib/all-time.ts). Closed, it is
 * one bar and the heaviest groups' shares; opened, a table with each group's
 * tokens, share, quota used and cycles. Shown once there is at least one
 * finished cycle to add up: before that it would only repeat the current one.
 */
export function AllTimeGroups({
  summary,
  timeZone,
  groupColors,
}: {
  summary: AllTimeSummary | null;
  timeZone: string;
  /** groupId → colour, for every group still defined: one missing from it is gone (deleted or renamed since). */
  groupColors: Record<string, string>;
}) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  if (!summary || summary.cycles - Number(summary.includesCurrent) === 0) return null;

  const colorOf = (groupId: string) => groupColors[groupId] ?? NEUTRAL_COLOR;
  const nameOf = (groupId: string) =>
    Object.hasOwn(groupColors, groupId) ? groupId : t("all_time_group_gone", { group: groupId });
  const named = summary.groups.slice(0, NAMED_GROUPS);
  const rest = summary.groups.length - named.length;
  const hasQuota = summary.quota !== null;
  const span = {
    since: formatDate(summary.sinceMs, timeZone, locale),
    cycles: summary.cycles,
    tokens: formatTokens(summary.total, locale),
  };

  return (
    <section aria-labelledby="all-time-heading">
      <h2 id="all-time-heading" className="text-xl font-medium">
        {t("all_time_heading")}
      </h2>
      <p className="mt-1 text-sm text-ink-3 tabular-nums">
        {summary.includesCurrent ? t("all_time_span_current", span) : t("all_time_span", span)}
      </p>

      <details className="group/all-time mt-4">
        <summary className="cursor-pointer list-none marker:content-none [&::-webkit-details-marker]:hidden">
          <span aria-hidden="true" className="flex h-2.5 w-full gap-0.5">
            {summary.groups.map((group) => (
              <span
                key={group.groupId}
                className="h-full min-w-0.5 rounded-[2px]"
                style={{ flex: `${group.tokens} 1 0%`, backgroundColor: colorOf(group.groupId) }}
              />
            ))}
          </span>
          <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-2">
            {named.map((group) => (
              <span key={group.groupId} className="flex min-w-0 items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: colorOf(group.groupId) }}
                />
                <span className="wrap-anywhere">{nameOf(group.groupId)}</span>
                <span className="tabular-nums text-ink-3">{formatPercent(group.share, locale)}</span>
              </span>
            ))}
            {rest > 0 && <span className="text-ink-3">{t("all_time_more_groups", { count: rest })}</span>}
            <span className="ml-auto flex items-center gap-1 text-ink-3 transition-colors hover:text-ink">
              <span className="group-open/all-time:hidden">{t("all_time_show")}</span>
              <span className="hidden group-open/all-time:inline">{t("all_time_hide")}</span>
              <ChevronRightIcon className="size-3.5 transition-transform group-open/all-time:rotate-90 motion-reduce:transition-none" />
            </span>
          </span>
        </summary>

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
              {hasQuota && (
                <th scope="col" className="whitespace-nowrap py-2 pl-4 text-right font-normal">
                  {t("all_time_quota")}
                </th>
              )}
              <th scope="col" className="hidden whitespace-nowrap py-2 pl-4 text-right font-normal sm:table-cell">
                {t("all_time_cycles")}
              </th>
              <th scope="col" className="hidden whitespace-nowrap py-2 pl-4 text-right font-normal md:table-cell">
                {t("all_time_per_cycle")}
              </th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {summary.groups.map((group) => (
              <tr key={group.groupId} className="border-t border-hairline">
                <th scope="row" className="py-3 pr-4 font-normal">
                  <span className="flex items-center gap-2.5">
                    <span
                      aria-hidden="true"
                      className="inline-block size-2.5 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: colorOf(group.groupId) }}
                    />
                    <span className="wrap-anywhere">{nameOf(group.groupId)}</span>
                  </span>
                  {/* Narrow screens have no room for the share and the cycles: they move under the name. */}
                  <span className="mt-0.5 block pl-5 text-sm text-ink-3 sm:hidden">
                    {formatPercent(group.share, locale)} · {t("all_time_cycles_count", { count: group.cycles })}
                  </span>
                </th>
                <td className="py-3 pl-4 text-right">{formatTokens(group.tokens, locale)}</td>
                <td className="hidden py-3 pl-4 text-right text-ink-2 sm:table-cell">
                  {formatPercent(group.share, locale)}
                </td>
                {hasQuota && (
                  <td className="py-3 pl-4 text-right">
                    {group.quota === null ? "–" : formatFactor(group.quota, locale)}
                  </td>
                )}
                <td className="hidden py-3 pl-4 text-right text-ink-2 sm:table-cell">{group.cycles}</td>
                <td className="hidden py-3 pl-4 text-right text-ink-2 md:table-cell">
                  {formatTokens(group.tokens / group.cycles, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-3 max-w-2xl space-y-1 text-sm text-ink-3">
          {hasQuota && (
            <p>
              {t("all_time_quota_note", { total: formatFactor(summary.quota ?? 0, locale) })}
              {summary.quotaCycles < summary.cycles &&
                ` ${t("all_time_quota_partial", { known: summary.quotaCycles, cycles: summary.cycles })}`}
            </p>
          )}
          <p>{t("all_time_groups_note")}</p>
        </div>
      </details>
    </section>
  );
}

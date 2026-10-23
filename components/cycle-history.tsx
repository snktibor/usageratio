"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRightIcon } from "@/components/icons";
import { Segmented } from "@/components/ui/segmented";
import { Link } from "@/i18n/routing";
import { formatTokenTick, niceScale } from "@/lib/chart";
import type { CycleKind } from "@/lib/cycle-options";
import { formatCycleRange, formatHeroPercent, formatPercent, formatTokens } from "@/lib/format";
import { type CycleSummary, groupSharesOf } from "@/lib/history";
import type { Translator } from "@/lib/i18n";
import { NEUTRAL_COLOR } from "@/lib/settings";

/**
 * "Previous cycles": the archived cycles of the selected provider
 * (lib/history.ts), newest first, each a link to its own view (the full
 * dashboard while its reports are still kept, its summary after that). Above
 * them, once there are at least two to compare, a small column chart in
 * components/cycle-chart.tsx's visual language and keyboard pattern. The list
 * never grows past VISIBLE_ROWS rows: the rest scroll inside it.
 */

type Metric = "official" | "limitShare" | "measured";

/**
 * What the bars show, decided once for the whole set: the official percentage
 * when any archived cycle has one (the most informative figure, when the
 * owner bothers to type it); otherwise the share of the token limit, while
 * any cycle was measured against one; otherwise the raw measured tokens. A
 * cycle missing that particular figure (settings changed over time) still
 * gets a column, just marked as not recorded.
 */
function pickMetric(history: CycleSummary[]): Metric {
  if (history.some((entry) => entry.official !== null)) return "official";
  if (history.some((entry) => entry.limit !== null)) return "limitShare";
  return "measured";
}

function metricValueOf(entry: CycleSummary, metric: Metric): number | null {
  if (metric === "official") return entry.official;
  if (metric === "limitShare") return limitShareOf(entry);
  return entry.total;
}

/** The measured tokens as a percentage of the cycle's token limit; null without one. */
function limitShareOf(entry: CycleSummary): number | null {
  return entry.limit !== null && entry.limit > 0 ? (entry.total / entry.limit) * 100 : null;
}

const MIN_AXIS_TOKENS = 1_000;
const PAD_TOP = 18;
/** A cycle missing this chart's metric still gets a column, this tall, so it reads as "not recorded" rather than as a gap. */
const UNKNOWN_BAR_HEIGHT = 4;
/** How many cycles the list shows at once; the older ones are reached by scrolling inside it. */
const VISIBLE_ROWS = 3;
/** A column never grows wider than this: a handful of cycles must not turn into slabs. */
const MAX_BAR_WIDTH = 40;
/** Below this much room per column, only every other date label fits under the chart. */
const LABEL_ROOM = 52;
/** The gap between two groups stacked in one column. */
const SEGMENT_GAP = 1;

/**
 * One bar per cycle, or each bar split between the groups by their measured
 * tokens. The choice is the viewer's own, remembered in this browser only
 * (with storage blocked it lasts until the page is left), so opening another
 * cycle keeps it.
 */
type ChartView = "total" | "groups";
const VIEW_KEY = "usageratio_history_view";
const viewListeners = new Set<() => void>();
let chosenView: ChartView | null = null;

function readView(): ChartView {
  if (chosenView) return chosenView;
  try {
    return localStorage.getItem(VIEW_KEY) === "groups" ? "groups" : "total";
  } catch {
    return "total";
  }
}

function writeView(view: ChartView) {
  chosenView = view;
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // Storage blocked: `chosenView` still carries it for this page.
  }
  for (const listener of viewListeners) listener();
}

function subscribeView(listener: () => void) {
  // Another tab's choice wins over this one's.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== VIEW_KEY) return;
    chosenView = null;
    listener();
  };
  viewListeners.add(listener);
  window.addEventListener("storage", onStorage);
  return () => {
    viewListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function useChartView(): ChartView {
  return useSyncExternalStore(subscribeView, readView, () => "total");
}

/** The groups of every cycle on the chart, heaviest overall first: the same order, and stacking, in each column. */
function groupOrderOf(history: CycleSummary[]): string[] {
  const totals = new Map<string, number>();
  for (const entry of history) {
    for (const [groupId, tokens] of Object.entries(entry.groups)) {
      if (tokens > 0) totals.set(groupId, (totals.get(groupId) ?? 0) + tokens);
    }
  }
  return [...totals].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).map(([groupId]) => groupId);
}

/**
 * How much of the budget the cycle came to: the official figure, else the share of its token limit. A cycle
 * with keep resets came to the sum of its segments' figures, listed after it ("124% (80% + 44%)").
 */
function FinalUsage({ entry, t, locale }: { entry: CycleSummary; t: Translator<"Widgets">; locale: string }) {
  const limitShare = limitShareOf(entry);
  const [figure, note] =
    entry.official !== null
      ? [formatHeroPercent(entry.official / 100, locale), t("history_final_official")]
      : limitShare !== null
        ? [formatHeroPercent(limitShare / 100, locale), t("history_final_limit")]
        : ["–", t("history_final_unknown")];
  const parts =
    entry.official !== null && entry.segments
      ? entry.segments
          .map((segment) => (segment.official === null ? "–" : formatPercent(segment.official / 100, locale)))
          .join(" + ")
      : null;
  return (
    <span className="flex flex-col items-end text-right">
      <span className={`text-xl font-medium tabular-nums ${figure === "–" ? "text-ink-3" : "text-ink"}`}>{figure}</span>
      {parts && <span className="text-xs tabular-nums text-ink-3">({parts})</span>}
      <span className="text-xs text-ink-3">{note}</span>
    </span>
  );
}

function HistoryChart({
  history,
  timeZone,
  groupColors,
  t,
  locale,
}: {
  history: CycleSummary[];
  timeZone: string;
  groupColors: Record<string, string>;
  t: Translator<"Widgets">;
  locale: string;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  // Only a crosshair moved by the keyboard is read out: a pointer would flood the screen reader.
  const [announce, setAnnounce] = useState(false);
  const hintId = useId();
  const viewName = useId();
  const view = useChartView();
  const byGroup = view === "groups";

  useLayoutEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const measure = () => setSize({ width: plot.clientWidth, height: plot.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(plot);
    return () => observer.disconnect();
  }, []);

  // The chart reads left to right, oldest to newest, like the main cycle chart; the list below stays newest first.
  const chronological = [...history].reverse();
  const last = chronological.length - 1;
  const metric = pickMetric(history);
  const values = chronological.map((entry) => metricValueOf(entry, metric));
  const isPercent = metric !== "measured";
  const groupOrder = groupOrderOf(history);
  const colorOf = (groupId: string) => groupColors[groupId] ?? NEUTRAL_COLOR;
  // Each column's value split between its groups, bottom to top in `groupOrder`: a percentage as the cycle's own
  // figure splits (per segment, with keep resets: lib/history.ts `groupSharesOf`), tokens by their share.
  const segments = chronological.map((entry, index) => {
    const value = values[index]!;
    if (value === null) return [];
    const shares = new Map(groupSharesOf(entry).map((group) => [group.groupId, group]));
    return groupOrder.flatMap((groupId) => {
      const group = shares.get(groupId);
      if (!group) return [];
      const part = metric !== "measured" && group.quotaShare !== null ? group.quotaShare * 100 : value * group.share;
      return [{ groupId, value: part }];
    });
  });
  const groupCells = (index: number) =>
    groupOrder.map((groupId) => segments[index]!.find((segment) => segment.groupId === groupId));

  const scale = niceScale(
    Math.max(0, ...values.filter((value): value is number => value !== null)),
    isPercent ? 100 : MIN_AXIS_TOKENS,
  );
  const formatValue = (value: number) =>
    isPercent ? formatPercent(value / 100, locale) : t("token_amount", { count: Math.round(value) });
  const formatTick = (value: number) =>
    isPercent ? formatPercent(value / 100, locale) : formatTokenTick(value, locale);
  const rangeOf = (entry: CycleSummary) => formatCycleRange(entry.start, entry.end, timeZone, locale);
  const dayOf = (entry: CycleSummary) =>
    new Intl.DateTimeFormat(locale, { timeZone, month: "short", day: "numeric" }).format(entry.start);

  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const count = chronological.length;
  const colWidth = count > 0 ? width / count : 0;
  const barWidth = Math.min(MAX_BAR_WIDTH, Math.max(2, colWidth * 0.6));
  const labelEvery = colWidth >= LABEL_ROOM ? 1 : Math.ceil(LABEL_ROOM / Math.max(1, colWidth));
  const yOf = (value: number) => PAD_TOP + (1 - Math.max(0, value) / scale.max) * (height - PAD_TOP);
  const xOf = (index: number) => index * colWidth + colWidth / 2;

  const readout = (index: number) => {
    const value = values[index]!;
    const head = `${rangeOf(chronological[index]!)}: ${value === null ? t("history_value_unknown") : formatValue(value)}`;
    if (!byGroup || segments[index]!.length === 0) return head;
    return `${head} (${segments[index]!.map((segment) => `${segment.groupId} ${formatValue(segment.value)}`).join(", ")})`;
  };

  const pointAt = (clientX: number) => {
    const plot = plotRef.current;
    if (!plot || count === 0) return;
    setAnnounce(false);
    const x = clientX - plot.getBoundingClientRect().left;
    setActive(Math.min(count - 1, Math.max(0, Math.floor(x / colWidth))));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const current = active ?? last;
    const next =
      event.key === "ArrowLeft"
        ? Math.max(0, current - 1)
        : event.key === "ArrowRight"
          ? Math.min(last, current + 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (event.key === "Escape") setActive(null);
    if (next === null) return;
    event.preventDefault();
    setAnnounce(true);
    setActive(next);
  };

  const activeIndex = active ?? last;
  const activeX = active === null ? 0 : xOf(active);
  const tipOnLeft = activeX > width / 2;
  const tipRoom = Math.max(0, (tipOnLeft ? activeX : width - activeX) - 12);

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <p className="max-w-xl text-sm text-ink-3">
          {t(`history_metric_note_${metric}`)}
          {byGroup && ` ${t("history_groups_note")}`}
        </p>
        <div role="radiogroup" aria-label={t("history_view_label")}>
          <Segmented
            name={viewName}
            size="sm"
            value={view}
            onChange={writeView}
            options={[
              { value: "total", label: t("history_view_total") },
              { value: "groups", label: t("history_view_groups") },
            ]}
          />
        </div>
      </div>
      <div
        ref={plotRef}
        role="group"
        aria-label={t("history_chart_aria")}
        aria-describedby={hintId}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the plot is keyboard-operated (arrow keys move between cycles)
        tabIndex={0}
        onPointerMove={(event) => pointAt(event.clientX)}
        onPointerDown={(event) => pointAt(event.clientX)}
        onPointerLeave={() => setActive(null)}
        onFocus={() => {
          setAnnounce(true);
          setActive((current) => current ?? last);
        }}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
        className="relative mt-4 h-36 touch-pan-y select-none sm:h-44"
      >
        {size && (
          <svg width={width} height={height} aria-hidden="true" className="absolute inset-0 overflow-visible">
            {scale.ticks.map((tick) => {
              const y = Math.round(yOf(tick)) - 0.5;
              return (
                <line
                  key={tick}
                  x1={0}
                  x2={width}
                  y1={y}
                  y2={y}
                  stroke={tick === 0 ? "var(--color-rule)" : "var(--color-hairline)"}
                />
              );
            })}
            {chronological.map((entry, index) => {
              const value = values[index]!;
              const y = value === null ? height - UNKNOWN_BAR_HEIGHT : yOf(value);
              const stack = segments[index]!;
              if (byGroup && stack.length > 0) {
                // Bottom up; while a column is pointed at, the others step back.
                let bottom = height;
                return (
                  <g key={entry.start} opacity={active === null || index === active ? 1 : 0.45}>
                    {stack.map((segment, position) => {
                      const top = yOf(stack.slice(0, position + 1).reduce((sum, s) => sum + s.value, 0));
                      const gap = position > 0 ? SEGMENT_GAP : 0;
                      const rect = (
                        <rect
                          key={segment.groupId}
                          x={xOf(index) - barWidth / 2}
                          y={top}
                          width={barWidth}
                          height={Math.max(0, bottom - top - gap)}
                          rx={1.5}
                          fill={colorOf(segment.groupId)}
                        />
                      );
                      bottom = top;
                      return rect;
                    })}
                  </g>
                );
              }
              return (
                <rect
                  key={entry.start}
                  x={xOf(index) - barWidth / 2}
                  y={y}
                  width={barWidth}
                  height={Math.max(value === null ? UNKNOWN_BAR_HEIGHT : 0, height - y)}
                  rx={1.5}
                  fill={index === activeIndex ? "var(--color-ink)" : "var(--color-ink-3)"}
                  opacity={value === null ? 0.35 : 1}
                />
              );
            })}
          </svg>
        )}

        {size &&
          scale.ticks.map((tick) => (
            <span
              key={tick}
              aria-hidden="true"
              className="absolute right-0 rounded-sm bg-page px-1 text-xs leading-none text-ink-3 tabular-nums"
              style={{ top: Math.round(yOf(tick)) - 15 }}
            >
              {formatTick(tick)}
            </span>
          ))}

        {active !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-md bg-raised px-3 py-2 text-sm shadow-lg ring-1 ring-ink/10"
            style={{ maxWidth: tipRoom, ...(tipOnLeft ? { right: width - activeX + 12 } : { left: activeX + 12 }) }}
          >
            <p className="text-xs text-ink-3">{rangeOf(chronological[active]!)}</p>
            <p className="mt-1 font-medium text-ink tabular-nums">
              {values[active] === null ? t("history_value_unknown") : formatValue(values[active]!)}
            </p>
            {byGroup && segments[active]!.length > 0 && (
              <ul className="mt-1.5 space-y-0.5">
                {[...segments[active]!].reverse().map((segment) => (
                  <li key={segment.groupId} className="flex items-center gap-1.5 text-ink-2">
                    <span
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: colorOf(segment.groupId) }}
                    />
                    <span className="truncate">{segment.groupId}</span>
                    <span className="ml-auto pl-3 tabular-nums">{formatValue(segment.value)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <p id={hintId} className="sr-only">
          {t("keyboard_hint")}
        </p>
        <p aria-live="polite" className="sr-only">
          {announce && active !== null ? readout(active) : ""}
        </p>
      </div>

      {/* Which column is which cycle: its first day, under it. */}
      <div aria-hidden="true" className="relative mt-1.5 h-5">
        {size &&
          chronological.map((entry, index) =>
            (last - index) % labelEvery === 0 ? (
              <span
                key={entry.start}
                className={`absolute top-0 -translate-x-1/2 whitespace-nowrap text-xs ${
                  index === activeIndex ? "text-ink" : "text-ink-3"
                }`}
                style={{ left: xOf(index) }}
              >
                {dayOf(entry)}
              </span>
            ) : null,
          )}
      </div>

      {byGroup && groupOrder.length > 0 && (
        <ul aria-hidden="true" className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
          {groupOrder.map((groupId) => (
            <li key={groupId} className="flex min-w-0 items-center gap-1.5">
              <span className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: colorOf(groupId) }} />
              <span className="wrap-anywhere">{groupId}</span>
            </li>
          ))}
        </ul>
      )}

      <details className="mt-2 text-sm">
        <summary className="w-fit cursor-pointer text-ink-3 transition-colors hover:text-ink">{t("as_table")}</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">{t("history_chart_aria")}</caption>
            <thead>
              <tr className="text-ink-3">
                <th scope="col" className="py-2 pr-4 font-normal">
                  {t("history_cycle_column")}
                </th>
                {byGroup &&
                  groupOrder.map((groupId) => (
                    <th key={groupId} scope="col" className="py-2 pl-4 text-right font-normal">
                      {groupId}
                    </th>
                  ))}
                <th scope="col" className="py-2 pl-4 text-right font-normal">
                  {t("history_value_column")}
                </th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {chronological.map((entry, index) => (
                <tr key={entry.start} className="border-t border-hairline">
                  <th scope="row" className="py-2 pr-4 font-normal text-ink-2">
                    {rangeOf(entry)}
                  </th>
                  {byGroup &&
                    groupCells(index).map((cell, column) => (
                      <td key={groupOrder[column]} className="py-2 pl-4 text-right text-ink-2">
                        {cell ? formatValue(cell.value) : "–"}
                      </td>
                    ))}
                  <td className="py-2 pl-4 text-right">
                    {values[index] === null ? t("history_value_unknown") : formatValue(values[index]!)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

export function CycleHistory({
  history,
  timeZone,
  groupColors,
  kinds,
  selectedStartMs,
}: {
  history: CycleSummary[];
  timeZone: string;
  /** groupId → colour. */
  groupColors: Record<string, string>;
  /** A cycle's start → how it opens; a start not listed opens as the full dashboard. */
  kinds: Record<number, CycleKind>;
  /** The cycle on screen, if it is one of these. */
  selectedStartMs: number | null;
}) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [maxHeight, setMaxHeight] = useState<number>();
  const scrolls = history.length > VISIBLE_ROWS;

  // Exactly VISIBLE_ROWS rows tall, however tall they wrap to at this width.
  // biome-ignore lint/correctness/useExhaustiveDependencies: other cycles are other rows to measure
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !scrolls) {
      setMaxHeight(undefined);
      return;
    }
    const measure = () =>
      setMaxHeight(
        Array.from(list.children)
          .slice(0, VISIBLE_ROWS)
          .reduce((sum, row) => sum + (row as HTMLElement).offsetHeight, 0),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [history, scrolls]);

  // The cycle on screen stays in sight, even when it is one of the rows scrolled out of the list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs again once the list has its height, and for another cycle
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const row = scroller?.querySelector<HTMLElement>('[aria-current="page"]')?.parentElement;
    if (!scroller || !row) return;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  }, [selectedStartMs, maxHeight]);

  return (
    <section aria-labelledby="history-heading">
      <h2 id="history-heading" className="text-xl font-medium">
        {t("history_heading")}
      </h2>

      {history.length === 0 ? (
        <p className="mt-3 max-w-xl text-ink-2">{t("history_empty")}</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-ink-3">{t("history_intro")}</p>
          {/* One column says nothing a row does not: the chart waits for a second cycle to compare. */}
          {history.length >= 2 && (
            <HistoryChart history={history} timeZone={timeZone} groupColors={groupColors} t={t} locale={locale} />
          )}

          {/* The rules stay put; the rows scroll between them, their hover bleeding into the gutters as before. */}
          <div className="mt-6 border-y border-hairline">
            <div
              ref={scrollerRef}
              className={`code-scroll relative -mx-3 overflow-y-auto px-3 ${scrolls ? "max-h-96" : ""}`}
              style={{ maxHeight }}
            >
              {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none */}
              <ul ref={listRef} role="list">
                {history.map((entry) => {
                  const groups = groupSharesOf(entry);
                  const summaryOnly = kinds[entry.start] === "summary";
                  const current = entry.start === selectedStartMs;
                  return (
                    <li key={entry.start} className="border-hairline not-first:border-t">
                      <Link
                        href={`/?cycle=${entry.start}`}
                        aria-current={current ? "page" : undefined}
                        className={`group -mx-3 block rounded-md px-3 py-4 transition-colors hover:bg-raised ${
                          current ? "bg-raised" : ""
                        }`}
                      >
                        <span className="flex items-start justify-between gap-4">
                          <span className="min-w-0">
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="font-medium text-ink">
                                {formatCycleRange(entry.start, entry.end, timeZone, locale)}
                              </span>
                              {summaryOnly && (
                                <span className="rounded-full border border-rule px-2 py-0.5 text-xs text-ink-3">
                                  {t("history_summary_badge")}
                                </span>
                              )}
                              {entry.endedByReset && (
                                <span className="rounded-full border border-rule px-2 py-0.5 text-xs text-ink-3">
                                  {t("history_ended_by_reset")}
                                </span>
                              )}
                            </span>
                            <span className="mt-1 block text-sm text-ink-3 tabular-nums">
                              {t("history_measured_line", {
                                tokens: formatTokens(entry.total, locale),
                                machines: entry.machines,
                              })}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <FinalUsage entry={entry} t={t} locale={locale} />
                            <ChevronRightIcon className="text-ink-3 transition-colors group-hover:text-ink" />
                          </span>
                        </span>

                        {groups.length > 0 && (
                          <>
                            <span aria-hidden="true" className="mt-3 flex h-2 w-full gap-0.5">
                              {groups.map((group) => (
                                <span
                                  key={group.groupId}
                                  className="h-full min-w-0.5 rounded-[2px]"
                                  style={{
                                    flex: `${group.tokens} 1 0%`,
                                    backgroundColor: groupColors[group.groupId] ?? NEUTRAL_COLOR,
                                  }}
                                />
                              ))}
                            </span>
                            <span className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-2">
                              {groups.map((group) => (
                                <span key={group.groupId} className="flex min-w-0 items-center gap-1.5">
                                  <span
                                    aria-hidden="true"
                                    className="size-2 shrink-0 rounded-[2px]"
                                    style={{ backgroundColor: groupColors[group.groupId] ?? NEUTRAL_COLOR }}
                                  />
                                  <span className="wrap-anywhere">{group.groupId}</span>
                                  <span className="tabular-nums text-ink-3">
                                    {group.quotaShare === null
                                      ? formatPercent(group.share, locale)
                                      : t("history_group_shares", {
                                          quota: formatPercent(group.quotaShare, locale),
                                          share: formatPercent(group.share, locale),
                                        })}
                                  </span>
                                </span>
                              ))}
                            </span>
                          </>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

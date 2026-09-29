"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { ChevronRightIcon } from "@/components/icons";
import { Link } from "@/i18n/routing";
import { formatTokenTick, niceScale } from "@/lib/chart";
import type { CycleKind } from "@/lib/cycle-options";
import { formatCycleRange, formatHeroPercent, formatPercent, formatTokens } from "@/lib/format";
import type { CycleSummary } from "@/lib/history";
import type { Translator } from "@/lib/i18n";
import { NEUTRAL_COLOR } from "@/lib/settings";

/**
 * "Previous cycles": the archived cycles of the selected provider
 * (lib/history.ts), newest first, each a link to its own view (the full
 * dashboard while its reports are still kept, its summary after that). Above
 * them, once there are at least two to compare, a small column chart in
 * components/cycle-chart.tsx's visual language and keyboard pattern.
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
/** A column never grows wider than this: a handful of cycles must not turn into slabs. */
const MAX_BAR_WIDTH = 40;
/** Below this much room per column, only every other date label fits under the chart. */
const LABEL_ROOM = 52;

/** The groups of a cycle, heaviest first, with their share of it. */
function groupShares(entry: CycleSummary): { groupId: string; tokens: number; share: number }[] {
  const entries = Object.entries(entry.groups).filter(([, tokens]) => tokens > 0);
  const total = entries.reduce((sum, [, tokens]) => sum + tokens, 0);
  return entries
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([groupId, tokens]) => ({ groupId, tokens, share: total > 0 ? tokens / total : 0 }));
}

/** How much of the budget the cycle came to: the official figure, else the share of its token limit. */
function FinalUsage({ entry, t, locale }: { entry: CycleSummary; t: Translator<"Widgets">; locale: string }) {
  const limitShare = limitShareOf(entry);
  const [figure, note] =
    entry.official !== null
      ? [formatHeroPercent(entry.official / 100, locale), t("history_final_official")]
      : limitShare !== null
        ? [formatHeroPercent(limitShare / 100, locale), t("history_final_limit")]
        : ["–", t("history_final_unknown")];
  return (
    <span className="flex flex-col items-end text-right">
      <span className={`text-xl font-medium tabular-nums ${figure === "–" ? "text-ink-3" : "text-ink"}`}>{figure}</span>
      <span className="text-xs text-ink-3">{note}</span>
    </span>
  );
}

function HistoryChart({
  history,
  timeZone,
  t,
  locale,
}: {
  history: CycleSummary[];
  timeZone: string;
  t: Translator<"Widgets">;
  locale: string;
}) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [active, setActive] = useState<number | null>(null);
  // Only a crosshair moved by the keyboard is read out: a pointer would flood the screen reader.
  const [announce, setAnnounce] = useState(false);
  const hintId = useId();

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
    return `${rangeOf(chronological[index]!)}: ${value === null ? t("history_value_unknown") : formatValue(value)}`;
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
      <p className="text-sm text-ink-3">{t(`history_metric_note_${metric}`)}</p>
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
          {history.length >= 2 && <HistoryChart history={history} timeZone={timeZone} t={t} locale={locale} />}

          {/* biome-ignore lint/a11y/noRedundantRoles: Safari drops list semantics once list-style is none */}
          <ul role="list" className="mt-6 border-t border-hairline">
            {history.map((entry) => {
              const groups = groupShares(entry);
              const summaryOnly = kinds[entry.start] === "summary";
              const current = entry.start === selectedStartMs;
              return (
                <li key={entry.start} className="border-b border-hairline">
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
                              <span className="tabular-nums text-ink-3">{formatPercent(group.share, locale)}</span>
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
        </>
      )}
    </section>
  );
}

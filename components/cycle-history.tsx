"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { formatTokenTick, niceScale } from "@/lib/chart";
import type { DashboardModel } from "@/lib/dashboard";
import { formatDateTime, formatPercent, formatTokens } from "@/lib/format";
import type { CycleSummary } from "@/lib/history";
import { NEUTRAL_COLOR } from "@/lib/settings";

/**
 * "Previous cycles": a small column chart plus a compact table of the cycles
 * already archived for the selected provider (lib/history.ts). Matches
 * components/cycle-chart.tsx's visual language and keyboard/screen-reader
 * pattern, scaled down to bars instead of lines.
 */

type Metric = "official" | "limitShare" | "measured";

/**
 * What the bars show, decided once for the whole set: the official percentage
 * when any archived cycle has one (the most informative figure, when the
 * owner bothers to type it); otherwise the share of the token limit, while
 * any cycle was measured against one; otherwise the raw measured tokens. A
 * cycle missing that particular figure (settings changed over time) still
 * gets a row in the table, its bar just marked as not recorded.
 */
function pickMetric(history: CycleSummary[]): Metric {
  if (history.some((entry) => entry.official !== null)) return "official";
  if (history.some((entry) => entry.limit !== null)) return "limitShare";
  return "measured";
}

function metricValueOf(entry: CycleSummary, metric: Metric): number | null {
  if (metric === "official") return entry.official;
  if (metric === "limitShare") {
    return entry.limit !== null && entry.limit > 0 ? (entry.total / entry.limit) * 100 : null;
  }
  return entry.total;
}

const MIN_AXIS_TOKENS = 1_000;
const PAD_TOP = 18;
/** A cycle missing this chart's metric still gets a bar, this tall, so it reads as "not recorded" rather than as a gap. */
const UNKNOWN_BAR_HEIGHT = 4;

function CycleRangeCell({ entry, model, locale }: { entry: CycleSummary; model: DashboardModel; locale: string }) {
  return (
    <>
      {formatDateTime(entry.start, model.timeZone, locale)} – {formatDateTime(entry.end, model.timeZone, locale)}
    </>
  );
}

export function CycleHistory({ model, history }: { model: DashboardModel; history: CycleSummary[] }) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
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

  const colorOf = new Map(model.groups.map((group) => [group.groupId, group.color]));
  const rangeOf = (entry: CycleSummary) =>
    `${formatDateTime(entry.start, model.timeZone, locale)} – ${formatDateTime(entry.end, model.timeZone, locale)}`;

  if (history.length === 0) {
    return (
      <section aria-labelledby="history-heading">
        <h2 id="history-heading" className="text-xl font-medium">
          {t("history_heading")}
        </h2>
        <p className="mt-3 max-w-xl text-ink-2">{t("history_empty")}</p>
      </section>
    );
  }

  // The chart reads left to right, oldest to newest, like the main cycle chart; the table below stays newest first.
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

  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const count = chronological.length;
  const colWidth = count > 0 ? width / count : 0;
  const barWidth = Math.max(2, colWidth * 0.6);
  const yOf = (value: number) => PAD_TOP + (1 - Math.max(0, value) / scale.max) * (height - PAD_TOP);
  const xOf = (index: number) => index * colWidth + colWidth / 2;

  const readout = (index: number) => {
    const entry = chronological[index]!;
    const value = values[index]!;
    return `${rangeOf(entry)}: ${value === null ? t("history_value_unknown") : formatValue(value)}`;
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
    <section aria-labelledby="history-heading">
      <h2 id="history-heading" className="text-xl font-medium">
        {t("history_heading")}
      </h2>
      <p className="mt-1 text-sm text-ink-3">{t(`history_metric_note_${metric}`)}</p>

      <div className="mt-5">
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
          className="relative h-40 touch-pan-y select-none sm:h-48"
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
                const x = xOf(index) - barWidth / 2;
                const y = value === null ? height - UNKNOWN_BAR_HEIGHT : yOf(value);
                return (
                  <rect
                    key={entry.start}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(value === null ? UNKNOWN_BAR_HEIGHT : 0, height - y)}
                    rx={1.5}
                    fill={index === activeIndex ? "var(--color-ink)" : "var(--color-ink-3)"}
                    opacity={value === null ? 0.35 : 1}
                  />
                );
              })}
              {active !== null && (
                <line
                  x1={activeX}
                  x2={activeX}
                  y1={PAD_TOP}
                  y2={height}
                  stroke="var(--color-ink-3)"
                  strokeDasharray="2 3"
                />
              )}
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

        <details className="mt-2 text-sm">
          <summary className="w-fit cursor-pointer text-ink-3 transition-colors hover:text-ink">
            {t("as_table")}
          </summary>
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
                    <th scope="row" className="whitespace-nowrap py-2 pr-4 font-normal text-ink-2">
                      <CycleRangeCell entry={entry} model={model} locale={locale} />
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

      <table className="mt-5 w-full border-collapse text-left">
        <thead>
          <tr className="text-sm text-ink-3">
            <th scope="col" className="py-2 pr-4 font-normal">
              {t("history_cycle_column")}
            </th>
            <th scope="col" className="py-2 pl-4 text-right font-normal">
              {t("history_tokens_column")}
            </th>
            <th scope="col" className="py-2 pl-4 text-right font-normal">
              {t("history_official_column")}
            </th>
            <th scope="col" className="py-2 pl-4 font-normal">
              {t("history_groups_column")}
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {history.map((entry) => {
            const groupEntries = Object.entries(entry.groups)
              .filter(([, tokens]) => tokens > 0)
              .sort(([, a], [, b]) => b - a);
            const groupTotal = groupEntries.reduce((sum, [, tokens]) => sum + tokens, 0);
            const groupsText = groupEntries
              .map(
                ([groupId, tokens]) => `${groupId} ${formatPercent(groupTotal > 0 ? tokens / groupTotal : 0, locale)}`,
              )
              .join(", ");
            return (
              <tr key={entry.start} className="border-t border-hairline">
                <th scope="row" className="whitespace-nowrap py-3 pr-4 font-normal text-ink-2">
                  <CycleRangeCell entry={entry} model={model} locale={locale} />
                </th>
                <td className="py-3 pl-4 text-right">{formatTokens(entry.total, locale)}</td>
                <td className="py-3 pl-4 text-right">
                  {entry.official === null ? "–" : formatPercent(entry.official / 100, locale)}
                </td>
                <td className="py-3 pl-4">
                  {groupTotal > 0 ? (
                    <>
                      <span className="sr-only">{groupsText}</span>
                      <div aria-hidden="true" className="flex h-2.5 w-full max-w-40 gap-0.5">
                        {groupEntries.map(([groupId, tokens]) => (
                          <span
                            key={groupId}
                            className="h-full min-w-0.5 rounded-[2px]"
                            style={{ flex: `${tokens} 1 0%`, backgroundColor: colorOf.get(groupId) ?? NEUTRAL_COLOR }}
                          />
                        ))}
                      </div>
                    </>
                  ) : (
                    "–"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

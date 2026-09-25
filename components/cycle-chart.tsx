"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { CycleRuler } from "@/components/cycle-ruler";
import type { AxisScale } from "@/lib/chart";
import type { DashboardModel } from "@/lib/dashboard";
import { formatCycleMoment } from "@/lib/format";
import { useLocale } from "next-intl";

export interface ChartSeries {
  id: string;
  label: string;
  /** Stroke colour: a group's "#rrggbb", or a CSS value. */
  color: string;
  /** One value per sample of `model.timeline.times`. */
  values: number[];
  /** The aggregate line: dashed, so it never reads as one more group. */
  dashed?: boolean;
  /** A secondary line in a fainter shade: its end label takes its colour, and yields to the others. */
  faint?: boolean;
}

interface CycleChartProps {
  model: DashboardModel;
  /** In legend and tooltip order; drawn in reverse, so the first lies on top. */
  series: ChartSeries[];
  scale: AxisScale;
  formatTick: (value: number) => string;
  /** A value in the tooltip and the table. */
  formatValue: (value: number) => string;
  /** A value at a line's end, where room is short; `formatValue` when not given. */
  formatEndLabel?: (value: number) => string;
  /** What the chart shows: its accessible name and the table's caption. */
  label: string;
}

/** Room above the top gridline for its label. */
const PAD_TOP = 18;
/** Direct end labels need this much room right of the last sample. */
const END_LABEL_ROOM = 112;
const END_LABEL_GAP = 16;
const DASH = "6 5";

/** A short stroke in the series' colour: the key in the legend, the tooltip and the table. */
function LineKey({ series }: { series: ChartSeries }) {
    const locale = useLocale();
  return (
    <span
      aria-hidden="true"
      className="inline-block w-4 shrink-0 border-t-2"
      style={{ borderColor: series.color, borderTopStyle: series.dashed ? "dashed" : "solid" }}
    />
  );
}

export function ChartLegend({ series }: { series: ChartSeries[] }) {
    const locale = useLocale();
  return (
    <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm text-ink-2">
      {series.map((s) => (
        <li key={s.id} className="flex min-w-0 items-center gap-2">
          <LineKey series={s} />
          <span className="wrap-anywhere">{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** The sample nearest to the horizontal position `x`. */
function nearestIndex(xs: number[], x: number): number {
  let best = 0;
  for (let index = 1; index < xs.length; index++) {
    if (Math.abs(xs[index]! - x) < Math.abs(xs[best]! - x)) best = index;
  }
  return best;
}

/**
 * Usage over the cycle: time runs left to right across the whole cycle, as in
 * the meter above, and the lines stop at now. A crosshair (pointer, or the
 * arrow keys once focused) reads every series at one moment; the table under
 * the chart holds the same figures day by day.
 */
export function CycleChart({
  model,
  series,
  scale,
  formatTick,
  formatValue,
  formatEndLabel = formatValue,
  label,
}: CycleChartProps) {
    const locale = useLocale();
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

  const { times } = model.timeline;
  const last = times.length - 1;
  const { startMs, endMs } = model.cycle;
  const moment = (ms: number) => formatCycleMoment(ms, model.period, model.timeZone, locale);

  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const xOf = (ms: number) => ((ms - startMs) / (endMs - startMs)) * width;
  const yOf = (value: number) => PAD_TOP + (1 - value / scale.max) * (height - PAD_TOP);
  const xs = times.map(xOf);

  const pathOf = (values: number[]) =>
    values.map((value, index) => `${index === 0 ? "M" : "L"}${xs[index]!.toFixed(1)},${yOf(value).toFixed(1)}`).join("");

  // Values at the line ends, right of them where there is room; a label too close to one already placed is left to the legend and tooltip.
  const endX = xs[last] ?? 0;
  const endLabels: { series: ChartSeries; y: number }[] = [];
  if (size && width - endX >= END_LABEL_ROOM) {
    const byPriority = [...series].sort(
      (a, b) =>
        Number(Boolean(b.dashed)) - Number(Boolean(a.dashed)) ||
        Number(Boolean(a.faint)) - Number(Boolean(b.faint)) ||
        b.values[last]! - a.values[last]!,
    );
    for (const s of byPriority) {
      const y = yOf(s.values[last]!);
      if (endLabels.every((placed) => Math.abs(placed.y - y) >= END_LABEL_GAP)) endLabels.push({ series: s, y });
    }
  }

  const readout = (index: number) =>
    `${moment(times[index]!)}: ` + series.map((s) => `${s.label} ${formatValue(s.values[index]!)}`).join(", ");

  const pointAt = (clientX: number) => {
    const plot = plotRef.current;
    if (!plot || xs.length === 0) return;
    setAnnounce(false);
    setActive(nearestIndex(xs, clientX - plot.getBoundingClientRect().left));
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

  // One row per day that has ended, and one for now.
  const tableRows = [
    ...model.cycle.segments
      .map((segment) => startMs + segment.endFraction * (endMs - startMs))
      .filter((dayEnd) => dayEnd < times[last]!)
      .map((dayEnd) => times.findLastIndex((t) => t <= dayEnd)),
    last,
  ].filter((index, position, all) => index >= 0 && all.indexOf(index) === position);

  const activeX = active === null ? 0 : xs[active]!;
  // The tooltip opens towards the wider side and never past the chart's edge.
  const tipOnLeft = activeX > width / 2;
  const tipRoom = Math.max(0, (tipOnLeft ? activeX : width - activeX) - 12);

  return (
    <div>
      <div
        ref={plotRef}
        role="group"
        aria-label={label}
        aria-describedby={hintId}
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
        className="relative h-56 touch-pan-y select-none sm:h-64"
      >
        {size && (
          <svg width={width} height={height} aria-hidden="true" className="absolute inset-0 overflow-visible">
            {/* Day boundaries continue the ruler's ticks upwards. */}
            {model.cycle.segments.slice(1).map((segment) => {
              const x = Math.round(segment.startFraction * width) + 0.5;
              return (
                <line key={segment.startFraction} x1={x} x2={x} y1={PAD_TOP} y2={height} stroke="var(--color-hairline)" />
              );
            })}
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

            {[...series].reverse().map((s) => (
              <path
                key={s.id}
                d={pathOf(s.values)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.dashed ? DASH : undefined}
              />
            ))}

            {active !== null && (
              <line x1={activeX} x2={activeX} y1={PAD_TOP} y2={height} stroke="var(--color-ink-3)" />
            )}
            {/* The page-coloured ring keeps a dot legible where lines cross. */}
            {[...series].reverse().map((s) => {
              const index = active ?? last;
              return (
                <circle
                  key={s.id}
                  cx={xs[index]}
                  cy={yOf(s.values[index]!)}
                  r={4}
                  fill={s.color}
                  stroke="var(--color-page)"
                  strokeWidth={2}
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

        {active === null &&
          endLabels.map(({ series: s, y }) => (
            <span
              key={s.id}
              aria-hidden="true"
              className="absolute -translate-y-1/2 whitespace-nowrap text-sm font-medium text-ink tabular-nums"
              style={{ left: endX + 10, top: y, ...(s.faint && { color: s.color }) }}
            >
              {formatEndLabel(s.values[last]!)}
            </span>
          ))}

        {active !== null && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 z-10 rounded-md bg-raised px-3 py-2 text-sm shadow-lg ring-1 ring-white/10"
            style={{ maxWidth: tipRoom, ...(tipOnLeft ? { right: width - activeX + 12 } : { left: activeX + 12 }) }}
          >
            <p className="text-xs text-ink-3">{moment(times[active]!)}</p>
            <ul className="mt-1.5 space-y-1">
              {series.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <LineKey series={s} />
                  <strong className="shrink-0 font-medium text-ink tabular-nums">
                    {formatValue(s.values[active]!)}
                  </strong>
                  <span className="min-w-0 truncate text-ink-3">{s.label}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p id={hintId} className="sr-only">
          A nyilakkal lépkedhetsz az időben.
        </p>
        <p aria-live="polite" className="sr-only">
          {announce && active !== null ? readout(active) : ""}
        </p>
      </div>

      <CycleRuler model={model} />

      <details className="mt-2 text-sm">
        <summary className="w-fit cursor-pointer text-ink-3 transition-colors hover:text-ink">Táblázatként</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">{label}</caption>
            <thead>
              <tr className="text-ink-3">
                <th scope="col" className="py-2 pr-4 font-normal">
                  Időpont
                </th>
                {series.map((s) => (
                  <th key={s.id} scope="col" className="py-2 pl-4 text-right font-normal">
                    <span className="inline-flex items-center gap-2">
                      <LineKey series={s} />
                      {s.label}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {tableRows.map((index) => (
                <tr key={index} className="border-t border-hairline">
                  <th scope="row" className="whitespace-nowrap py-2 pr-4 font-normal text-ink-2">
                    {index === last ? `most (${moment(times[index]!)})` : moment(times[index]!)}
                  </th>
                  {series.map((s) => (
                    <td key={s.id} className="py-2 pl-4 text-right">
                      {formatValue(s.values[index]!)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

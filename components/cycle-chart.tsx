"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { CycleRuler } from "@/components/cycle-ruler";
import { QUIET_BUTTON } from "@/components/ui/classes";
import { Segmented } from "@/components/ui/segmented";
import {
  type AxisScale,
  clampWindow,
  MIN_ZOOM_MS,
  niceRange,
  niceScale,
  presetOf,
  presetWindow,
  type TimeSpan,
  tableSamples,
  visibleSamples,
  type ZoomPreset,
  zoomTicks,
} from "@/lib/chart";
import type { DashboardModel } from "@/lib/dashboard";
import { formatClock, formatCycleMoment } from "@/lib/format";

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
  /** The value axis never shrinks below this over the whole cycle; zoomed in, a tenth of it is the narrowest span. */
  minAxis: number;
  formatTick: (value: number, scale: AxisScale) => string;
  /** A value in the tooltip and the table. */
  formatValue: (value: number) => string;
  /** A value at a line's end, where room is short; `formatValue` when not given. */
  formatEndLabel?: (value: number) => string;
  /** What the chart shows: its accessible name and the table's caption. */
  label: string;
  /** Stretches drawn faded, under a veil: lines there are only an estimate (components/usage-chart.tsx). */
  paleSpans?: TimeSpan[];
}

/** Room above the top gridline for its label. */
const PAD_TOP = 18;
/** Direct end labels need this much room right of the last sample. */
const END_LABEL_ROOM = 112;
const END_LABEL_GAP = 16;
const DASH = "6 5";
/** A mouse drag narrower than this is a click, not a selection. */
const MIN_DRAG_PX = 8;
/** Room one time label on a zoomed axis needs ("szept. 29.", "21:00"). */
const TICK_ROOM_PX = 72;
/** The value axis's labels fill this much of the plot's right edge. */
const AXIS_LABEL_ROOM_PX = 48;
/** A reset label centred on a marker closer than this to the right edge would run into the value axis's labels. */
const RESET_LABEL_RIGHT_EDGE_PX = 64;
/** ... and closer than this to the left edge, out of the plot. */
const RESET_LABEL_LEFT_EDGE_PX = 32;

/** The zoomed axis's ticks for the plot's width. */
const ticksFor = (zoomWindow: TimeSpan, timeZone: string, width: number) =>
  zoomTicks(zoomWindow, timeZone, Math.max(2, Math.floor(width / TICK_ROOM_PX)));

/** A short stroke in the series' colour: the key in the legend, the tooltip and the table. */
export function LineKey({ series }: { series: Pick<ChartSeries, "color" | "dashed"> }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-4 shrink-0 border-t-2"
      style={{ borderColor: series.color, borderTopStyle: series.dashed ? "dashed" : "solid" }}
    />
  );
}

export function ChartLegend({ series }: { series: ChartSeries[] }) {
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

/** The position in `xs` nearest to the horizontal position `x`. */
function nearestPosition(xs: number[], x: number): number {
  let best = 0;
  for (let index = 1; index < xs.length; index++) {
    if (Math.abs(xs[index]! - x) < Math.abs(xs[best]! - x)) best = index;
  }
  return best;
}

/** Under a zoomed-in chart: its hours, and a local midnight by its date. */
function ZoomAxis({ zoomWindow, width, model }: { zoomWindow: TimeSpan; width: number; model: DashboardModel }) {
  const locale = useLocale();
  const day = new Intl.DateTimeFormat(locale, { timeZone: model.timeZone, month: "short", day: "numeric" });
  const xOf = (ms: number) => ((ms - zoomWindow.startMs) / (zoomWindow.endMs - zoomWindow.startMs)) * width;
  return (
    <div aria-hidden="true" className="relative mt-2 h-7">
      {ticksFor(zoomWindow, model.timeZone, width).map((tick) => {
        const x = xOf(tick.ms);
        const align = x < 24 ? "translate-x-0" : x > width - 24 ? "-translate-x-full" : "-translate-x-1/2";
        return (
          <div key={tick.ms} className="absolute top-0 h-full" style={{ left: x }}>
            <span className={`absolute left-0 top-0 h-2 w-px ${tick.midnight ? "bg-ink-3" : "bg-rule"}`} />
            <span
              className={`absolute left-0 top-2.5 whitespace-nowrap text-xs tabular-nums ${align} ${
                tick.midnight ? "text-ink-2" : "text-ink-3"
              }`}
            >
              {tick.midnight ? day.format(tick.ms) : formatClock(tick.ms, model.timeZone, locale)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Usage over the cycle: time runs left to right across the whole cycle, as in
 * the meter above, and the lines stop at now (at the end, for a finished
 * cycle). The buttons above zoom into the last day or three; on a desktop a
 * range can also be dragged out with the mouse. Zoomed in, every hour shows
 * and the value axis fits the lines in view. A crosshair (pointer, or the
 * arrow keys once focused) reads every series at one moment of the window;
 * the table under the chart holds the same figures for the window alone.
 * A keep reset of the cycle (lib/resets.ts) is marked with a labelled vertical
 * line: the lines start again from 0 there (lib/timeline.ts).
 */
export function CycleChart({
  model,
  series,
  minAxis,
  formatTick,
  formatValue,
  formatEndLabel = formatValue,
  label,
  paleSpans = [],
}: CycleChartProps) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const plotRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  /** A position in `inside`, not an index into the timeline. */
  const [active, setActive] = useState<number | null>(null);
  // Only a crosshair moved by the keyboard is read out: a pointer would flood the screen reader.
  const [announce, setAnnounce] = useState(false);
  const [zoomWindow, setZoomWindow] = useState<TimeSpan>(() => ({
    startMs: model.cycle.startMs,
    endMs: model.cycle.endMs,
  }));
  /** A mouse selection being dragged out, in plot pixels. */
  const [drag, setDrag] = useState<{ fromX: number; toX: number } | null>(null);
  const hintId = useId();
  const clipId = useId();
  const zoomName = useId();

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
  const cycle = { startMs: model.cycle.startMs, endMs: model.cycle.endMs };
  const lastMs = times[last] ?? cycle.startMs;
  const zoomed = zoomWindow.startMs !== cycle.startMs || zoomWindow.endMs !== cycle.endMs;
  const preset = presetOf(zoomWindow, cycle, lastMs);
  const moment = (ms: number) => formatCycleMoment(ms, model.period, model.timeZone, locale);

  const { inside, drawn } = visibleSamples(times, zoomWindow);
  const insideValues = series.flatMap((s) => inside.map((index) => s.values[index]!));
  const scale = zoomed
    ? niceRange(Math.min(...insideValues, Infinity), Math.max(...insideValues, 0), minAxis / 10)
    : niceScale(Math.max(0, ...series.flatMap((s) => s.values)), minAxis);

  const width = size?.width ?? 0;
  const height = size?.height ?? 0;
  const spanMs = zoomWindow.endMs - zoomWindow.startMs;
  const xOf = (ms: number) => ((ms - zoomWindow.startMs) / spanMs) * width;
  const msAt = (x: number) => zoomWindow.startMs + (x / width) * spanMs;
  const yOf = (value: number) => PAD_TOP + (1 - (value - scale.min) / (scale.max - scale.min)) * (height - PAD_TOP);
  const insideXs = inside.map((index) => xOf(times[index]!));
  const lastInside = inside[inside.length - 1];

  const pathOf = (values: number[]) =>
    drawn
      .map(
        (index, position) =>
          `${position === 0 ? "M" : "L"}${xOf(times[index]!).toFixed(1)},${yOf(values[index]!).toFixed(1)}`,
      )
      .join("");

  // The cycle's keep resets inside the window: every line restarts from 0 at each.
  const resetMarks = model.resets
    .filter((reset) => reset.kind === "keep" && reset.atMs >= zoomWindow.startMs && reset.atMs <= zoomWindow.endMs)
    .map((reset) => reset.atMs);

  // Values at the line ends, right of them where there is room; a label too close to one already placed is left to the legend and tooltip.
  const endX = lastInside === undefined ? 0 : xOf(times[lastInside]!);
  const endLabels: { series: ChartSeries; y: number }[] = [];
  if (size && lastInside === last && width - endX >= END_LABEL_ROOM) {
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

  const readout = (position: number) => {
    const index = inside[position]!;
    return `${moment(times[index]!)}: ${series.map((s) => `${s.label} ${formatValue(s.values[index]!)}`).join(", ")}`;
  };

  const plotX = (clientX: number) => {
    const plot = plotRef.current;
    return plot ? Math.min(width, Math.max(0, clientX - plot.getBoundingClientRect().left)) : 0;
  };

  const pointAt = (clientX: number) => {
    if (insideXs.length === 0) return;
    setAnnounce(false);
    setActive(nearestPosition(insideXs, plotX(clientX)));
  };

  const zoomTo = (next: TimeSpan) => {
    setZoomWindow(next);
    setActive(null);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const lastPosition = inside.length - 1;
    const current = active ?? lastPosition;
    const next =
      event.key === "ArrowLeft"
        ? Math.max(0, current - 1)
        : event.key === "ArrowRight"
          ? Math.min(lastPosition, current + 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? lastPosition
              : null;
    if (event.key === "Escape") setActive(null);
    if (next === null || lastPosition < 0) return;
    event.preventDefault();
    setAnnounce(true);
    setActive(next);
  };

  // The window's own rows: one per day that has ended in it and its last sample, or every sample of a short one.
  const dayEndsMs = model.cycle.segments.map(
    (segment) => cycle.startMs + segment.endFraction * (cycle.endMs - cycle.startMs),
  );
  const tableRows = tableSamples(times, inside, zoomWindow, dayEndsMs);

  const activeIndex = active === null ? undefined : inside[active];
  const activeX = activeIndex === undefined ? 0 : xOf(times[activeIndex]!);
  // The tooltip opens towards the wider side and never past the chart's edge.
  const tipOnLeft = activeX > width / 2;
  const tipRoom = Math.max(0, (tipOnLeft ? activeX : width - activeX) - 12);
  const dotIndex = activeIndex ?? lastInside;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <fieldset>
          <legend className="sr-only">{t("zoom_legend")}</legend>
          <Segmented
            name={zoomName}
            size="sm"
            // A dragged selection is none of the buttons: none of them is checked then.
            value={(preset ?? "") as ZoomPreset}
            onChange={(next) => zoomTo(presetWindow(next, cycle, lastMs))}
            options={[
              { value: "day", label: t("zoom_day") },
              { value: "threeDays", label: t("zoom_three_days") },
              { value: "cycle", label: t("zoom_cycle") },
            ]}
          />
        </fieldset>
        {zoomed && preset === null && (
          <button type="button" onClick={() => zoomTo(cycle)} className={`text-sm ${QUIET_BUTTON}`}>
            {t("zoom_reset")}
          </button>
        )}
        {/* Only where there is a mouse to drag with. */}
        <span className="hidden text-sm text-ink-3 [@media(pointer:fine)]:inline">{t("zoom_drag_hint")}</span>
      </div>

      <div
        ref={plotRef}
        role="group"
        aria-label={label}
        aria-describedby={hintId}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the plot is keyboard-operated (arrow keys move the crosshair)
        tabIndex={0}
        onPointerMove={(event) => {
          pointAt(event.clientX);
          if (drag) setDrag({ ...drag, toX: plotX(event.clientX) });
        }}
        onPointerDown={(event) => {
          pointAt(event.clientX);
          // Dragging out a range is for a mouse: on a touch screen the same gesture scrolls the page.
          if (event.pointerType !== "mouse" || event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const x = plotX(event.clientX);
          setDrag({ fromX: x, toX: x });
        }}
        onPointerUp={() => {
          if (drag && Math.abs(drag.toX - drag.fromX) >= MIN_DRAG_PX) {
            // Up to the last sample only: a stretch of the future has nothing to show yet.
            const reported = {
              startMs: cycle.startMs,
              endMs: Math.min(cycle.endMs, Math.max(lastMs, cycle.startMs + MIN_ZOOM_MS)),
            };
            zoomTo(clampWindow({ startMs: msAt(drag.fromX), endMs: msAt(drag.toX) }, reported));
          }
          setDrag(null);
        }}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => {
          if (!drag) setActive(null);
        }}
        onFocus={() => {
          setAnnounce(true);
          setActive((current) => current ?? (inside.length > 0 ? inside.length - 1 : null));
        }}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
        className={`relative h-56 touch-pan-y select-none sm:h-64 ${drag ? "cursor-col-resize" : "[@media(pointer:fine)]:cursor-crosshair"}`}
      >
        {size && (
          <svg width={width} height={height} aria-hidden="true" className="absolute inset-0 overflow-visible">
            <defs>
              {/* Lines run on to the window's edges and stop there. */}
              <clipPath id={clipId}>
                <rect x={0} y={0} width={width} height={height} />
              </clipPath>
            </defs>
            {/* Day boundaries continue the ruler's ticks upwards; zoomed in, the axis's own ticks do. */}
            {(zoomed
              ? ticksFor(zoomWindow, model.timeZone, width).map((tick) => xOf(tick.ms))
              : model.cycle.segments.slice(1).map((segment) => segment.startFraction * width)
            ).map((x) => (
              <line
                key={x}
                x1={Math.round(x) + 0.5}
                x2={Math.round(x) + 0.5}
                y1={PAD_TOP}
                y2={height}
                stroke="var(--color-hairline)"
              />
            ))}
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

            <g clipPath={`url(#${clipId})`}>
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
              {paleSpans.map((span) => (
                <rect
                  key={span.startMs}
                  data-pale=""
                  x={xOf(span.startMs)}
                  y={PAD_TOP}
                  width={Math.max(0, xOf(span.endMs) - xOf(span.startMs))}
                  height={Math.max(0, height - PAD_TOP)}
                  fill="var(--color-page)"
                  opacity={0.6}
                />
              ))}
            </g>
            {resetMarks.map((atMs) => (
              <line
                key={atMs}
                data-reset-marker=""
                x1={Math.round(xOf(atMs)) + 0.5}
                x2={Math.round(xOf(atMs)) + 0.5}
                y1={PAD_TOP}
                y2={height}
                stroke="var(--color-ink-3)"
                strokeDasharray="2 3"
              />
            ))}

            {drag && (
              <rect
                x={Math.min(drag.fromX, drag.toX)}
                y={PAD_TOP}
                width={Math.abs(drag.toX - drag.fromX)}
                height={height - PAD_TOP}
                fill="var(--color-ink)"
                opacity={0.08}
                stroke="var(--color-ink-3)"
                strokeDasharray="3 3"
              />
            )}

            {activeIndex !== undefined && (
              <line x1={activeX} x2={activeX} y1={PAD_TOP} y2={height} stroke="var(--color-ink-3)" />
            )}
            {/* The page-coloured ring keeps a dot legible where lines cross. */}
            {dotIndex !== undefined &&
              [...series]
                .reverse()
                .map((s) => (
                  <circle
                    key={s.id}
                    cx={xOf(times[dotIndex]!)}
                    cy={yOf(s.values[dotIndex]!)}
                    r={4}
                    fill={s.color}
                    stroke="var(--color-page)"
                    strokeWidth={2}
                  />
                ))}
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
              {formatTick(tick, scale)}
            </span>
          ))}

        {size &&
          resetMarks.map((atMs) => {
            const x = xOf(atMs);
            // Centred on its marker, except near an edge: left of the marker at the right one (and never over the
            // value axis's labels, which share its row), right of it at the left one.
            const nearRight = x > width - RESET_LABEL_RIGHT_EDGE_PX;
            const align = nearRight
              ? "-translate-x-full"
              : x < RESET_LABEL_LEFT_EDGE_PX
                ? "translate-x-0"
                : "-translate-x-1/2";
            return (
              <span
                key={atMs}
                aria-hidden="true"
                className={`absolute top-0 ${align} whitespace-nowrap rounded-sm bg-page px-1 text-xs leading-none text-ink-3`}
                style={{ left: nearRight ? Math.min(x, width - AXIS_LABEL_ROOM_PX) : x }}
              >
                {t("chart_reset_marker")}
              </span>
            );
          })}

        {activeIndex === undefined &&
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

        {activeIndex !== undefined && !drag && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute top-0 z-10 rounded-md bg-raised px-3 py-2 text-sm shadow-lg ring-1 ring-ink/10"
            style={{ maxWidth: tipRoom, ...(tipOnLeft ? { right: width - activeX + 12 } : { left: activeX + 12 }) }}
          >
            <p className="text-xs text-ink-3">{moment(times[activeIndex]!)}</p>
            <ul className="mt-1.5 space-y-1">
              {series.map((s) => (
                <li key={s.id} className="flex items-center gap-2">
                  <LineKey series={s} />
                  <strong className="shrink-0 font-medium text-ink tabular-nums">
                    {formatValue(s.values[activeIndex]!)}
                  </strong>
                  <span className="min-w-0 truncate text-ink-3">{s.label}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <p id={hintId} className="sr-only">
          {t("keyboard_hint")}
        </p>
        <p aria-live="polite" className="sr-only">
          {announce && active !== null && active < inside.length ? readout(active) : ""}
        </p>
      </div>

      {zoomed ? (
        <ZoomAxis zoomWindow={zoomWindow} width={width} model={model} />
      ) : (
        <CycleRuler model={model} span={{ elapsedFraction: model.cycle.elapsedFraction, days: model.cycle.segments }} />
      )}

      <details className="mt-2 text-sm">
        <summary className="w-fit cursor-pointer text-ink-3 transition-colors hover:text-ink">{t("as_table")}</summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">{label}</caption>
            <thead>
              <tr className="text-ink-3">
                <th scope="col" className="py-2 pr-4 font-normal">
                  {t("time_column")}
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
                    {index !== last
                      ? moment(times[index]!)
                      : model.closed
                        ? t("end_row", { moment: moment(times[index]!) })
                        : t("now_row", { moment: moment(times[index]!) })}
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

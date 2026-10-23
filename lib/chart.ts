/** Scales, tick text and the zoom window of the dashboard's line charts. Pure. */

export interface AxisScale {
  /** Bottom of the axis: 0, or a whole number of steps below the data when zoomed in. */
  min: number;
  /** Top of the axis: a whole number of steps, at least the data's maximum. */
  max: number;
  step: number;
  /** min, min + step … max */
  ticks: number[];
}

/** A round step (1, 2, 2.5 or 5 × a power of ten) near `rough`. */
function niceStep(rough: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  return (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
}

function ticksOf(min: number, step: number, count: number): number[] {
  // Rounded to the step's own precision: 0.1 + 0.2 must not print as 0.30000000000000004.
  return Array.from({ length: count + 1 }, (_, index) => Number((min + index * step).toPrecision(12)));
}

/** From 0, a round step giving about four intervals up to `maxValue`. */
export function niceScale(maxValue: number, minMax: number): AxisScale {
  const top = Math.max(maxValue, minMax);
  const step = niceStep(top / 4);
  const count = Math.ceil(top / step - 1e-9);
  return { min: 0, max: count * step, step, ticks: ticksOf(0, step, count) };
}

/**
 * About four round intervals around `low`…`high`, for a zoomed-in window:
 * cumulative lines that barely move over a day would lie flat on a scale
 * from 0. Never below 0, and never narrower than `minSpan`.
 */
export function niceRange(low: number, high: number, minSpan: number): AxisScale {
  const span = Math.max(high - low, minSpan);
  const step = niceStep(span / 4);
  const min = Math.max(0, Math.floor(low / step + 1e-9) * step);
  const count = Math.max(1, Math.ceil((Math.max(high, min + minSpan) - min) / step - 1e-9));
  return { min, max: min + count * step, step, ticks: ticksOf(min, step, count) };
}

// One formatter per (locale, fraction-digit) pair: built once, reused on every tick redraw.
const percentFormatters = new Map<string, Intl.NumberFormat>();

function percentFormatter(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}:${digits}`;
  let formatter = percentFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: digits });
    percentFormatters.set(key, formatter);
  }
  return formatter;
}

/** A fraction tick: "25%", or "2,5%" where the step needs the decimal. */
export function formatPercentTick(fraction: number, step: number, locale: string): string {
  const stepPercent = step * 100;
  const digits = Math.abs(stepPercent - Math.round(stepPercent)) < 1e-9 ? 0 : 1;
  return percentFormatter(locale, digits).format(fraction);
}

// One compact-notation formatter per locale.
const tokenFormatters = new Map<string, Intl.NumberFormat>();

function tokenFormatter(locale: string): Intl.NumberFormat {
  let formatter = tokenFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
    tokenFormatters.set(locale, formatter);
  }
  return formatter;
}

/** A token tick in compact notation: "250K"/"1.2M" (en), "250 E"/"1,2 M" (hu). */
export function formatTokenTick(tokens: number, locale: string): string {
  return tokenFormatter(locale).format(tokens);
}

// ── The zoom window ──────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface TimeSpan {
  startMs: number;
  endMs: number;
}

/** The window buttons: the last day, the last three days, the whole cycle. */
export type ZoomPreset = "day" | "threeDays" | "cycle";
export const ZOOM_PRESETS: readonly ZoomPreset[] = ["day", "threeDays", "cycle"];

/** A window is never narrower than this: the samples are an hour apart. */
export const MIN_ZOOM_MS = 2 * HOUR;
/** A chart draws at most about this many samples, however wide its window. */
export const MAX_CHART_POINTS = 200;
/** Up to this wide a window, the chart's table lists every sample instead of one row a day. */
const HOURLY_TABLE_MS = 3 * DAY;

/** `window` put inside the cycle, the right way round, and at least `MIN_ZOOM_MS` wide. */
export function clampWindow(window: TimeSpan, cycle: TimeSpan): TimeSpan {
  const length = Math.min(MIN_ZOOM_MS, cycle.endMs - cycle.startMs);
  let startMs = Math.max(cycle.startMs, Math.min(window.startMs, window.endMs));
  let endMs = Math.min(cycle.endMs, Math.max(window.startMs, window.endMs));
  if (endMs - startMs < length) {
    const middle = (startMs + endMs) / 2;
    startMs = Math.max(cycle.startMs, Math.min(cycle.endMs - length, middle - length / 2));
    endMs = startMs + length;
  }
  return { startMs, endMs };
}

/**
 * The window a button shows. A day or three up to the last sample (now, or
 * the end of a finished cycle); early in a cycle, when there is less than
 * that behind it, the first day or three of the cycle instead.
 */
export function presetWindow(preset: ZoomPreset, cycle: TimeSpan, lastMs: number): TimeSpan {
  if (preset === "cycle") return { ...cycle };
  const length = preset === "day" ? DAY : 3 * DAY;
  const endMs = Math.max(Math.min(lastMs, cycle.endMs), Math.min(cycle.endMs, cycle.startMs + length));
  return clampWindow({ startMs: endMs - length, endMs }, cycle);
}

/** The button whose window this is, if any: a dragged selection is none of them. */
export function presetOf(window: TimeSpan, cycle: TimeSpan, lastMs: number): ZoomPreset | null {
  return (
    ZOOM_PRESETS.find((preset) => {
      const candidate = presetWindow(preset, cycle, lastMs);
      return candidate.startMs === window.startMs && candidate.endMs === window.endMs;
    }) ?? null
  );
}

export interface VisibleSamples {
  /** The samples inside the window, thinned out to about `maxPoints`, the window's last one always kept, and the ones asked to keep: the crosshair, the keys and the table step through these. */
  inside: number[];
  /** `inside`, plus the nearest sample beyond each edge: the lines run on to the edges and are clipped there. */
  drawn: number[];
}

/**
 * Which of `times` (sample times, ascending) a chart shows for `window`;
 * indices into `times`. The samples at `keepMs` that fall inside the window
 * are kept however far the rest is thinned: the two around a reset, so that
 * the drop there is not drawn as a slope.
 */
export function visibleSamples(
  times: number[],
  window: TimeSpan,
  maxPoints: number = MAX_CHART_POINTS,
  keepMs: number[] = [],
): VisibleSamples {
  const within: number[] = [];
  times.forEach((t, index) => {
    if (t >= window.startMs && t <= window.endMs) within.push(index);
  });
  const stride = Math.max(1, Math.ceil(within.length / maxPoints));
  const lastPosition = within.length - 1;
  const kept = new Set(keepMs);
  const inside = within.filter(
    (index, position) => (lastPosition - position) % stride === 0 || kept.has(times[index]!),
  );

  const before = times.findLastIndex((t) => t < window.startMs);
  const after = times.findIndex((t) => t > window.endMs);
  const drawn = [...(before >= 0 ? [before] : []), ...inside, ...(after >= 0 ? [after] : [])];
  return { inside, drawn };
}

/**
 * The chart table's rows, as indices into `times`: every visible sample for
 * a window of up to three days; otherwise the last sample of each day that
 * ends inside the window (`dayEndsMs`), and the window's last one.
 */
export function tableSamples(times: number[], inside: number[], window: TimeSpan, dayEndsMs: number[]): number[] {
  if (inside.length === 0) return [];
  if (window.endMs - window.startMs <= HOURLY_TABLE_MS) return inside;
  const lastInside = inside[inside.length - 1]!;
  const rows = dayEndsMs
    .filter((dayEnd) => dayEnd > window.startMs && dayEnd < times[lastInside]!)
    .map((dayEnd) => times.findLastIndex((t) => t <= dayEnd))
    .filter((index) => index >= 0 && times[index]! >= window.startMs);
  return [...new Set([...rows, lastInside])];
}

// Local wall-clock readings, one formatter per time zone.
const hourFormatters = new Map<string, Intl.DateTimeFormat>();

function localHourMinute(ms: number, timeZone: string): { hour: number; minute: number } {
  let formatter = hourFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" });
    hourFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(ms).map((part) => [part.type, part.value]));
  return { hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

export interface TimeTick {
  ms: number;
  /** A local midnight: labelled with its date rather than its time. */
  midnight: boolean;
}

/**
 * The time axis of a zoomed-in window: whole local hours every 1, 2, 3, 6 or
 * 12 hours, the first step that keeps it to `maxTicks`, or local midnights
 * only (every few of them over a long window). Follows the time zone's own
 * clock, across a DST change too.
 */
export function zoomTicks(window: TimeSpan, timeZone: string, maxTicks = 8): TimeTick[] {
  // Every whole local hour in the window; the half-hour grid catches the zones offset by 30 minutes.
  const half = HOUR / 2;
  const hours: { ms: number; hour: number }[] = [];
  for (let ms = Math.ceil(window.startMs / half) * half; ms <= window.endMs; ms += half) {
    const { hour, minute } = localHourMinute(ms, timeZone);
    if (minute === 0) hours.push({ ms, hour });
  }

  for (const step of [1, 2, 3, 6, 12]) {
    const ticks = hours.filter(({ hour }) => hour % step === 0);
    if (ticks.length <= maxTicks) return ticks.map(({ ms, hour }) => ({ ms, midnight: hour === 0 }));
  }
  const midnights = hours.filter(({ hour }) => hour === 0);
  const every = Math.max(1, Math.ceil(midnights.length / maxTicks));
  return midnights.filter((_, index) => index % every === 0).map(({ ms }) => ({ ms, midnight: true }));
}

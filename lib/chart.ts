/** Scales and tick text for the dashboard's line charts. Pure. */

export interface AxisScale {
  /** Top of the axis: a whole number of steps, at least the data's maximum. */
  max: number;
  step: number;
  /** 0, step, 2·step … max */
  ticks: number[];
}

/** A round step (1, 2, 2.5 or 5 × a power of ten) giving about four intervals up to `maxValue`. */
export function niceScale(maxValue: number, minMax: number): AxisScale {
  const top = Math.max(maxValue, minMax);
  const rough = top / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  const count = Math.ceil(top / step - 1e-9);
  return { max: count * step, step, ticks: Array.from({ length: count + 1 }, (_, index) => index * step) };
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

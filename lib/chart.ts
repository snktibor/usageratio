/** Scales and tick text for the dashboard's line charts. Pure. */

const LOCALE = "hu-HU";

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
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  const count = Math.ceil(top / step - 1e-9);
  return { max: count * step, step, ticks: Array.from({ length: count + 1 }, (_, index) => index * step) };
}

/** A fraction tick: "25%", or "2,5%" where the step needs the decimal. */
export function formatPercentTick(fraction: number, step: number): string {
  const stepPercent = step * 100;
  const digits = Math.abs(stepPercent - Math.round(stepPercent)) < 1e-9 ? 0 : 1;
  return new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: digits }).format(fraction);
}

const compact = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 });

/** A token tick: "250 E", "1,2 M". */
export function formatTokenTick(tokens: number): string {
  return compact.format(tokens);
}

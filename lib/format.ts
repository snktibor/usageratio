/**
 * Display formatting. Times are always given in the reset time zone,
 * never the viewer's own, so the server and the browser render the same text.
 */

import type { BudgetPeriod } from "@/lib/config";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 312480 → "312 480" */
export function formatTokens(value: number, locale: string): string {
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return integer.format(Math.round(value));
}

/** 0.625 → "62,5%"; tiny non-zero values → "<0,1%" */
export function formatPercent(fraction: number, locale: string): string {
  if (fraction > 0 && fraction < 0.001) {
    const isHu = locale.startsWith("hu");
    return isHu ? "<0,1%" : "<0.1%";
  }
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: fraction < 0.1 || (fraction > 0.995 && fraction < 1) ? 1 : 0,
  }).format(fraction);
}

/** A share of the limit, as formatPercent; "–" when there is no limit to take a share of. */
export function formatLimitShare(fraction: number | null, locale: string): string {
  return fraction === null ? "–" : formatPercent(fraction, locale);
}

/** Same as formatPercent, but always with one decimal for the hero figure below 100%. */
export function formatHeroPercent(fraction: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: fraction < 1 ? 1 : 0,
    maximumFractionDigits: fraction < 1 ? 1 : 0,
  }).format(fraction);
}

/** 2.5 → "2,5×"; the ratio of the official figure to the measured one. */
export function formatFactor(factor: number, locale: string): string {
  const digits = factor < 10 ? 2 : factor < 100 ? 1 : 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(factor)}×`;
}

export function weekdayShort(weekday: number, locale: string): string {
  const date = new Date(Date.UTC(2023, 9, 1 + weekday));
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(date);
}

export function weekdayLong(weekday: number, locale: string): string {
  const date = new Date(Date.UTC(2023, 9, 1 + weekday));
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "long" }).format(date);
}

function zoned(ms: number, timeZone: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, { timeZone, hourCycle: "h23", ...options }).format(ms);
}

/** "14:05" */
export function formatClock(ms: number, timeZone: string, locale: string): string {
  return zoned(ms, timeZone, locale, { hour: "2-digit", minute: "2-digit" });
}

/** "péntek 14:05" */
export function formatWeekdayTime(ms: number, timeZone: string, locale: string): string {
  // To format a weekday and time in a specific timezone correctly
  return zoned(ms, timeZone, locale, { weekday: "long", hour: "2-digit", minute: "2-digit" });
}

/** "szept. 21. 00:00" */
export function formatDateTime(ms: number, timeZone: string, locale: string): string {
  return zoned(ms, timeZone, locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "2026. szept. 21. 14:05:09": a moment worth pinning down to the second, such as an audit entry. */
export function formatTimestamp(ms: number, timeZone: string, locale: string): string {
  return zoned(ms, timeZone, locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** A moment inside a cycle: a weekday pins it down in a week, only a date does in a month. */
export function formatCycleMoment(ms: number, period: BudgetPeriod, timeZone: string, locale: string): string {
  return period === "monthly" ? formatDateTime(ms, timeZone, locale) : formatWeekdayTime(ms, timeZone, locale);
}

/** Remaining time, two largest units: "4 nap 9 óra", "9 óra 12 perc", "12 perc". */
export function formatDuration(ms: number, locale: string): string {
  const total = Math.max(0, ms);
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);

  const df = new Intl.NumberFormat(locale, { style: "unit", unit: "day", unitDisplay: "long", maximumFractionDigits: 0 });
  const hf = new Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "long", maximumFractionDigits: 0 });
  const mf = new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "long", maximumFractionDigits: 0 });

  if (days > 0) return hours > 0 ? `${df.format(days)} ${hf.format(hours)}` : df.format(days);
  if (hours > 0) return minutes > 0 ? `${hf.format(hours)} ${mf.format(minutes)}` : hf.format(hours);
  return mf.format(Math.max(1, minutes));
}

/** Age of a report: "most", "12 perce", "3 órája", "2 napja". `nowLabel` is the caller's translated "now" string. */
export function formatAgo(ms: number, now: number, locale: string, nowLabel: string): string {
  const age = Math.max(0, now - ms);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "long" });

  if (age < MINUTE) {
    return nowLabel;
  }
  if (age < HOUR) return rtf.format(-Math.floor(age / MINUTE), "minute");
  if (age < 2 * DAY) return rtf.format(-Math.floor(age / HOUR), "hour");
  return rtf.format(-Math.floor(age / DAY), "day");
}

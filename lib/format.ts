/**
 * Hungarian display formatting. Times are always given in the reset time zone,
 * never the viewer's own, so the server and the browser render the same text.
 */

import type { BudgetPeriod } from "@/lib/config";

const LOCALE = "hu-HU";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WEEKDAYS_SHORT = ["V", "H", "K", "Sze", "Cs", "P", "Szo"] as const;
const WEEKDAYS_LONG = [
  "vasárnap",
  "hétfő",
  "kedd",
  "szerda",
  "csütörtök",
  "péntek",
  "szombat",
] as const;

const integer = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });

/** 312480 → "312 480" */
export function formatTokens(value: number): string {
  return integer.format(Math.round(value));
}

/** 0.625 → "62,5%"; tiny non-zero values → "<0,1%" */
export function formatPercent(fraction: number): string {
  if (fraction > 0 && fraction < 0.001) return "<0,1%";
  return new Intl.NumberFormat(LOCALE, {
    style: "percent",
    maximumFractionDigits: fraction < 0.1 || (fraction > 0.995 && fraction < 1) ? 1 : 0,
  }).format(fraction);
}

/** Same as formatPercent, but always with one decimal for the hero figure below 100%. */
export function formatHeroPercent(fraction: number): string {
  return new Intl.NumberFormat(LOCALE, {
    style: "percent",
    minimumFractionDigits: fraction < 1 ? 1 : 0,
    maximumFractionDigits: fraction < 1 ? 1 : 0,
  }).format(fraction);
}

/** 2.5 → "2,5×"; the ratio of the official figure to the measured one. */
export function formatFactor(factor: number): string {
  const digits = factor < 10 ? 2 : factor < 100 ? 1 : 0;
  return `${new Intl.NumberFormat(LOCALE, { maximumFractionDigits: digits }).format(factor)}×`;
}

/** "heti" / "havi", as in "a heti keret". */
export function periodAdjective(period: BudgetPeriod): string {
  return period === "monthly" ? "havi" : "heti";
}

export function weekdayShort(weekday: number): string {
  return WEEKDAYS_SHORT[weekday] ?? "";
}

export function weekdayLong(weekday: number): string {
  return WEEKDAYS_LONG[weekday] ?? "";
}

function zoned(ms: number, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hourCycle: "h23", ...options }).format(ms);
}

function weekdayIndex(ms: number, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(ms);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(name);
}

/** "14:05" */
export function formatClock(ms: number, timeZone: string): string {
  return zoned(ms, timeZone, { hour: "2-digit", minute: "2-digit" });
}

/** "péntek 14:05" */
export function formatWeekdayTime(ms: number, timeZone: string): string {
  return `${WEEKDAYS_LONG[weekdayIndex(ms, timeZone)] ?? ""} ${formatClock(ms, timeZone)}`;
}

/** "szept. 21. 00:00" */
export function formatDateTime(ms: number, timeZone: string): string {
  return zoned(ms, timeZone, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Remaining time, two largest units: "4 nap 9 óra", "9 óra 12 perc", "12 perc". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, ms);
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  const minutes = Math.floor((total % HOUR) / MINUTE);
  if (days > 0) return hours > 0 ? `${days} nap ${hours} óra` : `${days} nap`;
  if (hours > 0) return minutes > 0 ? `${hours} óra ${minutes} perc` : `${hours} óra`;
  return `${Math.max(1, minutes)} perc`;
}

/** Age of a report: "most", "12 perce", "3 órája", "2 napja". */
export function formatAgo(ms: number, now: number): string {
  const age = Math.max(0, now - ms);
  if (age < MINUTE) return "most";
  if (age < HOUR) return `${Math.floor(age / MINUTE)} perce`;
  if (age < 2 * DAY) return `${Math.floor(age / HOUR)} órája`;
  return `${Math.floor(age / DAY)} napja`;
}

/** Which weekday a locale's week starts on, and the display order that follows from it. Pure. */

interface LocaleWeekInfo {
  /** CLDR: 1..7 = Monday..Sunday. */
  firstDay: number;
}

/** `Intl.Locale`'s week-info surface: a method in some engines, a plain getter in others. */
interface LocaleWithWeekInfo {
  getWeekInfo?: () => LocaleWeekInfo;
  weekInfo?: LocaleWeekInfo;
}

/**
 * The locale's first weekday, JS-style: 0..6 = Sunday..Saturday. Falls back to
 * Monday (1) for a locale with no week data, or one `Intl.Locale` rejects.
 */
export function firstDayOfWeek(locale: string): number {
  try {
    const maximized = new Intl.Locale(locale).maximize() as Intl.Locale & LocaleWithWeekInfo;
    const info = maximized.getWeekInfo?.() ?? maximized.weekInfo;
    const firstDay = info?.firstDay;
    // CLDR's 1..7 (Mon..Sun) maps onto JS's 0..6 (Sun..Sat) by taking it mod 7.
    if (typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7) return firstDay % 7;
  } catch {
    // Not a locale `Intl.Locale` recognizes: fall through to Monday.
  }
  return 1;
}

/** [0..6], rotated to start on the locale's first weekday. */
export function weekdayOrder(locale: string): number[] {
  const first = firstDayOfWeek(locale);
  return Array.from({ length: 7 }, (_, index) => (first + index) % 7);
}

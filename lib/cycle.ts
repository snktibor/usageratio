import type { ResetConfig } from "@/lib/config";

/** A weekly usage cycle: `start` inclusive, `end` exclusive. */
export interface Cycle {
  start: Date;
  end: Date;
}

/** One calendar day (or part of one) inside a cycle, in the reset time zone. */
export interface DaySegment {
  start: Date;
  end: Date;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** The wall-clock reading of `date` in `timeZone`. */
function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fields: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    fields[part.type] = part.value;
  }
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour) % 24,
    minute: Number(fields.minute),
    second: Number(fields.second),
    weekday: WEEKDAY_INDEX[fields.weekday ?? ""] ?? 0,
  };
}

/** Offset of `timeZone` from UTC at the given instant, in milliseconds. */
function offsetAt(instantMs: number, timeZone: string): number {
  const p = zonedParts(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant at which clocks in `timeZone` show the given wall time.
 * `day` may under/overflow the month (handled like `Date.UTC`). A wall time
 * skipped by a DST jump resolves to the hour after it; an ambiguous one to
 * its later occurrence.
 */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = wallAsUtc - offsetAt(wallAsUtc, timeZone);
  // The offset may differ at the corrected instant (we crossed a DST edge).
  return new Date(wallAsUtc - offsetAt(firstGuess, timeZone));
}

/** The weekly cycle that contains `now`. */
export function getCycle(now: Date, reset: ResetConfig): Cycle {
  const { timeZone, weekday, hour, minute } = reset;
  const today = zonedParts(now, timeZone);
  const daysSinceResetDay = (today.weekday - weekday + 7) % 7;

  const resetOn = (dayOffset: number): Date =>
    zonedTimeToUtc(today.year, today.month, today.day + dayOffset, hour, minute, timeZone);

  let dayOffset = -daysSinceResetDay;
  // It is the reset weekday but the reset time has not come yet.
  if (resetOn(dayOffset).getTime() > now.getTime()) dayOffset -= 7;
  // Only reachable when a DST shift moved the reset instant under `now`.
  if (resetOn(dayOffset + 7).getTime() <= now.getTime()) dayOffset += 7;

  return { start: resetOn(dayOffset), end: resetOn(dayOffset + 7) };
}

/** The cycle right before `cycle`. */
export function getPreviousCycle(cycle: Cycle, reset: ResetConfig): Cycle {
  return getCycle(new Date(cycle.start.getTime() - 1), reset);
}

/** Splits a cycle at every local midnight, for the day ruler under the meter. */
export function getDaySegments(cycle: Cycle, timeZone: string): DaySegment[] {
  const segments: DaySegment[] = [];
  const first = zonedParts(cycle.start, timeZone);
  let cursor = cycle.start;

  // A cycle touches at most 8 calendar days; 10 is a safety bound.
  for (let i = 1; i <= 10 && cursor.getTime() < cycle.end.getTime(); i += 1) {
    const nextMidnight = zonedTimeToUtc(first.year, first.month, first.day + i, 0, 0, timeZone);
    if (nextMidnight.getTime() <= cursor.getTime()) continue;
    const end = nextMidnight.getTime() < cycle.end.getTime() ? nextMidnight : cycle.end;
    segments.push({ start: cursor, end, weekday: zonedParts(cursor, timeZone).weekday });
    cursor = end;
  }
  return segments;
}

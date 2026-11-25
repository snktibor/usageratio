/**
 * A provider's own 5-hour window (Claude's rolling limit), as a client read it
 * on its machine and sent along with its weekly figure (POST
 * /api/official-usage/report, lib/official-report.ts), and what the dashboard
 * makes of it. Pure: the Redis side is in lib/usage-store.ts.
 *
 * Only the newest reading of each provider is kept (`usage:fivehour`). It says
 * nothing about the cycle: it is shown beside it, under the weekly figure, and
 * once its window has reset it only says that none is running.
 */

const MINUTE_MS = 60_000;
export const FIVE_HOUR_MS = 5 * 60 * MINUTE_MS;
/** Before this much of the window, a pace would be a guess from a single request. */
export const FIVE_HOUR_PACE_AFTER_MS = 15 * MINUTE_MS;
/** A window's reset may sit a little past five hours after a reading's clock. */
const RESET_TOLERANCE_MS = 15 * MINUTE_MS;
const MAX_PERCENT = 1000;

/** The window as a report sends it: how much is used, and when it resets (epoch ms). */
export interface FiveHourWindow {
  usedPercent: number;
  resetsAtMs: number;
}

/** A stored reading: the window, and when the client read it. */
export interface FiveHourReading extends FiveHourWindow {
  observedAtMs: number;
}

/**
 * A report's `fiveHour`, or null when it has none or one that does not hold up
 * (out of range, or a window that had already reset when it was read): the
 * weekly figure beside it must not be refused for it.
 */
export function parseFiveHourWindow(value: unknown, observedAtMs: number): FiveHourWindow | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { usedPercent, resetsAtMs } = value as Record<string, unknown>;
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
  if (usedPercent < 0 || usedPercent > MAX_PERCENT) return null;
  if (typeof resetsAtMs !== "number" || !Number.isSafeInteger(resetsAtMs)) return null;
  const ahead = resetsAtMs - observedAtMs;
  if (ahead <= 0 || ahead > FIVE_HOUR_MS + RESET_TOLERANCE_MS) return null;
  return { usedPercent, resetsAtMs };
}

/** The `usage:fivehour` field's value. */
export function serializeFiveHour(reading: FiveHourReading): string {
  return JSON.stringify({ p: reading.usedPercent, r: reading.resetsAtMs, o: reading.observedAtMs });
}

/** A stored value read back; null when it does not hold up. */
export function parseStoredFiveHour(raw: string): FiveHourReading | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { p, r, o } = parsed as Record<string, unknown>;
  const isTime = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (typeof p !== "number" || !Number.isFinite(p) || !isTime(r) || !isTime(o)) return null;
  return { usedPercent: p, resetsAtMs: r, observedAtMs: o };
}

/** providerId → its reading, from the whole hash; fields that do not hold up are left out. */
export function fiveHourReadings(raw: Record<string, string>): Record<string, FiveHourReading> {
  return Object.fromEntries(
    Object.entries(raw).flatMap(([providerId, value]) => {
      const reading = parseStoredFiveHour(value);
      return reading ? [[providerId, reading]] : [];
    }),
  );
}

export type FiveHourOutlook =
  /** The window is over and no reading since tells of a new one. */
  | { kind: "idle" }
  /** Too little of the window has gone by for a pace. */
  | { kind: "too_early" }
  | { kind: "lasts" }
  | { kind: "runs_out"; atMs: number }
  | { kind: "used_up" };

export interface FiveHourView {
  /** Used, 0–1 (more past the limit); 0 while idle. */
  usedFraction: number;
  /** Of the window gone by, 0–1; 0 while idle. */
  elapsedFraction: number;
  /** Null while idle. */
  resetsAtMs: number | null;
  observedAtMs: number;
  outlook: FiveHourOutlook;
  /** Where the pace runs out along the bar, 0–1; null when it does not before the reset. */
  runOutFraction: number | null;
}

/**
 * The window as of `nowMs`. The pace is the window's average so far, carried
 * on in a straight line: at that rate, the moment it reaches 100%.
 */
export function fiveHourView(reading: FiveHourReading, nowMs: number): FiveHourView {
  const { usedPercent, resetsAtMs, observedAtMs } = reading;
  if (resetsAtMs <= nowMs) {
    return {
      usedFraction: 0,
      elapsedFraction: 0,
      resetsAtMs: null,
      observedAtMs,
      outlook: { kind: "idle" },
      runOutFraction: null,
    };
  }
  const startMs = resetsAtMs - FIVE_HOUR_MS;
  // The pace is the reading's: how much was used by the time it was read.
  const goneAtReading = Math.max(0, observedAtMs - startMs);
  const used = Math.max(0, usedPercent);
  let outlook: FiveHourOutlook;
  if (used >= 100) outlook = { kind: "used_up" };
  else if (goneAtReading < FIVE_HOUR_PACE_AFTER_MS) outlook = { kind: "too_early" };
  else if (used === 0) outlook = { kind: "lasts" };
  else {
    const atMs = Math.round(startMs + (goneAtReading * 100) / used);
    outlook = atMs < resetsAtMs ? { kind: "runs_out", atMs } : { kind: "lasts" };
  }
  const fractionAt = (ms: number) => Math.min(1, Math.max(0, (ms - startMs) / FIVE_HOUR_MS));
  return {
    usedFraction: used / 100,
    elapsedFraction: fractionAt(nowMs),
    resetsAtMs,
    observedAtMs,
    outlook,
    runOutFraction: outlook.kind === "runs_out" ? fractionAt(outlook.atMs) : null,
  };
}

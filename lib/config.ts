/**
 * Central configuration. Edit the constants below (and redeploy), or override
 * them per environment with the env vars named next to each one.
 */

/**
 * Weekly token budget the global progress bar is measured against.
 * Optional env override: WEEKLY_LIMIT
 */
export const WEEKLY_LIMIT = 500_000;

/**
 * When the weekly cycle restarts, as wall-clock time in `timeZone`
 * (DST-aware). Only reports since the most recent reset are shown.
 * Optional env overrides: RESET_WEEKDAY (0 = Sunday … 6 = Saturday),
 * RESET_TIME ("HH:MM", 24h) and RESET_TIMEZONE (IANA name).
 */
export const WEEKLY_RESET: ResetConfig = {
  weekday: 1, // Monday
  hour: 0,
  minute: 0,
  timeZone: "Europe/Budapest",
};

/**
 * How the `tokens` field of a report is interpreted. Reports are stored raw,
 * so this can be changed at any time and the dashboard re-reads history
 * under the new rule.
 *
 * - "delta":    tokens used since the previous report. The dashboard adds
 *               the reports of the cycle up.
 * - "snapshot": the machine's running total for the current cycle. The
 *               dashboard takes the latest report of the cycle.
 * - "counter":  an ever-growing odometer. The dashboard adds up the increases
 *               between consecutive reports (a drop counts as a restart).
 *
 * Optional env override: TOKEN_MODE
 */
export const TOKEN_MODE: TokenMode = "delta";

/** How often the client scripts report; drives the "late"/"inactive" badges. */
export const REPORT_INTERVAL_MINUTES = 60;

/** Raw reports older than this are pruned from Redis. */
export const RETENTION_DAYS = 35;

/** Reports timestamped further in the future than this are rejected. */
export const MAX_CLOCK_SKEW_MINUTES = 10;

// ─────────────────────────────────────────────────────────────────────────────

export type TokenMode = "delta" | "snapshot" | "counter";

export interface ResetConfig {
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
  hour: number;
  minute: number;
  /** IANA time zone, e.g. "Europe/Budapest" */
  timeZone: string;
}

export interface AppConfig {
  weeklyLimit: number;
  reset: ResetConfig;
  tokenMode: TokenMode;
  reportIntervalMinutes: number;
  retentionDays: number;
  maxClockSkewMinutes: number;
}

const TOKEN_MODES: readonly TokenMode[] = ["delta", "snapshot", "counter"];

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const warned = new Set<string>();
function warnOnce(name: string, value: string, fallback: unknown): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(
    `[usageratio] Ignoring invalid ${name}=${JSON.stringify(value)}; using ${JSON.stringify(fallback)}.`,
  );
}

/** Resolves the effective configuration: constants above, overridden by valid env vars. */
export function getConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  let weeklyLimit = WEEKLY_LIMIT;
  const rawLimit = env.WEEKLY_LIMIT?.trim();
  if (rawLimit) {
    const parsed = Number(rawLimit.replace(/[_\s]/g, ""));
    if (Number.isSafeInteger(parsed) && parsed > 0) weeklyLimit = parsed;
    else warnOnce("WEEKLY_LIMIT", rawLimit, WEEKLY_LIMIT);
  }

  const reset: ResetConfig = { ...WEEKLY_RESET };

  const rawWeekday = env.RESET_WEEKDAY?.trim();
  if (rawWeekday) {
    if (/^[0-6]$/.test(rawWeekday)) reset.weekday = Number(rawWeekday);
    else warnOnce("RESET_WEEKDAY", rawWeekday, WEEKLY_RESET.weekday);
  }

  const rawTime = env.RESET_TIME?.trim();
  if (rawTime) {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(rawTime);
    if (match) {
      reset.hour = Number(match[1]);
      reset.minute = Number(match[2]);
    } else {
      warnOnce("RESET_TIME", rawTime, "the default reset time");
    }
  }

  const rawZone = env.RESET_TIMEZONE?.trim();
  if (rawZone) {
    if (isValidTimeZone(rawZone)) reset.timeZone = rawZone;
    else warnOnce("RESET_TIMEZONE", rawZone, WEEKLY_RESET.timeZone);
  }

  let tokenMode = TOKEN_MODE;
  const rawMode = env.TOKEN_MODE?.trim().toLowerCase();
  if (rawMode) {
    if ((TOKEN_MODES as readonly string[]).includes(rawMode)) {
      tokenMode = rawMode as TokenMode;
    } else {
      warnOnce("TOKEN_MODE", rawMode, TOKEN_MODE);
    }
  }

  return {
    weeklyLimit,
    reset,
    tokenMode,
    reportIntervalMinutes: REPORT_INTERVAL_MINUTES,
    retentionDays: RETENTION_DAYS,
    maxClockSkewMinutes: MAX_CLOCK_SKEW_MINUTES,
  };
}

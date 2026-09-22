import { getDayEnd } from "@/lib/cycle";
import type { UsageReport } from "@/lib/validation";

/**
 * A report's snapshot split by calendar day (its `days`), and some providers'
 * days by clock hour, turned into the running totals the machine had at the
 * end of each finished day and hour. The store keeps them as checkpoints next
 * to the report, so the charts can show when the tokens were used even
 * before a machine's first report, or while a manual machine was not run.
 * Pure.
 */

/** A report splits its snapshot into at most this many days: a monthly cycle touches up to 32. */
export const MAX_REPORT_DAYS = 32;

/** A day has at most 25 clock hours: the one the clocks go back on. */
export const MAX_DAY_HOURS = 25;

export const HOUR_MS = 3_600_000;

export interface Checkpoint {
  providerId: string;
  /** The end of the day or the hour, epoch ms. */
  ts: number;
  /** The provider's tokens from the report's first day up to `ts`. */
  tokens: number;
  /** The same split by model: only at the end of a day, as the hours come without a split. */
  models?: Record<string, number>;
}

/**
 * The checkpoints of `report` after `sinceMs` (the start of the report's cycle:
 * a running total means nothing in the cycle before), up to the report
 * itself. A day or hour still in progress has no final count yet: the report
 * stands for it. `timeZone` is the one the client split the days in.
 */
export function reportCheckpoints(report: UsageReport, timeZone: string, sinceMs: number): Checkpoint[] {
  const tokens: Record<string, number> = {};
  const models: Record<string, Record<string, number>> = {};
  const checkpoints: Checkpoint[] = [];
  const keep = (checkpoint: Checkpoint) => {
    if (checkpoint.ts > sinceMs) checkpoints.push(checkpoint);
  };

  for (const day of report.days) {
    const dayEndMs = getDayEnd(day.date, timeZone).getTime();

    for (const [providerId, hours] of Object.entries(day.hours)) {
      let running = tokens[providerId] ?? 0;
      for (const hour of hours) {
        const ts = hour.startMs + HOUR_MS;
        // The hour that ends with the day ends at the day's own checkpoint.
        if (ts > report.timestampMs || ts >= dayEndMs) break;
        running += hour.tokens;
        keep({ providerId, ts, tokens: running });
      }
    }

    // The days are in order: once one is still running, so are all after it.
    if (dayEndMs > report.timestampMs) break;
    for (const [providerId, amount] of Object.entries(day.providers)) {
      tokens[providerId] = (tokens[providerId] ?? 0) + amount;
    }
    for (const [providerId, split] of Object.entries(day.models)) {
      const byModel = (models[providerId] ??= {});
      for (const [modelId, amount] of Object.entries(split)) byModel[modelId] = (byModel[modelId] ?? 0) + amount;
    }
    for (const [providerId, amount] of Object.entries(tokens)) {
      if (amount === 0) continue;
      const split = models[providerId];
      keep({ providerId, ts: dayEndMs, tokens: amount, ...(split && { models: { ...split } }) });
    }
  }
  return checkpoints.sort((a, b) => a.ts - b.ts || (a.providerId < b.providerId ? -1 : 1));
}

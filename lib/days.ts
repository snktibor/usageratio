import { getDayEnd } from "@/lib/cycle";
import type { UsageReport } from "@/lib/validation";

/**
 * A report's snapshot split by calendar day (its `days`), turned into the
 * running totals the machine had at the end of each finished day. The store
 * keeps them as checkpoints next to the report, so the charts can show when
 * the tokens were used even on the days before a machine's first report, or
 * on days a manual machine was not run. Pure.
 */

/** A report splits its snapshot into at most this many days: a monthly cycle touches up to 32. */
export const MAX_REPORT_DAYS = 32;

export interface DayCheckpoint {
  /** The end of the day: the local midnight after it, epoch ms. */
  ts: number;
  /** Each provider's tokens from the report's first day through this one; providers without any are left out. */
  providers: Record<string, number>;
  /** The same, split by model. */
  models: Record<string, Record<string, number>>;
}

/**
 * One checkpoint at the end of every day of `report.days` that was over by the
 * time of the report; the day in progress has no final total yet, the report
 * itself stands for it. `timeZone` is the one the client split the days in.
 */
export function dayCheckpoints(report: UsageReport, timeZone: string): DayCheckpoint[] {
  const providers: Record<string, number> = {};
  const models: Record<string, Record<string, number>> = {};
  const checkpoints: DayCheckpoint[] = [];

  for (const day of report.days) {
    const ts = getDayEnd(day.date, timeZone).getTime();
    // The days are in order: once one is still running, so are all after it.
    if (!(ts <= report.timestampMs)) break;

    for (const [providerId, tokens] of Object.entries(day.providers)) {
      providers[providerId] = (providers[providerId] ?? 0) + tokens;
    }
    for (const [providerId, split] of Object.entries(day.models)) {
      const byModel = (models[providerId] ??= {});
      for (const [modelId, tokens] of Object.entries(split)) byModel[modelId] = (byModel[modelId] ?? 0) + tokens;
    }

    checkpoints.push({
      ts,
      providers: Object.fromEntries(Object.entries(providers).filter(([, tokens]) => tokens > 0)),
      models: Object.fromEntries(
        Object.entries(models).map(([providerId, byModel]) => [providerId, { ...byModel }]),
      ),
    });
  }
  return checkpoints;
}

/**
 * How a usage figure stands against the limit and the clock. Pure, and shared
 * by the server-built dashboard and the browser's ground-truth recalculation.
 */

export type QuotaStatus = "good" | "warning" | "critical";

export interface QuotaAssessment {
  limit: number;
  total: number;
  /** total / limit; above 1 when over the limit. */
  usedFraction: number;
  remaining: number;
  overage: number;
  status: QuotaStatus;
  pace: {
    /** Linear projection for the whole cycle; null while it is too early to tell. */
    projectedTotal: number | null;
    /** When the limit runs out at the current pace; null if it lasts until the reset. */
    runOutAt: number | null;
    /** One day's even share of the limit, as a fraction (about 1/7 of a week, 1/30 of a month). */
    dailyShare: number;
    /** Too early to project, yet already far beyond a day's share. */
    earlyBurn: boolean;
  };
}

/** The cycle, and the moment `total` was true. */
export interface QuotaWindow {
  startMs: number;
  endMs: number;
  nowMs: number;
}

/** Usage level that raises a warning regardless of pace. */
const WARNING_FRACTION = 0.8;
/** First-day usage above this many daily shares raises a warning without a projection. */
const EARLY_BURN_FACTOR = 2;
const DAY_MS = 86_400_000;

export function assessQuota(total: number, limit: number, window: QuotaWindow): QuotaAssessment {
  const { startMs, endMs, nowMs } = window;
  const lengthMs = endMs - startMs;
  const elapsedFraction = Math.min(1, Math.max(0, (nowMs - startMs) / lengthMs));
  const dailyShare = DAY_MS / lengthMs;

  // Bursty usage makes early projections meaningless: wait for one day of data.
  let projectedTotal: number | null = null;
  let runOutAt: number | null = null;
  if (total > 0 && elapsedFraction >= dailyShare) {
    projectedTotal = total / elapsedFraction;
    if (projectedTotal > limit && total < limit) {
      runOutAt = Math.round(startMs + (limit / total) * (nowMs - startMs));
    }
  }

  // Before a projection exists, only a blatant start is flagged: more than
  // twice a day's even share gone while the first day is not even over.
  const earlyBurn =
    projectedTotal === null && total < limit && total / limit >= EARLY_BURN_FACTOR * dailyShare;

  let status: QuotaStatus = "good";
  if (total >= limit) status = "critical";
  else if (
    earlyBurn ||
    total / limit >= WARNING_FRACTION ||
    (projectedTotal !== null && projectedTotal > limit)
  ) {
    status = "warning";
  }

  return {
    limit,
    total,
    usedFraction: total / limit,
    remaining: Math.max(0, limit - total),
    overage: Math.max(0, total - limit),
    status,
    pace: { projectedTotal, runOutAt, dailyShare, earlyBurn },
  };
}

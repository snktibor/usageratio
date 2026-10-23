import type { DashboardModel } from "@/lib/dashboard";
import type { DashboardView } from "@/lib/ground-truth";

/**
 * The pace of the last few hours, next to the current segment's average (lib/quota.ts; the cycle's, without a
 * usage reset):
 * where in the last 8 hours the pace changed, and how long the budget lasts if
 * the pace since then keeps up. It never changes the status: the average
 * decides that. Pure; shared by the dashboard and GET /api/status.
 */

const HOUR = 3_600_000;
/** How far back a change of pace is looked for. */
export const RECENT_WINDOW_MS = 8 * HOUR;
/** Two runs this many times apart, either way, are two paces. */
const CHANGE_FACTOR = 1.5;
/** A window that ended longer ago than this would pass an old pace off as the current one. */
const STALE_AFTER_MS = 2 * HOUR;
/** A trailing stretch shorter than this joins the one before it: a report seconds past the hour carries that hour. */
const MIN_TAIL_MS = 30 * 60_000;

export interface RecentPace {
  /** Epoch ms: where the current pace began (the change point, or the window's start). */
  sinceMs: number;
  /** Epoch ms: the window's end, the newest report. */
  untilMs: number;
  /** True when a change point was found; false when the whole window is one pace. */
  changed: boolean;
  /** The current pace over the cycle's average pace; 0 when nothing was used since `sinceMs`. */
  ratio: number;
  /** When the budget runs out at the current pace; null when it lasts until the reset (or the pace is 0). */
  runOutAt: number | null;
}

/** Tokens measured between two moments. */
interface Bin {
  startMs: number;
  endMs: number;
  tokens: number;
}

/**
 * The timeline's tokens between its hourly samples, from 8 hours before
 * `untilMs` (not before the segment) up to `untilMs`. Nothing came in after
 * the newest report, so the timeline's last value is the total at `untilMs`.
 * The hourly grid is the cycle's; a segment begun off it starts with its own
 * first sample, the reset (lib/timeline.ts `withResetSamples`).
 */
function windowBins(model: DashboardModel, untilMs: number): Bin[] {
  const { times, groups } = model.timeline;
  const gridStartMs = model.cycle.startMs;
  const segmentStartMs = model.segment.startMs;
  const fromMs = Math.max(segmentStartMs, untilMs - RECENT_WINDOW_MS);
  const totalAt = (index: number) => groups.reduce((sum, group) => sum + group.values[index]!, 0);

  // The last sample is the dashboard's own moment: on the hourly grid only by chance.
  const points: { ms: number; tokens: number }[] = [];
  times.forEach((ms, index) => {
    const onGrid = (ms - gridStartMs) % HOUR === 0 || ms === segmentStartMs;
    if (ms >= fromMs && ms < untilMs && onGrid) points.push({ ms, tokens: totalAt(index) });
  });
  points.push({ ms: untilMs, tokens: totalAt(times.length - 1) });

  const bins = points.slice(1).map((point, index) => ({
    startMs: points[index]!.ms,
    endMs: point.ms,
    tokens: point.tokens - points[index]!.tokens,
  }));
  const tail = bins.at(-1);
  if (tail && bins.length > 1 && tail.endMs - tail.startMs < MIN_TAIL_MS) {
    bins.pop();
    const previous = bins.pop()!;
    bins.push({ startMs: previous.startMs, endMs: tail.endMs, tokens: previous.tokens + tail.tokens });
  }
  return bins;
}

/** Tokens per ms over `bins` together. */
function rateOf(bins: Bin[]): number {
  const lengthMs = bins.reduce((sum, bin) => sum + bin.endMs - bin.startMs, 0);
  return bins.reduce((sum, bin) => sum + bin.tokens, 0) / lengthMs;
}

/** How badly one rate fits `bins`: each bin's squared error, weighted by its length. */
function misfit(bins: Bin[], rate: number): number {
  return bins.reduce((sum, bin) => {
    const lengthMs = bin.endMs - bin.startMs;
    return sum + lengthMs * (bin.tokens / lengthMs - rate) ** 2;
  }, 0);
}

/**
 * The bin the later of two paces starts at: the split into two runs that each
 * fit their own rate best, if those rates are far enough apart. Null: one pace.
 */
function changePoint(bins: Bin[]): number | null {
  let best: { index: number; error: number } | null = null;
  for (let index = 1; index < bins.length; index++) {
    const before = bins.slice(0, index);
    const after = bins.slice(index);
    const error = misfit(before, rateOf(before)) + misfit(after, rateOf(after));
    if (best === null || error < best.error) best = { index, error };
  }
  if (best === null) return null;

  const earlier = rateOf(bins.slice(0, best.index));
  const later = rateOf(bins.slice(best.index));
  const high = Math.max(earlier, later);
  return high > 0 && high >= CHANGE_FACTOR * Math.min(earlier, later) ? best.index : null;
}

/** Null while there is nothing to tell: see the spec (docs/superpowers/specs/2026-10-09-recent-pace-design.md). */
export function recentPace(model: DashboardModel, view: DashboardView): RecentPace | null {
  const { quota } = view;
  if (model.closed || !quota || quota.total <= 0 || quota.total >= quota.limit || model.total <= 0) return null;

  const newestReportMs = Math.max(0, ...model.machines.map((machine) => machine.lastSeenAt));
  const untilMs = Math.min(model.generatedAt, newestReportMs);
  if (model.generatedAt - untilMs > STALE_AFTER_MS) return null;

  const bins = windowBins(model, untilMs);
  if (bins.length === 0 || untilMs - bins[0]!.startMs < HOUR) return null;
  const elapsedMs = view.asOfMs - model.segment.startMs;
  if (elapsedMs <= 0) return null;

  const index = changePoint(bins);
  const current = index === null ? bins : bins.slice(index);
  // The timeline counts measured tokens; the budget figure may be an official reading's.
  const rate = rateOf(current) * (quota.total / model.total);
  const runOutMs = rate > 0 ? view.asOfMs + quota.remaining / rate : null;

  return {
    sinceMs: current[0]!.startMs,
    untilMs,
    changed: index !== null,
    ratio: rate / (quota.total / elapsedMs),
    runOutAt: runOutMs !== null && runOutMs < model.cycle.endMs ? Math.round(runOutMs) : null,
  };
}

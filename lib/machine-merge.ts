import type { UsageEvent } from "@/lib/aggregate";

/**
 * Merging one machine's history into another's (lib/manage-store.ts
 * `moveMachine`), for the case it exists for: the same machine reported
 * under two identities — a wrong name or group at install, a client switched
 * to another group — and the two histories overlap.
 *
 * Both are snapshots, running totals of the cycle, so neither rule the reader
 * already has works on them combined: read as one series (the max) they lose
 * whatever only the older identity still saw (session logs deleted on the
 * machine since), and read as two series (the sum) they count what both saw
 * twice. The right answer is per day: whichever identity saw more of that
 * day. The merge keeps the target's own series as it is, so it can go on
 * reporting, and adds a fixed carry-over series next to it: per day, what the
 * larger reading was above the target's own. The reader sums the two, like
 * any two series of one machine (lib/aggregate.ts), which gives the per-day
 * maximum. Snapshot mode only: a carry-over is a running total of the cycle.
 * Pure.
 */

/** One cycle of the merged history, with the local midnights inside it (lib/cycle.ts `getDaySegments`). */
export interface MergeCycle {
  startMs: number;
  endMs: number;
  dayEndsMs: number[];
}

/** One machine's history within one group: its own reports and checkpoints, and the carry-over an earlier merge left it. */
export interface MergeUnit {
  raw: UsageEvent[];
  carried: UsageEvent[];
}

/** One point of the new carry-over series: its running total of the cycle at `ts`. */
export interface CarriedCheckpoint {
  ts: number;
  tokens: number;
  models?: Record<string, number>;
  costUsd?: number;
}

interface Reading {
  tokens: number;
  models: Record<string, number>;
  costUsd: number;
  hasCost: boolean;
}

const ZERO: Reading = { tokens: 0, models: {}, costUsd: 0, hasCost: false };

/**
 * A snapshot series' reading at each of `endsMs` (exclusive), counting from
 * `startMs`: its largest report in the window, as lib/aggregate.ts reads one,
 * with that report's split by model. Cost is its own running maximum, like
 * `costOfSeriesUntil`.
 */
function readingsOf(events: UsageEvent[], startMs: number, endsMs: number[]): Reading[] {
  return endsMs.map((endMs) => {
    let best: UsageEvent | null = null;
    let costUsd = 0;
    let hasCost = false;
    for (const event of events) {
      if (event.ts < startMs || event.ts >= endMs) continue;
      if (!best || event.tokens > best.tokens || (event.tokens === best.tokens && event.ts >= best.ts)) best = event;
      if (event.costUsd !== undefined) {
        costUsd = Math.max(costUsd, event.costUsd);
        hasCost = true;
      }
    }
    return { tokens: best?.tokens ?? 0, models: best?.models ?? {}, costUsd, hasCost };
  });
}

function addModels(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const sum = { ...a };
  for (const [modelId, amount] of Object.entries(b)) sum[modelId] = (sum[modelId] ?? 0) + amount;
  return sum;
}

function sumReadings(a: Reading, b: Reading): Reading {
  return {
    tokens: a.tokens + b.tokens,
    models: addModels(a.models, b.models),
    costUsd: a.costUsd + b.costUsd,
    hasCost: a.hasCost || b.hasCost,
  };
}

/** What each model grew by from `before` to `after`, never below zero. */
function modelGrowth(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const growth: Record<string, number> = {};
  for (const [modelId, amount] of Object.entries(after)) {
    const grown = amount - (before[modelId] ?? 0);
    if (grown > 0) growth[modelId] = grown;
  }
  return growth;
}

function withoutModels(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const rest: Record<string, number> = {};
  for (const [modelId, amount] of Object.entries(a)) {
    const left = amount - (b[modelId] ?? 0);
    if (left > 0) rest[modelId] = left;
  }
  return rest;
}

/** `split` scaled so its amounts add up to `total`, in whole tokens; empty when there is nothing to scale. */
function scaleModels(split: Record<string, number>, total: number): Record<string, number> {
  const entries = Object.entries(split);
  const sum = entries.reduce((acc, [, amount]) => acc + amount, 0);
  if (sum <= 0 || total <= 0) return {};
  const scaled: Record<string, number> = {};
  let assigned = 0;
  entries.forEach(([modelId, amount], index) => {
    const share = index === entries.length - 1 ? total - assigned : Math.round((amount / sum) * total);
    assigned += share;
    if (share > 0) scaled[modelId] = share;
  });
  return scaled;
}

/**
 * The carry-over series `base` needs so that, read next to its own reports,
 * each day of each cycle counts as much as the unit that saw the most of it.
 * `base.carried` (an earlier merge's carry-over) is replaced by the result:
 * it is taken into account, not kept alongside. Points are placed at each
 * local midnight where the running total has grown past zero, and at the end
 * of the cycle's data (`nowMs` for the cycle still running, else the last
 * millisecond of the cycle).
 */
export function carryOver(
  base: MergeUnit,
  others: MergeUnit[],
  cycles: MergeCycle[],
  nowMs: number,
): CarriedCheckpoint[] {
  const units = [base, ...others];
  const points: CarriedCheckpoint[] = [];

  for (const cycle of cycles) {
    if (cycle.startMs > nowMs) continue;
    const finalEnd = Math.min(cycle.endMs, nowMs + 1);
    const midnights = cycle.dayEndsMs.filter((ms) => ms > cycle.startMs && ms + 1 < finalEnd);
    // A midnight's checkpoint is stored at the midnight itself: count it into the day it closes.
    const endsMs = [...midnights.map((ms) => ms + 1), finalEnd];
    const writeAt = [...midnights, Math.min(cycle.endMs - 1, nowMs)];

    const baseRaw = readingsOf(base.raw, cycle.startMs, endsMs);
    const unitReadings = units.map((unit) => {
      const raw = readingsOf(unit.raw, cycle.startMs, endsMs);
      const carried = readingsOf(unit.carried, cycle.startMs, endsMs);
      return raw.map((reading, index) => sumReadings(reading, carried[index]!));
    });

    // Cost comes with reports only, never split by day: the carried tokens are costed at the rate the winner paid over the cycle.
    const rates = unitReadings.map((readings) => {
      const last = readings[readings.length - 1]!;
      return last.hasCost && last.tokens > 0 ? last.costUsd / last.tokens : null;
    });

    let tokens = 0;
    let models: Record<string, number> = {};
    let costUsd = 0;
    endsMs.forEach((_, index) => {
      const before = (readings: Reading[]) => (index === 0 ? ZERO : readings[index - 1]!);
      const baseGrowth = baseRaw[index]!.tokens - before(baseRaw).tokens;

      // The unit that saw the most of this day; the base wins a tie, so nothing is carried then.
      let winner = 0;
      let most = -1;
      unitReadings.forEach((readings, unitIndex) => {
        const growth = readings[index]!.tokens - before(readings).tokens;
        if (growth > most) {
          most = growth;
          winner = unitIndex;
        }
      });

      const carried = Math.max(0, most - baseGrowth);
      if (carried > 0) {
        const winnerModels = modelGrowth(before(unitReadings[winner]!).models, unitReadings[winner]![index]!.models);
        const baseModels = modelGrowth(before(baseRaw).models, baseRaw[index]!.models);
        const split = scaleModels(withoutModels(winnerModels, baseModels), carried);
        models = addModels(models, Object.keys(split).length > 0 ? split : scaleModels(winnerModels, carried));
        tokens += carried;
        costUsd += carried * (rates[winner] ?? 0);
      }

      if (tokens > 0) {
        points.push({
          ts: writeAt[index]!,
          tokens,
          ...(Object.keys(models).length > 0 && { models: { ...models } }),
          ...(costUsd > 0 && { costUsd: Math.round(costUsd * 1e6) / 1e6 }),
        });
      }
    });
  }
  return points;
}

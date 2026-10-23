import type { TimeWindow } from "@/lib/aggregate";
import type { AppConfig } from "@/lib/config";
import { type Cycle, getCycle } from "@/lib/cycle";
import { cycleBefore, type ResetEvent, segmentStartAt } from "@/lib/resets";
import { resetFor } from "@/lib/settings";

/**
 * Every provider's budget cycle, now that a provider can have its own reset
 * moment (lib/settings.ts `resetFor`). Pure.
 *
 * A reader that covers several providers at once (the status, the dashboard,
 * housekeeping, a client's `ccusage --since`) reads back to the earliest
 * start among them; the shared reset always counts as one of them, so the
 * result is defined with no provider at all and never later than today's.
 *
 * A provider's reset events (lib/resets.ts) matter in two places: a cycle a
 * restart began comes after the one it cut short, not after one worked out
 * backwards; and a keep reset starts a new segment, which is what a current
 * official figure is tagged with.
 */

export interface ProviderCycle {
  cycle: Cycle;
  /** The cycle right before `cycle`: the footer's comparison, counter mode's baseline, the archive. */
  previous: Cycle;
}

function cycleWith(
  now: Date,
  reset: AppConfig["reset"],
  shared: AppConfig["reset"],
  resets: ResetEvent[],
): ProviderCycle {
  const cycle = getCycle(now, reset);
  return { cycle, previous: cycleBefore(cycle, reset, shared, resets).cycle };
}

const windowOf = (cycle: Cycle): TimeWindow => ({ startMs: cycle.start.getTime(), endMs: cycle.end.getTime() });

/** The cycle `now` falls in for one provider, with the one before it; `resets` are that provider's. */
export function providerCycle(
  now: Date,
  config: AppConfig,
  providerId: string,
  resets: ResetEvent[] = [],
): ProviderCycle {
  return cycleWith(now, resetFor(config, providerId), config.reset, resets);
}

// `earliestCycle` and `earliestStartMs` need no resets: a previous cycle worked out backwards starts no
// later than a restart's real one, so reading from it still reaches far enough.

/** Of the providers' cycles and the shared reset's, the one that began first. */
export function earliestCycle(now: Date, config: AppConfig, providerIds: string[]): ProviderCycle {
  let earliest = cycleWith(now, config.reset, config.reset, []);
  for (const providerId of providerIds) {
    const candidate = providerCycle(now, config, providerId);
    if (candidate.cycle.start.getTime() < earliest.cycle.start.getTime()) earliest = candidate;
  }
  return earliest;
}

/** The earliest start of the current (`"cycle"`) or the previous (`"previous"`) cycles: how far back one read must reach. */
export function earliestStartMs(
  now: Date,
  config: AppConfig,
  providerIds: string[],
  which: "cycle" | "previous",
): number {
  const startOf = (cycles: ProviderCycle) => cycles[which].start.getTime();
  let earliest = startOf(cycleWith(now, config.reset, config.reset, []));
  for (const providerId of providerIds) earliest = Math.min(earliest, startOf(providerCycle(now, config, providerId)));
  return earliest;
}

/**
 * The start of the segment of `providerId`'s current cycle that `now` falls
 * in: its last keep reset, else the cycle's start. A current official figure
 * is tagged with it (lib/official-usage.ts).
 */
export function currentSegmentStartMs(
  now: Date,
  config: AppConfig,
  providerId: string,
  resets: ResetEvent[] = [],
): number {
  return segmentStartAt(windowOf(providerCycle(now, config, providerId, resets).cycle), resets, now.getTime());
}

/**
 * The retag rule (lib/reset-recording.ts): the tag an official figure entered
 * at `atMs` gets — the start of its segment in the provider's current cycle,
 * or in the one before; null further back (such a figure keeps its tag).
 */
export function officialTagAt(
  now: Date,
  config: AppConfig,
  providerId: string,
  resets: ResetEvent[],
): (atMs: number) => number | null {
  const { cycle, previous } = providerCycle(now, config, providerId, resets);
  const current = windowOf(cycle);
  const before = windowOf(previous);
  return (atMs) => {
    if (atMs >= current.startMs) return segmentStartAt(current, resets, atMs);
    if (atMs >= before.startMs) return segmentStartAt(before, resets, atMs);
    return null;
  };
}

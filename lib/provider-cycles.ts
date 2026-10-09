import type { AppConfig } from "@/lib/config";
import { type Cycle, getCycle, getPreviousCycle } from "@/lib/cycle";
import { resetFor } from "@/lib/settings";

/**
 * Every provider's budget cycle, now that a provider can have its own reset
 * moment (lib/settings.ts `resetFor`). Pure.
 *
 * A reader that covers several providers at once (the status, the dashboard,
 * housekeeping, a client's `ccusage --since`) reads back to the earliest
 * start among them; the shared reset always counts as one of them, so the
 * result is defined with no provider at all and never later than today's.
 */

export interface ProviderCycle {
  cycle: Cycle;
  /** The cycle right before `cycle`: the footer's comparison, counter mode's baseline. */
  previous: Cycle;
}

function cycleWith(now: Date, reset: AppConfig["reset"]): ProviderCycle {
  const cycle = getCycle(now, reset);
  return { cycle, previous: getPreviousCycle(cycle, reset) };
}

/** The cycle `now` falls in for one provider, with the one before it. */
export function providerCycle(now: Date, config: AppConfig, providerId: string): ProviderCycle {
  return cycleWith(now, resetFor(config, providerId));
}

/** Of the providers' cycles and the shared reset's, the one that began first. */
export function earliestCycle(now: Date, config: AppConfig, providerIds: string[]): ProviderCycle {
  let earliest = cycleWith(now, config.reset);
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
  let earliest = startOf(cycleWith(now, config.reset));
  for (const providerId of providerIds) earliest = Math.min(earliest, startOf(providerCycle(now, config, providerId)));
  return earliest;
}

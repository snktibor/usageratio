import { isDemoMode } from "@/lib/demo/mode";

/**
 * The server's idea of "now". Real time, except in demo mode with
 * `DEMO_FIXED_TIME` set (an ISO date-time): then that moment, so the seeded
 * dashboard, its screenshots and the end-to-end tests see the same cycle
 * whenever they run. A new Date each call, so callers may mutate it.
 */
export function currentTime(): Date {
  if (isDemoMode()) {
    const fixed = process.env.DEMO_FIXED_TIME;
    const ms = fixed ? Date.parse(fixed) : Number.NaN;
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return new Date();
}

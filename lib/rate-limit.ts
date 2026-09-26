import { getRedis } from "@/lib/redis";
import { TxPlan } from "@/lib/redis-tx";

/**
 * A fixed-window counter shared by every rate limit in the app (see
 * app/api/usage/route.ts). One key, one window: the first hit of a window
 * seeds its TTL, every hit after that just bumps the count, and the window
 * resets once the key expires — no job, no cleanup.
 */

export interface RateLimitResult {
  /** Whether this hit is still within `limit`. */
  allowed: boolean;
  /** How many more hits `limit` allows before the window is full; 0 once it is not. */
  remaining: number;
  /** Seconds left in the current window (for the 429's Retry-After). */
  retryAfterSeconds: number;
}

/**
 * Bumps `key`'s counter and reports whether it is still within `limit` hits
 * per `windowSeconds`. One pipeline: `SET key 0 EX windowSeconds NX` seeds a
 * fresh window without a race against the `INCR` that follows it (a key that
 * already exists keeps its TTL and count, so NX only ever matters on the very
 * first hit), then `TTL` reads how long is left in it.
 */
export async function hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const pipeline = getRedis().pipeline();
  const plan = new TxPlan();
  plan.add("seed", () => pipeline.set(key, 0, { ex: windowSeconds, nx: true }));
  plan.add("count", () => pipeline.incr(key));
  plan.add("ttl", () => pipeline.ttl(key));
  const results: unknown[] = await pipeline.exec();

  const count = Number(plan.result(results, "count"));
  const ttl = Number(plan.result(results, "ttl"));
  const retryAfterSeconds = ttl > 0 ? ttl : windowSeconds;
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds };
}

import { log } from "@/lib/log";
import { getRedis } from "@/lib/redis";
import { TxPlan } from "@/lib/redis-tx";

/**
 * A fixed-window counter shared by every rate limit in the app (see
 * app/api/usage/route.ts). One key, one window: the first hit of a window
 * seeds its TTL, every hit after that just bumps the count, and the window
 * resets once the key expires — no job, no cleanup.
 *
 * `enforceLimits` checks a request against several of them at once (a token's,
 * its tenant's, its address's, the instance's), and `LocalRateLimiter` is the
 * same window kept in the process's memory, for the one endpoint that must
 * not touch the store (app/api/csp-report).
 */

export interface RateLimitResult {
  /** Whether this hit is still within `limit`. */
  allowed: boolean;
  /** How many more hits `limit` allows before the window is full; 0 once it is not. */
  remaining: number;
  /** Seconds left in the current window (for the 429's Retry-After). */
  retryAfterSeconds: number;
  /** Hits counted in this window so far, this one included. */
  count: number;
}

function result(count: number, limit: number, retryAfterSeconds: number): RateLimitResult {
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds, count };
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
  return result(count, limit, ttl > 0 ? ttl : windowSeconds);
}

/** Whose budget a rule counts against: what the `rate_limit.exceeded` log line names. */
export type RateLimitScope = "token" | "machine" | "tenant" | "user" | "ip" | "instance";

export interface RateLimitRule {
  /** What is limited, for the log line: "ingest", "official", "export", … */
  name: string;
  scope: RateLimitScope;
  /** The counter (`GLOBAL_KEYS.rateLimit`). */
  key: string;
  limit: number;
  windowSeconds: number;
}

export type LimitOutcome = { allowed: true } | { allowed: false; rule: RateLimitRule; retryAfterSeconds: number };

/**
 * Counts one request against each rule in turn and stops at the first one it
 * exceeds. The order is the isolation: rules go narrowest first (a token, then
 * its tenant, then the instance), so a request one budget refuses never counts
 * against the wider ones after it — a tenant flooding past its own limit does
 * not use up the instance's, and so cannot lock the other tenants out.
 *
 * The first refusal of a window is logged (`rate_limit.exceeded`, with the
 * rule's name and scope); the ones after it in the same window are not, since
 * the request log already has every 429.
 */
export async function enforceLimits(
  rules: readonly RateLimitRule[],
  fields: Record<string, unknown> = {},
): Promise<LimitOutcome> {
  for (const rule of rules) {
    const outcome = await hit(rule.key, rule.limit, rule.windowSeconds);
    if (outcome.allowed) continue;
    if (outcome.count === rule.limit + 1) {
      log.warn("rate_limit.exceeded", {
        limit: rule.name,
        scope: rule.scope,
        max: rule.limit,
        windowSeconds: rule.windowSeconds,
        retryAfterSeconds: outcome.retryAfterSeconds,
        ...fields,
      });
    }
    return { allowed: false, rule, retryAfterSeconds: outcome.retryAfterSeconds };
  }
  return { allowed: true };
}

/**
 * The same fixed window, in this process's memory: no store round trip, and it
 * keeps working while the store is down. Each server instance counts on its
 * own, so it is a soft limit, for an endpoint that only ever logs. The number
 * of keys is bounded: past `maxKeys` the oldest windows are forgotten (a Map
 * keeps insertion order), so a flood of spoofed addresses cannot grow it.
 */
export class LocalRateLimiter {
  private readonly windows = new Map<string, { count: number; startMs: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 5_000,
  ) {
    this.maxKeys = Math.max(1, maxKeys);
  }

  hit(key: string, nowMs: number): RateLimitResult {
    let window = this.windows.get(key);
    if (!window || nowMs - window.startMs >= this.windowMs) {
      this.windows.delete(key);
      while (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next().value as string;
        this.windows.delete(oldest);
      }
      window = { count: 0, startMs: nowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    const retryAfterSeconds = Math.max(1, Math.ceil((window.startMs + this.windowMs - nowMs) / 1000));
    return result(window.count, this.limit, retryAfterSeconds);
  }
}

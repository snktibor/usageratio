import { describe, expect, it } from "vitest";
import { hit } from "@/lib/rate-limit";
import { useRedis } from "./helpers/redis-fixture";

describe("hit", () => {
  const redis = useRedis();

  it("allows up to the limit, then denies with the window as Retry-After", async () => {
    const key = "usage:rl:test:allow";
    for (let i = 1; i <= 3; i++) {
      const result = await hit(key, 3, 60);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(3 - i);
    }
    const fourth = await hit(key, 3, 60);
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterSeconds).toBe(60);
  });

  it("keeps separate counters for separate keys", async () => {
    const a = await hit("usage:rl:test:a", 1, 60);
    const b = await hit("usage:rl:test:b", 1, 60);
    expect(a).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 60 });
    expect(b).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 60 });
  });

  it("seeds the window on the first hit only: later hits keep counting down the same window", async ({ skip }) => {
    if (redis.real) skip();
    const key = "usage:rl:test:window";
    await hit(key, 5, 60);
    redis.store?.clock.advance(30_000);
    const second = await hit(key, 5, 60);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(3);
    // 30s of the original 60s window are left, not reset to 60 by this second hit.
    expect(second.retryAfterSeconds).toBe(30);
    expect(redis.store?.ttl(key)).toBe(30);
  });

  it("resets once the window has fully elapsed", async ({ skip }) => {
    if (redis.real) skip();
    const key = "usage:rl:test:reset";
    await hit(key, 2, 60);
    expect((await hit(key, 2, 60)).allowed).toBe(true); // count is now 2, at the limit
    expect((await hit(key, 2, 60)).allowed).toBe(false); // count is now 3, over the limit

    redis.store?.clock.advance(60_001);
    const afterExpiry = await hit(key, 2, 60);
    expect(afterExpiry).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 60 });
  });
});

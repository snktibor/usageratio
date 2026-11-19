import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/log";
import { enforceLimits, hit, LocalRateLimiter, type RateLimitRule } from "@/lib/rate-limit";
import { getRedis } from "@/lib/redis";
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
    expect(a).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 60, count: 1 });
    expect(b).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 60, count: 1 });
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
    expect(afterExpiry).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 60, count: 1 });
  });
});

describe("hit on a counter without an expiry", () => {
  useRedis();

  it("answers the window as Retry-After when the key has no TTL", async () => {
    await getRedis().set("usage:rl:test:no-ttl", 5);
    const result = await hit("usage:rl:test:no-ttl", 3, 60);
    expect(result).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 60, count: 6 });
  });
});

describe("enforceLimits", () => {
  useRedis();
  afterEach(() => vi.restoreAllMocks());

  const rule = (key: string, limit: number, scope: RateLimitRule["scope"] = "token"): RateLimitRule => ({
    name: "test",
    scope,
    key,
    limit,
    windowSeconds: 60,
  });
  const count = async (key: string) => Number((await getRedis().get(key)) ?? 0);

  it("allows a request every rule still has room for, counting it against each", async () => {
    const rules = [rule("usage:rl:test:narrow", 2), rule("usage:rl:test:wide", 5, "instance")];
    expect(await enforceLimits(rules)).toEqual({ allowed: true });
    expect(await count("usage:rl:test:narrow")).toBe(1);
    expect(await count("usage:rl:test:wide")).toBe(1);
  });

  it("stops at the first rule a request exceeds: the wider ones after it are not counted", async () => {
    const rules = [rule("usage:rl:test:narrow", 1), rule("usage:rl:test:wide", 100, "instance")];
    await enforceLimits(rules);
    for (let i = 0; i < 5; i++) {
      const refused = await enforceLimits(rules);
      expect(refused).toEqual({ allowed: false, rule: rules[0], retryAfterSeconds: 60 });
    }
    expect(await count("usage:rl:test:narrow")).toBe(6);
    // Only the one request the narrow rule let through reached the instance's counter.
    expect(await count("usage:rl:test:wide")).toBe(1);
  });

  it("refuses on a wider rule once it is full, whatever the narrower ones say", async () => {
    const rules = [rule("usage:rl:test:a", 10), rule("usage:rl:test:shared", 1, "tenant")];
    expect((await enforceLimits(rules)).allowed).toBe(true);
    const refused = await enforceLimits([rule("usage:rl:test:b", 10), rule("usage:rl:test:shared", 1, "tenant")]);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.rule.scope).toBe("tenant");
  });

  it("logs the first refusal of a window only, with the rule and the caller's fields", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const rules = [rule("usage:rl:test:log", 1, "ip")];
    await enforceLimits(rules, { route: "api/test" });
    expect(warn).not.toHaveBeenCalled();
    await enforceLimits(rules, { route: "api/test" });
    await enforceLimits(rules, { route: "api/test" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("rate_limit.exceeded", {
      limit: "test",
      scope: "ip",
      max: 1,
      windowSeconds: 60,
      retryAfterSeconds: 60,
      route: "api/test",
    });
  });

  it("allows a request no rule applies to", async () => {
    expect(await enforceLimits([])).toEqual({ allowed: true });
  });
});

describe("LocalRateLimiter", () => {
  it("allows up to the limit per key and window, then refuses with the time left", () => {
    const limiter = new LocalRateLimiter(2, 60_000);
    expect(limiter.hit("a", 0)).toEqual({ allowed: true, remaining: 1, retryAfterSeconds: 60, count: 1 });
    expect(limiter.hit("a", 1_000).allowed).toBe(true);
    expect(limiter.hit("a", 20_500)).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 40, count: 3 });
    expect(limiter.hit("b", 20_500).allowed).toBe(true);
  });

  it("starts a fresh window once the old one has passed", () => {
    const limiter = new LocalRateLimiter(1, 60_000);
    limiter.hit("a", 0);
    expect(limiter.hit("a", 59_999).allowed).toBe(false);
    expect(limiter.hit("a", 60_000)).toEqual({ allowed: true, remaining: 0, retryAfterSeconds: 60, count: 1 });
  });

  it("forgets the oldest windows past maxKeys, so spoofed addresses cannot grow it", () => {
    const limiter = new LocalRateLimiter(1, 60_000, 2);
    limiter.hit("a", 0);
    limiter.hit("b", 0);
    limiter.hit("c", 0); // "a" is forgotten
    expect(limiter.hit("a", 1).allowed).toBe(true);
    expect(limiter.hit("c", 1).allowed).toBe(false);
  });

  it("keeps at least one key", () => {
    const limiter = new LocalRateLimiter(1, 60_000, 0);
    limiter.hit("all", 0);
    expect(limiter.hit("all", 1).allowed).toBe(false);
  });
});

import { Redis } from "@upstash/redis";
import { afterEach, beforeEach } from "vitest";
import { getRedis, resetRedisClientForTests, setRedisClientForTests } from "@/lib/redis";
import { createMemoryRedis, type MemoryStore } from "@/lib/redis-memory";

/**
 * A fresh store for every test. By default the in-memory Redis
 * (lib/redis-memory.ts), whose clock the test can move; with TEST_REDIS=real
 * the Docker one from docker-compose.dev.yml (TEST_REDIS_URL / TEST_REDIS_TOKEN),
 * flushed before each test — the same suite then proves the fake and the real
 * thing agree.
 *
 *   const redis = useRedis();
 *   it("…", async () => { redis.store?.clock.advance(60_000); … });
 */
export const REAL_REDIS = process.env.TEST_REDIS === "real";

export interface RedisFixture {
  /** The memory store's handle (clock, ttl, dump, failNext); null on a real Redis. */
  readonly store: MemoryStore | null;
  readonly real: boolean;
}

export function useRedis(options: { now?: () => number } = {}): RedisFixture {
  let store: MemoryStore | null = null;

  beforeEach(async () => {
    if (REAL_REDIS) {
      const client = new Redis({
        url: process.env.TEST_REDIS_URL ?? "http://127.0.0.1:8079",
        token: process.env.TEST_REDIS_TOKEN ?? "local_dev_token",
        automaticDeserialization: false,
        enableTelemetry: false,
      });
      setRedisClientForTests(client);
      await getRedis().flushdb();
      store = null;
    } else {
      const memory = createMemoryRedis(options);
      setRedisClientForTests(memory.redis, memory.store);
      store = memory.store;
    }
  });

  afterEach(() => {
    resetRedisClientForTests();
    store = null;
  });

  return {
    get store() {
      return store;
    },
    real: REAL_REDIS,
  };
}

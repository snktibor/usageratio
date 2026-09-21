import { Redis } from "@upstash/redis";

/** The Redis connection env vars are missing (store not connected to the project yet). */
export class StorageNotConfiguredError extends Error {
  constructor() {
    super(
      "Redis is not configured: set KV_REST_API_URL + KV_REST_API_TOKEN " +
        "(or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).",
    );
    this.name = "StorageNotConfiguredError";
  }
}

let client: Redis | null = null;

/**
 * Lazily created so that `next build` works before the store is connected.
 * Accepts both env var namings: the Vercel Marketplace (Upstash) integration
 * injects KV_REST_API_*, a store created on upstash.com uses UPSTASH_REDIS_REST_*.
 */
export function getRedis(): Redis {
  if (client) return client;

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new StorageNotConfiguredError();

  client = new Redis({
    url,
    token,
    // Values are (de)serialized explicitly in usage-store.ts, so ids such as
    // "123" or "true" never get turned into numbers or booleans on the way back.
    automaticDeserialization: false,
    enableTelemetry: false,
    retry: { retries: 3, backoff: (attempt) => Math.exp(attempt) * 50 },
  });
  return client;
}

/**
 * HGETALL as a plain string map. With automatic deserialization off the SDK
 * hands back Redis' flat [field, value, …] array; an object is accepted too.
 */
export function toStringRecord(raw: unknown): Record<string, string> {
  const record: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) {
      record[String(raw[i])] = String(raw[i + 1]);
    }
  } else if (raw !== null && typeof raw === "object") {
    for (const [field, value] of Object.entries(raw)) {
      record[field] = typeof value === "string" ? value : JSON.stringify(value);
    }
  }
  return record;
}

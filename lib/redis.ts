import { Redis } from "@upstash/redis";
import { currentTime } from "@/lib/clock";
import { isDemoMode } from "@/lib/demo/mode";
import { createMemoryRedis, type MemoryStore } from "@/lib/redis-memory";

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

interface StoreState {
  client: Redis | null;
  /** The handle of the memory store behind `client`, when that is what it is. */
  memoryStore: MemoryStore | null;
}

// On globalThis, not in this module: Next bundles instrumentation.ts and the
// routes separately, and `next dev` re-evaluates modules on every edit. One
// process must have one store, or demo mode would seed a copy nobody reads.
const globalState = globalThis as typeof globalThis & { __usageratioStore?: StoreState };
const state: StoreState = (globalState.__usageratioStore ??= { client: null, memoryStore: null });

/**
 * Where the data lives: Upstash over REST, or the in-memory store of demo
 * mode and of `USAGE_STORE=memory` (a Docker-free development setup that
 * forgets everything on restart).
 */
export function storageKind(): "memory" | "redis" {
  return process.env.USAGE_STORE === "memory" || isDemoMode() ? "memory" : "redis";
}

/**
 * Lazily created so that `next build` works before the store is connected.
 * Accepts both env var namings: the Vercel Marketplace (Upstash) integration
 * injects KV_REST_API_*, a store created on upstash.com uses UPSTASH_REDIS_REST_*.
 */
export function getRedis(): Redis {
  if (state.client) return state.client;

  if (storageKind() === "memory") {
    const memory = createMemoryRedis({ now: () => currentTime().getTime() });
    state.client = memory.redis;
    state.memoryStore = memory.store;
    return state.client;
  }

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new StorageNotConfiguredError();

  state.client = new Redis({
    url,
    token,
    // Values are (de)serialized explicitly in usage-store.ts, so ids such as
    // "123" or "true" never get turned into numbers or booleans on the way back.
    automaticDeserialization: false,
    enableTelemetry: false,
    retry: { retries: 3, backoff: (attempt) => Math.exp(attempt) * 50 },
  });
  return state.client;
}

function assertTestRun(): void {
  if (!process.env.VITEST) throw new Error("The Redis client can only be swapped out under Vitest.");
}

/** Points the application at `next` (a memory client, typically), with its store handle when it has one. */
export function setRedisClientForTests(next: Redis | null, store: MemoryStore | null = null): void {
  assertTestRun();
  state.client = next;
  state.memoryStore = store;
}

/** Forgets the current client: the next `getRedis()` creates a fresh one from the environment. */
export function resetRedisClientForTests(): void {
  assertTestRun();
  state.client = null;
  state.memoryStore = null;
}

/** The store handle behind the current memory client (clock, injected failures, dumps); null when not memory. */
export function getMemoryStoreForTests(): MemoryStore | null {
  assertTestRun();
  return state.memoryStore;
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

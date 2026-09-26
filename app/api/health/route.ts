import { json, withApiHandler } from "@/lib/api";
import { getRedis, StorageNotConfiguredError, storageKind } from "@/lib/redis";
import { version } from "@/package.json";

/**
 * GET /api/health — for uptime monitors and the Docker HEALTHCHECK. No auth,
 * no data, no configuration: only whether the app is up and its store answers.
 *
 *   { "ok": true, "version": "1.0.0", "commit": "a1b2c3d", "storage": "redis",
 *     "store": "ok", "latencyMs": 12, "time": "2026-09-26T10:00:00.000Z" }
 *
 * 200 when the store answers within 2 s, 503 otherwise (`store` says why).
 */

const PING_TIMEOUT_MS = 2000;

type StoreState = "ok" | "unavailable" | "not_configured";

async function pingStore(): Promise<{ store: StoreState; latencyMs: number }> {
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("ping timed out")), PING_TIMEOUT_MS);
  });
  try {
    await Promise.race([getRedis().ping(), timeout]);
    return { store: "ok", latencyMs: latency() };
  } catch (error) {
    return {
      store: error instanceof StorageNotConfiguredError ? "not_configured" : "unavailable",
      latencyMs: latency(),
    };
  } finally {
    clearTimeout(timer);
  }
}

export const dynamic = "force-dynamic";

export const GET = withApiHandler("api/health", async () => {
  const { store, latencyMs } = await pingStore();
  const ok = store === "ok";
  return json(
    {
      ok,
      version,
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      storage: storageKind(),
      store,
      latencyMs,
      time: new Date().toISOString(),
    },
    ok ? 200 : 503,
  );
});

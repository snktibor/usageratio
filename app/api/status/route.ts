import { apiError, json, requireBearerThrottled, withApiHandler } from "@/lib/api";
import { STATUS_RATE_LIMIT_PER_TOKEN } from "@/lib/config";
import { hit } from "@/lib/rate-limit";
import { loadStatus } from "@/lib/status";

/**
 * GET /api/status — the current cycle's usage per provider, for the macOS
 * menu bar app (clients/macos). Shape: `StatusPayload` in lib/status.ts.
 *
 *   Authorization: Bearer <token>
 *
 * Any valid bearer token is accepted: the shared USAGE_API_TOKEN, a
 * per-machine "ingest" token, or a "read" or "official" one minted for the menu bar
 * app (lib/tokens.ts); those two cannot report tokens, and only "official" may
 * also upload a provider's own percentage (POST /api/official-usage/report).
 * Allowed in demo mode, since it only reads.
 *
 * 200 ok · 401 bad token · 429 a rate limit was hit, with
 * `retryAfterSeconds` (failed tokens per IP, 60/minute; lookups per token,
 * STATUS_RATE_LIMIT_PER_TOKEN/hour) · 500 server misconfigured · 503 Redis down
 */
export const GET = withApiHandler("api/status", async ({ request }) => {
  const auth = await requireBearerThrottled(request);
  if (auth instanceof Response) return auth;

  const limit = await hit(`usage:rl:status:${auth.tokenId}`, STATUS_RATE_LIMIT_PER_TOKEN, 3600);
  if (!limit.allowed) return apiError("rate_limited", 429, { retryAfterSeconds: limit.retryAfterSeconds });

  return json({ ...(await loadStatus()) }, 200);
});

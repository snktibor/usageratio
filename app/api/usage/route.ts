import { checkIngestAlerts } from "@/lib/alerts";
import { apiError, json, readJsonBody, requireBearerThrottled, withApiHandler } from "@/lib/api";
import {
  CYCLE_RATE_LIMIT_PER_TOKEN,
  getConfig,
  INGEST_RATE_LIMIT_GLOBAL,
  INGEST_RATE_LIMIT_PER_MACHINE,
} from "@/lib/config";
import { dateInTimeZone } from "@/lib/cycle";
import { demoReadOnly } from "@/lib/demo/mode";
import { ingestReport } from "@/lib/ingest";
import { earliestCycle, providerCycle } from "@/lib/provider-cycles";
import { mergeProviderIds } from "@/lib/providers";
import { hit } from "@/lib/rate-limit";
import { defer } from "@/lib/request-context";
import { sha256Hex } from "@/lib/security";
import { resolveConfig, storedProviderIds } from "@/lib/settings";
import { loadReportContext } from "@/lib/usage-store";

/**
 * POST /api/usage — ingest endpoint for the client scripts.
 *
 *   Authorization: Bearer <USAGE_API_TOKEN>
 *   { "machineId": "mac-studio", "groupId": "Personal",
 *     "providers": { "deepseek": 15000, "claude": 22000 },
 *     "models": { "claude": { "claude-opus-4-5-20251101": 20000 } },
 *     "days": { "2026-09-20": { "providers": { "claude": 12000 },
 *                               "models": { "claude": { "claude-opus-4-5-20251101": 11000 } } },
 *               "2026-09-21": { "providers": { "deepseek": 15000, "claude": 10000 } } },
 *     "timestamp": "2026-09-21T10:00:00Z" }
 *
 * `models` is optional: each provider's tokens split by model, for the
 * dashboard's per-model chart. So is `days`: the same snapshot split by
 * calendar day in the cycle's time zone, some providers' days also by clock
 * hour (`"hours": { "claude": { "2026-09-20T08:00:00Z": 3000 } }`), which lets
 * the charts place the tokens of times the machine did not report at (see
 * lib/days.ts).
 *
 * A `groupId` that is not on the settings panel's list is added to it with a
 * random colour (`"groupRegistered": true` in the response).
 * GET with the same Bearer token returns the current cycle and its ccusage
 * `sinceDate`, so clients can build a true cycle-to-date snapshot. The `cycle`
 * is the earliest provider cycle (a provider can have its own reset), with
 * `cycle.providers` holding each provider's own start and end.
 *
 * 201 stored · 200 identical report already stored · 400 bad JSON/payload ·
 * 401 bad token · 403 machine_mismatch (a machine-bound token reporting for
 * another machine), or read_only_token (a "read" token, which may only GET) ·
 * 413 body too large · 422 a registry cap (too many groups, providers or
 * machines) refused the report, with its `limit` · 429 a rate
 * limit was hit, with `retryAfterSeconds` · 500 server misconfigured ·
 * 503 Redis down
 *
 * Authorization accepts the shared USAGE_API_TOKEN, or a per-machine token
 * minted from the settings panel (lib/tokens.ts, `/api/tokens`); the latter
 * can be revoked individually, and optionally bound to one `machineId`, in
 * which case a report naming a different machine is refused outright.
 *
 * Rate limits (lib/rate-limit.ts `hit`, all answer 429 `rate_limited`):
 * a per-IP counter of failed Bearer tokens (`usage:rl:unauth:*`, 60/minute —
 * this only ever counts an actual 401, so machines sharing one IP behind a
 * NAT are never throttled by each other's *valid* reports); once a token is
 * accepted, POST is further limited per token+machine (`usage:rl:ingest:*`,
 * 60/hour) and by a deployment-wide total (`usage:rl:ingest:global:*`,
 * 600/hour); GET is limited per token (`usage:rl:cycle:*`, 120/hour).
 */

// Room for the optional splits: up to 60 model ids, and those again for each of up to 32 days, with their hours.
const MAX_BODY_BYTES = 65_536;

/** The body's `machineId` field, read before validation so the per-machine limiter can key on it. */
function rawMachineId(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).machineId;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The current UTC hour, as a fixed-width bucket for the global ingest counter's key. */
function hourBucket(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}`;
}

/** Current server-side cycle, used by clients to filter ccusage daily output. */
export const GET = withApiHandler("api/usage", async ({ request }) => {
  const auth = await requireBearerThrottled(request);
  if (auth instanceof Response) return auth;

  const cycleHit = await hit(`usage:rl:cycle:${auth.tokenId}`, CYCLE_RATE_LIMIT_PER_TOKEN, 3600);
  if (!cycleHit.allowed) return apiError("rate_limited", 429, { retryAfterSeconds: cycleHit.retryAfterSeconds });

  const config = getConfig();
  const context = await loadReportContext();
  const providerIds = mergeProviderIds(context.providerIds, storedProviderIds(context.settings));
  const effective = resolveConfig(config, context.settings, providerIds);
  const now = new Date();
  // One ccusage run covers every provider: it starts at the earliest provider cycle.
  const { cycle } = earliestCycle(now, effective, providerIds);
  const iso = (date: Date) => date.toISOString();
  return json(
    {
      tokenMode: effective.tokenMode,
      providers: providerIds,
      cycle: {
        start: iso(cycle.start),
        end: iso(cycle.end),
        sinceDate: dateInTimeZone(cycle.start, effective.reset.timeZone),
        timeZone: effective.reset.timeZone,
        // Each provider's own: a client trims every provider to its start (clients/shared/ccusage-providers.cjs).
        providers: Object.fromEntries(
          providerIds.map((providerId) => {
            const own = providerCycle(now, effective, providerId).cycle;
            return [providerId, { start: iso(own.start), end: iso(own.end) }];
          }),
        ),
      },
    },
    200,
  );
});

export const POST = withApiHandler("api/usage", async ({ request }) => {
  const auth = await requireBearerThrottled(request);
  if (auth instanceof Response) return auth;
  // A read token (the menu bar app's) may look, never report.
  if (auth.scope === "read") return apiError("read_only_token", 403);
  // The demo's data is synthetic on purpose; nothing gets in.
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  // The clients send no Content-Type worth insisting on; the body decides.
  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, requireJsonContentType: false });
  if (!body.ok) return body.response;

  const machineId = rawMachineId(body.value);
  // A machine-bound token (lib/tokens.ts) may only ever report for its own machine.
  if (auth.machineId !== null && machineId?.trim() !== auth.machineId) {
    return apiError("machine_mismatch", 403);
  }
  if (machineId) {
    const machineKey = `usage:rl:ingest:${sha256Hex(`${auth.tokenId}:${machineId}`).slice(0, 32)}`;
    const machineHit = await hit(machineKey, INGEST_RATE_LIMIT_PER_MACHINE, 3600);
    if (!machineHit.allowed) {
      return apiError("rate_limited", 429, { retryAfterSeconds: machineHit.retryAfterSeconds });
    }
  }
  const globalHit = await hit(`usage:rl:ingest:global:${hourBucket(new Date())}`, INGEST_RATE_LIMIT_GLOBAL, 3600);
  if (!globalHit.allowed) return apiError("rate_limited", 429, { retryAfterSeconds: globalHit.retryAfterSeconds });

  const now = new Date();
  const result = await ingestReport(body.value, now);
  if (!result.ok) {
    if ("refused" in result) return apiError(result.refused, 422, { limit: result.limit });
    return apiError("invalid_payload", 400, { details: result.errors });
  }

  // Threshold alerts (lib/alerts.ts): measured-token signal, only when the token limits are on.
  if (!result.duplicate && !result.heartbeat) defer(() => checkIngestAlerts(result.report, now));

  const { cycle } = result;
  return json(
    {
      ok: true,
      duplicate: result.duplicate,
      groupRegistered: result.newGroup,
      providersRegistered: result.newProviders,
      report: result.report,
      tokenMode: result.tokenMode,
      cycle: cycle && { start: cycle.start.toISOString(), end: cycle.end.toISOString() },
    },
    result.duplicate ? 200 : 201,
  );
});

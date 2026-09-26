import { apiError, json, readJsonBody, requireBearer, withApiHandler } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { dateInTimeZone, getCycle } from "@/lib/cycle";
import { demoReadOnly } from "@/lib/demo/mode";
import { ingestReport } from "@/lib/ingest";
import { mergeProviderIds } from "@/lib/providers";
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
 * `sinceDate`, so clients can build a true cycle-to-date snapshot.
 *
 * 201 stored · 200 identical report already stored · 400 bad JSON/payload ·
 * 401 bad token · 413 body too large · 500 server misconfigured · 503 Redis down
 */

// Room for the optional splits: up to 60 model ids, and those again for each of up to 32 days, with their hours.
const MAX_BODY_BYTES = 65_536;

/** Current server-side cycle, used by clients to filter ccusage daily output. */
export const GET = withApiHandler("api/usage", async ({ request }) => {
  const auth = requireBearer(request);
  if (auth instanceof Response) return auth;

  const config = getConfig();
  const context = await loadReportContext();
  const providerIds = mergeProviderIds(context.providerIds, storedProviderIds(context.settings));
  const effective = resolveConfig(config, context.settings, providerIds);
  const cycle = getCycle(new Date(), effective.reset);
  return json(
    {
      tokenMode: effective.tokenMode,
      providers: providerIds,
      cycle: {
        start: cycle.start.toISOString(),
        end: cycle.end.toISOString(),
        sinceDate: dateInTimeZone(cycle.start, effective.reset.timeZone),
        timeZone: effective.reset.timeZone,
      },
    },
    200,
  );
});

export const POST = withApiHandler("api/usage", async ({ request }) => {
  const auth = requireBearer(request);
  if (auth instanceof Response) return auth;
  // The demo's data is synthetic on purpose; nothing gets in.
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  // The clients send no Content-Type worth insisting on; the body decides.
  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, requireJsonContentType: false });
  if (!body.ok) return body.response;

  const result = await ingestReport(body.value, new Date());
  if (!result.ok) return apiError("invalid_payload", 400, { details: result.errors });

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

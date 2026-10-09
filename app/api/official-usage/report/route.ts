import { checkOfficialUsageAlerts } from "@/lib/alerts";
import { apiError, json, readJsonBody, requireBearerThrottled, withApiHandler } from "@/lib/api";
import { currentTime } from "@/lib/clock";
import { getConfig, OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN } from "@/lib/config";
import { demoReadOnly } from "@/lib/demo/mode";
import { decideOfficialReport, parseOfficialReport } from "@/lib/official-report";
import { officialUsageField, parseStoredOfficialEntry } from "@/lib/official-usage";
import { mergeProviderIds } from "@/lib/providers";
import { hit } from "@/lib/rate-limit";
import { defer } from "@/lib/request-context";
import { resolveConfig, storedProviderIds } from "@/lib/settings";
import { loadIndexes, saveOfficialUsage, saveResetOverride } from "@/lib/usage-store";

/**
 * POST /api/official-usage/report — a provider's own weekly usage percentage,
 * read on a machine (the macOS menu bar app), as the dashboard's official
 * reading. Only an "official" token (lib/tokens.ts) may send it.
 *
 *   { "providerId": "claude", "usedPercent": 41.2, "resetsAtMs": …, "observedAtMs": … }
 *
 * The server decides (lib/official-report.ts): a monthly dashboard refuses it;
 * a provider whose cycle ends elsewhere than the window gets its reset moved
 * to the window's; a reading no newer than the stored one is not written.
 *
 * 200 { ok, saved, cycleChanged, reset } · 400 bad payload · 401 bad token ·
 * 403 official_scope_required · 409 period_not_weekly | stale_reading ·
 * 413 body too large · 415 not JSON · 429 rate limited · 503 Redis down
 */

const MAX_BODY_BYTES = 1_024;

export const POST = withApiHandler("api/official-usage/report", async ({ request }) => {
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  const auth = await requireBearerThrottled(request);
  if (auth instanceof Response) return auth;
  if (auth.scope !== "official") return apiError("official_scope_required", 403);

  const limit = await hit(`usage:rl:official:${auth.tokenId}`, OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN, 3600);
  if (!limit.allowed) return apiError("rate_limited", 429, { retryAfterSeconds: limit.retryAfterSeconds });

  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) return body.response;

  const now = currentTime();
  const parsed = parseOfficialReport(body.value, now);
  if (!parsed.ok) return apiError("invalid_payload", 400, { details: parsed.errors });
  const { report } = parsed;

  const indexes = await loadIndexes();
  const providerIds = mergeProviderIds(
    indexes.providers.map((provider) => provider.providerId),
    storedProviderIds(indexes.settings),
  );
  const config = resolveConfig(getConfig(), indexes.settings, providerIds);
  const storedRaw = indexes.officialUsage[officialUsageField(report.providerId, null)];
  const stored = storedRaw ? parseStoredOfficialEntry(storedRaw) : null;

  const decision = decideOfficialReport(report, config, now, stored?.view ?? null, stored?.cycleStartMs ?? null);
  if (decision.kind !== "accept") return apiError(decision.kind, 409);

  if (decision.override) await saveResetOverride(report.providerId, decision.override, now, providerIds);
  if (decision.save) {
    const update = {
      providerId: report.providerId,
      subLimitId: null,
      raw: decision.raw,
      cycleStartMs: decision.cycleStartMs,
    };
    // The reading's own time: the dashboard says when the figure was true, not when it arrived.
    await saveOfficialUsage(update, new Date(report.observedAtMs));
    defer(() => checkOfficialUsageAlerts(update, now));
  }

  const { override } = decision;
  return json(
    {
      ok: true,
      saved: decision.save,
      cycleChanged: override !== null,
      reset: override && { weekday: override.weekday, hour: override.hour, minute: override.minute },
    },
    200,
  );
});

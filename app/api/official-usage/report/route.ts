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
import { saveDetectedReset } from "@/lib/reset-store";
import { resetsOf } from "@/lib/resets";
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
 * to the window's; a reading no newer than the stored one is not written; a
 * reading that reveals a usage reset records it (lib/resets.ts) and answers it
 * in `detectedReset`; while detection is off for the cycle, a reading whose
 * window ends elsewhere is ignored (`saved: false`).
 *
 * 200 { ok, saved, cycleChanged, reset, detectedReset } · 400 bad payload · 401 bad token ·
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

  const resets = resetsOf(indexes.resets, report.providerId);

  const decision = decideOfficialReport(report, config, now, stored, resets);
  // Detection is off for this cycle (a reverted reset) and the window ends elsewhere: nothing to do.
  if (decision.kind === "ignored") {
    return json({ ok: true, saved: false, cycleChanged: false, reset: null, detectedReset: null }, 200);
  }
  if (decision.kind !== "accept") return apiError(decision.kind, 409);

  // A detected reset moves the provider's reset itself, in its own transaction.
  if (decision.override && !decision.reset) {
    await saveResetOverride(report.providerId, decision.override, now, providerIds);
  } else if (decision.refresh) {
    // The same reset, its instant or wall clock read again: the cycle does not change.
    await saveResetOverride(report.providerId, decision.refresh, now, providerIds);
  }
  const detected =
    decision.reset &&
    (await saveDetectedReset({
      providerId: report.providerId,
      config,
      resets,
      reset: decision.reset,
      override: decision.override,
      rawSettings: indexes.settings,
      providerIds,
      rawOfficialUsage: indexes.officialUsage,
      now,
    }));
  if (decision.save) {
    const update = {
      providerId: report.providerId,
      subLimitId: null,
      raw: decision.raw,
      cycleStartMs: decision.cycleStartMs,
      // Kept with the figure: the next reading is compared with it (reset detection).
      resetsAtMs: report.resetsAtMs,
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
      detectedReset: detected ? { id: detected.id, kind: detected.kind, atMs: detected.atMs } : null,
    },
    200,
  );
});

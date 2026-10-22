import { apiError, json, readJsonBody, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { getConfig } from "@/lib/config";
import { demoReadOnly } from "@/lib/demo/mode";
import { mergeProviderIds } from "@/lib/providers";
import { buildSettingsView, parseSettingsUpdate, resolveConfig, storedProviderIds } from "@/lib/settings";
import { loadGroupActivity, loadIndexes, saveSettings } from "@/lib/usage-store";

/**
 * /api/settings — the budget and the groups, for the dashboard's settings panel.
 * Authenticated by the dashboard's session cookie: without a valid PIN session
 * both methods answer 401 and touch no data.
 *
 *   GET  → { "settings": { "period", "useTokenLimits", "limits": { "claude": 500000 },
 *                          "reset": { "weekday", "monthDay", "hour", "minute" },
 *                          "showRemaining", "hiddenProviders", "excludedProviders" },
 *            "timeZone": "Europe/Budapest",
 *            "groups": [{ "id", "color", "hasReports" }] }
 *
 *   PUT    { "period": "weekly" | "monthly",
 *            "useTokenLimits": false,                            false: no limit, only the official %
 *            "limits": { "claude": 500000 },                     kept even while unused
 *            "reset": { "weekday": 1, "monthDay": 1, "hour": 0, "minute": 0 },
 *            "resetOverrides": { "openai": { "weekday": 2, … } },  providers' own resets
 *            "resetModes": { "claude": "keep" },                 how a provider resets early (lib/resets.ts)
 *            "showRemaining": true,                              false hides the tokens left
 *            "costEstimate": false,                              true: every machine prices its usage
 *            "hiddenProviders": ["openai"],                      not on the dashboard; one must stay
 *            "excludedProviders": { "Work": ["claude"] },        group → providers it does not count for
 *            "groups": [{ "id": "Work", "color": "#3987e5" }],   create or recolour; others stay
 *            "removedGroups": ["Old"] }                          only groups without stored reports
 *
 * 200 ok · 400 bad JSON/payload, or every provider hidden · 401 no session · 403 foreign origin ·
 * 409 a group to remove still has reports (nothing was saved) · 413 body too large ·
 * 415 not JSON · 503 Redis down
 */

const MAX_BODY_BYTES = 16_384;

export const GET = withApiHandler("api/settings", async () => {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const indexes = await loadIndexes();
  const providerIds = mergeProviderIds(
    indexes.providers.map((provider) => provider.providerId),
    storedProviderIds(indexes.settings),
  );
  const config = resolveConfig(getConfig(), indexes.settings, providerIds);
  return json({ ...buildSettingsView(config, await loadGroupActivity(indexes.groups, providerIds), providerIds) }, 200);
});

export const PUT = withApiHandler("api/settings", async ({ request }) => {
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) return body.response;

  const parsed = parseSettingsUpdate(body.value);
  if (!parsed.ok) return apiError("invalid_payload", 400, { details: parsed.errors });

  const indexes = await loadIndexes();
  const providerIds = mergeProviderIds(
    indexes.providers.map((provider) => provider.providerId),
    storedProviderIds(indexes.settings),
    Object.keys(parsed.update.settings.limits),
  );
  // The panel never lets the last one go: a dashboard needs a provider to show.
  // (A fresh install has none yet, and may still save its reset and groups.)
  if (
    providerIds.length > 0 &&
    providerIds.every((providerId) => parsed.update.settings.hiddenProviders.includes(providerId))
  ) {
    return apiError("invalid_payload", 400, { details: ["at least one provider must stay visible"] });
  }
  const saved = await saveSettings(parsed.update, new Date(), providerIds);
  if (!saved.ok) return apiError("groups_have_reports", 409, { groups: saved.groupsWithReports });

  return json({ ok: true, settings: parsed.update.settings }, 200);
});

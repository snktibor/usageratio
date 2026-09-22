import { isAuthenticated } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { mergeProviderIds } from "@/lib/providers";
import { StorageNotConfiguredError } from "@/lib/redis";
import {
  buildSettingsView,
  parseSettingsUpdate,
  resolveConfig,
  storedProviderIds,
} from "@/lib/settings";
import { loadGroupActivity, loadIndexes, saveSettings } from "@/lib/usage-store";

/**
 * /api/settings — the budget and the groups, for the dashboard's settings panel.
 * Authenticated by the dashboard's session cookie: without a valid PIN session
 * both methods answer 401 and touch no data.
 *
 *   GET  → { "settings": { "period", "useTokenLimits", "limits": { "claude": 500000 },
 *                          "reset": { "weekday", "monthDay", "hour", "minute" },
 *                          "showRemaining" },
 *            "timeZone": "Europe/Budapest",
 *            "groups": [{ "id", "color", "hasReports" }] }
 *
 *   PUT    { "period": "weekly" | "monthly",
 *            "useTokenLimits": false,                            false: no limit, only the official %
 *            "limits": { "claude": 500000 },                     kept even while unused
 *            "reset": { "weekday": 1, "monthDay": 1, "hour": 0, "minute": 0 },
 *            "showRemaining": true,                              false hides the tokens left
 *            "groups": [{ "id": "Work", "color": "#3987e5" }],   create or recolour; others stay
 *            "removedGroups": ["Old"] }                          only groups without stored reports
 *
 * 200 ok · 400 bad JSON/payload · 401 no session · 403 foreign origin ·
 * 409 a group to remove still has reports (nothing was saved) · 413 body too large ·
 * 415 not JSON · 503 Redis down
 */

const MAX_BODY_BYTES = 16_384;

function json(body: Record<string, unknown>, status: number, headers?: Record<string, string>) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function storageFailure(error: unknown): Response {
  if (error instanceof StorageNotConfiguredError) {
    console.error(`[usageratio] ${error.message}`);
    return json({ error: "storage_not_configured" }, 503);
  }
  console.error("[usageratio] The settings could not reach the store:", error);
  return json({ error: "storage_unavailable" }, 503, { "Retry-After": "60" });
}

/**
 * Browsers put an Origin on every PUT. The SameSite=Lax session cookie already
 * stays home on cross-site requests; a foreign Origin is turned away all the same.
 */
function isForeignOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "")
    .split(",")[0]
    ?.trim();
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export async function GET(): Promise<Response> {
  try {
    if (!(await isAuthenticated())) return json({ error: "unauthorized" }, 401);

    const indexes = await loadIndexes();
    const providerIds = mergeProviderIds(
      indexes.providers.map((provider) => provider.providerId),
      storedProviderIds(indexes.settings),
    );
    const config = resolveConfig(getConfig(), indexes.settings, providerIds);
    return json(
      {
        ...buildSettingsView(
          config,
          await loadGroupActivity(indexes.groups, providerIds),
          providerIds,
        ),
      },
      200,
    );
  } catch (error) {
    return storageFailure(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  if (isForeignOrigin(request)) return json({ error: "forbidden_origin" }, 403);

  try {
    if (!(await isAuthenticated())) return json({ error: "unauthorized" }, 401);
  } catch (error) {
    return storageFailure(error);
  }

  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) {
    return json({ error: "unsupported_media_type" }, 415);
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "unreadable_body" }, 400);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large", maxBytes: MAX_BODY_BYTES }, 413);
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const parsed = parseSettingsUpdate(body);
  if (!parsed.ok) return json({ error: "invalid_payload", details: parsed.errors }, 400);

  try {
    const indexes = await loadIndexes();
    const providerIds = mergeProviderIds(
      indexes.providers.map((provider) => provider.providerId),
      storedProviderIds(indexes.settings),
      Object.keys(parsed.update.settings.limits),
    );
    const saved = await saveSettings(parsed.update, new Date(), providerIds);
    if (!saved.ok) {
      return json({ error: "groups_have_reports", groups: saved.groupsWithReports }, 409);
    }
  } catch (error) {
    return storageFailure(error);
  }

  return json({ ok: true, settings: parsed.update.settings }, 200);
}

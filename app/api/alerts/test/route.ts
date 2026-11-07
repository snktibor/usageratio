import { hasLocale } from "next-intl";
import { routing } from "@/i18n/routing";
import { sendTestAlert } from "@/lib/alerts";
import { apiError, json, readJsonBody, requireSameOrigin, requireTenantSession, withApiHandler } from "@/lib/api";
import { type AlertsFormat, getConfig } from "@/lib/config";
import { demoReadOnly } from "@/lib/demo/mode";
import { hit } from "@/lib/rate-limit";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { isMultiTenant } from "@/lib/registration";
import { ALERT_FORMATS, restoreMaskedWebhook, storedWebhookUrl } from "@/lib/settings";
import { loadIndexes } from "@/lib/usage-store";
import { isAllowedWebhookUrl, MAX_WEBHOOK_URL_LENGTH } from "@/lib/webhook";

/**
 * POST /api/alerts/test — the settings panel's "send test" button: a sample
 * threshold message to the webhook URL and format being edited, before they
 * are saved. Authenticated and throttled like the rest of the settings
 * panel's write endpoints; the alerts settings themselves are saved through
 * PUT /api/settings, not here.
 *
 *   POST { "webhookUrl": "https://hooks.example.com/x", "format": "slack", "locale": "en" }
 *
 * Multi-tenant mode: the page only has the stored URL masked; that mask, sent unchanged, tests the
 * stored URL, and an edited mask is a 400.
 *
 * 200 { "ok": true, "status": 200 } · 400 bad JSON/payload · 401 no session ·
 * 403 foreign origin · 413 body too large · 415 not JSON ·
 * 429 more than one attempt per 10 seconds ·
 * 502 { "error": "webhook_failed", "status", "detail" }, the upstream status
 * (null for a network failure) and the error message · 503 Redis down
 */

const MAX_BODY_BYTES = 2_048;

interface TestAlertRequest {
  webhookUrl: string;
  format: AlertsFormat;
  locale: string;
}

function isAlertFormat(value: unknown): value is AlertsFormat {
  return (ALERT_FORMATS as readonly unknown[]).includes(value);
}

function parseTestAlertRequest(
  input: unknown,
): { ok: true; value: TestAlertRequest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const body =
    typeof input === "object" && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : null;
  if (!body) return { ok: false, errors: ["body must be a JSON object"] };

  const { webhookUrl, format, locale } = body;
  if (
    typeof webhookUrl !== "string" ||
    webhookUrl.length > MAX_WEBHOOK_URL_LENGTH ||
    !isAllowedWebhookUrl(webhookUrl)
  ) {
    errors.push("webhookUrl must be an allowed https URL");
  }
  if (!isAlertFormat(format)) errors.push(`format must be one of ${ALERT_FORMATS.join(", ")}`);
  if (typeof locale !== "string" || !hasLocale(routing.locales, locale))
    errors.push("locale must be a supported locale");
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: { webhookUrl: webhookUrl as string, format: format as AlertsFormat, locale: locale as string },
  };
}

export const POST = withApiHandler("api/alerts/test", async ({ request }) => {
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;

  const limited = await hit(GLOBAL_KEYS.rateLimit.alertsTest, 1, 10);
  if (!limited.allowed) return apiError("rate_limited", 429, { retryAfterSeconds: limited.retryAfterSeconds });

  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) return body.response;

  // Multi-tenant mode: the page only knows the stored URL masked, and sends that mask to test it.
  let value = body.value;
  if (isMultiTenant()) {
    const restored = restoreMaskedWebhook(
      { alerts: value },
      storedWebhookUrl((await loadIndexes(tenant.store)).settings, getConfig()),
    );
    if (!restored.ok)
      return apiError("invalid_payload", 400, { details: ["webhookUrl is masked: enter the full URL again"] });
    value = (restored.body as { alerts: unknown }).alerts;
  }

  const parsed = parseTestAlertRequest(value);
  if (!parsed.ok) return apiError("invalid_payload", 400, { details: parsed.errors });

  const result = await sendTestAlert(parsed.value);
  if (!result.ok) return apiError("webhook_failed", 502, { status: result.status, detail: result.error });

  return json({ ok: true, status: result.status }, 200);
});

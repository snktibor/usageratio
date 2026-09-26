import { apiError, json, readJsonBody, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { demoReadOnly } from "@/lib/demo/mode";
import { parseOfficialUsageUpdate } from "@/lib/official-usage";
import { saveOfficialUsage } from "@/lib/usage-store";

/**
 * /api/official-usage — one ground-truth field of the dashboard: the
 * provider's own figure, or one of its sub-limits'. Authenticated by the
 * dashboard's session cookie, same as /api/settings.
 *
 * Written on a short pause after typing (or dragging the slider), not on
 * every keystroke; the dashboard's own polling (see components/auto-refresh.tsx)
 * is what carries a saved figure from the browser that typed it to the others.
 *
 *   PUT  { "providerId": "claude",
 *           "subLimitId": "fable",             null for the provider's own field
 *           "raw": "45.5",                     as typed; empty clears the field
 *           "cycleStartMs": 1758326400000 }    the field's own cycle, from the dashboard it was typed on
 *
 * 200 ok · 400 bad JSON/payload · 401 no session · 403 foreign origin ·
 * 413 body too large · 415 not JSON · 503 Redis down
 */

const MAX_BODY_BYTES = 1_024;

export const PUT = withApiHandler("api/official-usage", async ({ request }) => {
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) return body.response;

  const parsed = parseOfficialUsageUpdate(body.value);
  if (!parsed.ok) return apiError("invalid_payload", 400, { details: parsed.errors });

  const enteredAt = Date.now();
  await saveOfficialUsage(parsed.update, new Date(enteredAt));

  return json({ ok: true, enteredAt }, 200);
});

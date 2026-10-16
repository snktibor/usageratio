import { apiError, json, readJsonBody, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { demoReadOnly } from "@/lib/demo/mode";
import { parseArchivedOfficialUpdate } from "@/lib/official-usage";
import { saveArchivedOfficial } from "@/lib/usage-store";

/**
 * /api/official-usage/archived — corrects the official percentage of a
 * finished cycle: the figure archived with it (lib/history.ts), say the 82%
 * last typed or reported before the reset, when the cycle in fact ended on
 * 100%. Authenticated by the dashboard's session cookie, same as
 * /api/official-usage. No threshold alerts: the cycle is over.
 *
 *   PUT  { "providerId": "claude",
 *           "raw": "100",                      as typed; empty clears the figure
 *           "cycleStartMs": 1758326400000 }    the archived cycle's start
 *
 * 200 ok · 400 bad JSON/payload · 401 no session · 403 foreign origin ·
 * 404 not_found (no archived summary of that cycle) · 413 body too large ·
 * 415 not JSON · 503 Redis down
 */

const MAX_BODY_BYTES = 1_024;

export const PUT = withApiHandler("api/official-usage/archived", async ({ request }) => {
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) return body.response;

  const parsed = parseArchivedOfficialUpdate(body.value);
  if (!parsed.ok) return apiError("invalid_payload", 400, { details: parsed.errors });

  const { providerId, cycleStartMs, official } = parsed.update;
  if (!(await saveArchivedOfficial(providerId, cycleStartMs, official))) return apiError("not_found", 404);

  return json({ ok: true }, 200);
});

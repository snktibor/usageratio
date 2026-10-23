import { apiError, json, readJsonBody, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { currentTime } from "@/lib/clock";
import { demoReadOnly } from "@/lib/demo/mode";
import { parseResetDelete, parseResetPost, parseResetPut } from "@/lib/reset-recording";
import { applyResetAction, type ResetAction } from "@/lib/reset-store";

/**
 * /api/resets — a provider's usage resets in its current cycle (lib/resets.ts):
 * recorded by hand on the dashboard, edited, deleted, or reverted when the
 * menu bar app's readings were wrongly taken for one. Authenticated by the
 * dashboard's session cookie, same origin only.
 *
 *   POST   { "providerId": "claude",
 *            "atMs": 1758549600000,     a whole minute after the cycle's start, not after now
 *            "before": 80,              optional, 0–100 or null; absent: the stored figure, if read before atMs
 *            "afterRaw": "3" }          optional: the figure since the reset, stored at atMs
 *   PUT    { "providerId", "id", "atMs"?, "before"? }      a reset of the current cycle
 *   DELETE { "providerId", "id", "revert"?: true }        revert: a detected reset only; puts its
 *                                                         before-figure back, detection stops this cycle
 *
 * The kind is the provider's mode (lib/settings.ts `resetModeOf`); a restart
 * moves the provider's own reset to atMs.
 *
 * 200 { ok, events, cycle: { startMs, endMs } } · 400 bad JSON/payload · 401 no session ·
 * 403 foreign origin, or demo mode (demo_read_only) · 404 not_found (provider or reset) ·
 * 409 outside_cycle | duplicate_reset | has_later_resets | not_revertable ·
 * 413 body too large · 415 not JSON · 503 Redis down
 */

const MAX_BODY_BYTES = 1_024;

type ParsedAction = { ok: true; action: ResetAction } | { ok: false; errors: string[] };

function resetHandler(parse: (body: unknown) => ParsedAction) {
  return withApiHandler("api/resets", async ({ request }) => {
    const foreign = requireSameOrigin(request);
    if (foreign) return foreign;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;

    const unauthorized = await requireSession();
    if (unauthorized) return unauthorized;

    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.response;
    const parsed = parse(body.value);
    if (!parsed.ok) return apiError("invalid_payload", 400, { details: parsed.errors });

    const result = await applyResetAction(parsed.action, currentTime());
    if (!result.ok) return apiError(result.refused, result.refused === "not_found" ? 404 : 409);
    return json({ ok: true, events: result.events, cycle: result.cycle }, 200);
  });
}

export const POST = resetHandler((body) => {
  const parsed = parseResetPost(body);
  return parsed.ok ? { ok: true, action: { kind: "record", request: parsed.value } } : parsed;
});

export const PUT = resetHandler((body) => {
  const parsed = parseResetPut(body);
  return parsed.ok ? { ok: true, action: { kind: "edit", request: parsed.value } } : parsed;
});

export const DELETE = resetHandler((body) => {
  const parsed = parseResetDelete(body);
  return parsed.ok ? { ok: true, action: { kind: "delete", request: parsed.value } } : parsed;
});

import { isAuthenticated } from "@/lib/auth";
import { storageFailure as failure, isForeignOrigin, json } from "@/lib/http";
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

const storageFailure = (error: unknown) => failure(error, "The official-usage field");

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

  const parsed = parseOfficialUsageUpdate(body);
  if (!parsed.ok) return json({ error: "invalid_payload", details: parsed.errors }, 400);

  const enteredAt = Date.now();
  try {
    await saveOfficialUsage(parsed.update, new Date(enteredAt));
  } catch (error) {
    return storageFailure(error);
  }

  return json({ ok: true, enteredAt }, 200);
}

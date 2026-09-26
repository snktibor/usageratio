import { apiError, json, readJsonBody, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { isValidApiToken } from "@/lib/api-token";
import { demoReadOnly } from "@/lib/demo/mode";
import { encryptionKey, loadApiTokenStatus, saveApiToken } from "@/lib/token-vault";

/**
 * /api/api-token — the stored copy of the clients' API token, for the settings
 * panel. Behind the dashboard's PIN session like /api/settings: without one
 * both methods answer 401 and touch no data. Neither ever answers with the
 * token: only POST /api/api-token/reveal does, and that is audited.
 *
 *   GET  → { "status": { "state": "no_key" | "empty" | "unreadable" | "stored",
 *                        "updatedAt": ms, "matchesServer": true | false | null } }
 *
 *   PUT    { "token": "…" }   16–512 printable ASCII characters, no spaces. Encrypted
 *                             with AES-256-GCM (key: TOKEN_ENCRYPTION_KEY) and stored;
 *                             "created" or "updated" goes on the audit trail.
 *        → { "ok": true, "action": "created" | "updated", "status": { … } }
 *
 * 200 ok · 400 bad JSON/token · 401 no session · 403 foreign origin · 413 body too large ·
 * 415 not JSON · 500 TOKEN_ENCRYPTION_KEY missing · 503 Redis down
 */

const MAX_BODY_BYTES = 2_048;

export const GET = withApiHandler("api/api-token", async () => {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;
  return json({ status: await loadApiTokenStatus() }, 200);
});

export const PUT = withApiHandler("api/api-token", async ({ request }) => {
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const key = encryptionKey();
  if (!key) return apiError("encryption_key_missing", 500);

  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) return body.response;

  const value = body.value;
  const token =
    typeof value === "object" && value !== null && "token" in value && typeof value.token === "string"
      ? value.token.trim()
      : null;
  if (!isValidApiToken(token)) {
    return apiError("invalid_token", 400, {
      details: ["token must be 16 to 512 printable ASCII characters without spaces"],
    });
  }

  const saved = await saveApiToken(token, key, new Date());
  return json({ ok: true, action: saved.action, status: saved.status }, 200);
});

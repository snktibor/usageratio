import { isValidApiToken } from "@/lib/api-token";
import { isAuthenticated } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { storageFailure as failure, isForeignOrigin, json } from "@/lib/http";
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

const storageFailure = (error: unknown) => failure(error, "The API token");

export async function GET(): Promise<Response> {
  try {
    if (!(await isAuthenticated())) return json({ error: "unauthorized" }, 401);
    return json({ status: await loadApiTokenStatus() }, 200);
  } catch (error) {
    return storageFailure(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  if (isForeignOrigin(request)) return json({ error: "forbidden_origin" }, 403);
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  try {
    if (!(await isAuthenticated())) return json({ error: "unauthorized" }, 401);
  } catch (error) {
    return storageFailure(error);
  }

  const key = encryptionKey();
  if (!key) return json({ error: "encryption_key_missing" }, 500);

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

  const token =
    typeof body === "object" && body !== null && "token" in body && typeof body.token === "string"
      ? body.token.trim()
      : null;
  if (!isValidApiToken(token)) {
    return json(
      { error: "invalid_token", details: ["token must be 16 to 512 printable ASCII characters without spaces"] },
      400,
    );
  }

  try {
    const saved = await saveApiToken(token, key, new Date());
    return json({ ok: true, action: saved.action, status: saved.status }, 200);
  } catch (error) {
    return storageFailure(error);
  }
}

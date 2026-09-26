import { isAuthenticated } from "@/lib/auth";
import { storageFailure as failure, isForeignOrigin, json } from "@/lib/http";
import { encryptionKey, revealApiToken } from "@/lib/token-vault";

/**
 * POST /api/api-token/reveal — the stored API token in plaintext, for the
 * setup page's copy button. A POST, so that nothing prefetches or caches it.
 * Behind the dashboard's PIN session; every answer that carries the token has
 * first put a "revealed" entry (time, browser, IP, session) on the audit trail.
 *
 *   → { "token": "…" }
 *
 * 200 ok · 401 no session · 403 foreign origin · 404 nothing stored ·
 * 409 stored but cannot be decrypted · 500 TOKEN_ENCRYPTION_KEY missing · 503 Redis down
 */

const storageFailure = (error: unknown) => failure(error, "The API token reveal");

export async function POST(request: Request): Promise<Response> {
  if (isForeignOrigin(request)) return json({ error: "forbidden_origin" }, 403);

  try {
    if (!(await isAuthenticated())) return json({ error: "unauthorized" }, 401);

    const key = encryptionKey();
    if (!key) return json({ error: "encryption_key_missing" }, 500);

    const revealed = await revealApiToken(key, new Date());
    if (revealed.state === "empty") return json({ error: "no_token" }, 404);
    if (revealed.state === "unreadable") return json({ error: "token_unreadable" }, 409);
    return json({ token: revealed.token }, 200);
  } catch (error) {
    return storageFailure(error);
  }
}

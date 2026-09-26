import { apiError, json, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { hasSudo } from "@/lib/auth";
import { demoReadOnly } from "@/lib/demo/mode";
import { encryptionKey, revealApiToken } from "@/lib/token-vault";

/**
 * POST /api/api-token/reveal — the stored API token in plaintext, for the
 * setup page's copy button. A POST, so that nothing prefetches or caches it.
 * Behind the dashboard's PIN session *and* a live sudo grant (POST
 * /api/auth/sudo): every answer that carries the token has first put a
 * "revealed" entry (time, browser, IP, session) on the audit trail.
 *
 *   → { "token": "…" }
 *
 * 200 ok · 401 no session · 403 foreign origin, demo mode, or no sudo grant ·
 * 404 nothing stored · 409 stored but cannot be decrypted ·
 * 500 TOKEN_ENCRYPTION_KEY missing · 503 Redis down
 */
export const POST = withApiHandler("api/api-token/reveal", async ({ request }) => {
  const origin = requireSameOrigin(request);
  if (origin) return origin;
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  const session = await requireSession();
  if (session) return session;
  if (!(await hasSudo())) return apiError("sudo_required", 403);

  const key = encryptionKey();
  if (!key) return apiError("encryption_key_missing", 500);

  const revealed = await revealApiToken(key, new Date());
  if (revealed.state === "empty") return apiError("no_token", 404);
  if (revealed.state === "unreadable") return apiError("token_unreadable", 409);
  return json({ token: revealed.token }, 200);
});

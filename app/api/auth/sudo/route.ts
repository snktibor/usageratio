import { apiError, json, readJsonBody, requireSameOrigin, requireTenantSession, withApiHandler } from "@/lib/api";
import { grantSudo, pinShape } from "@/lib/auth";
import { isMultiTenant } from "@/lib/registration";

/**
 * GET/POST /api/auth/sudo — sudo mode: a 5-minute grant on top of the
 * dashboard's PIN session, required before /api/api-token/reveal hands out
 * the stored API token in plaintext.
 *
 *   GET  → { "mode": "pin" | "github", "numeric": true | false }   how sudo is confirmed here, and
 *        whether the PIN field should show a numeric keypad
 *   POST { "pin": "…" } → 204 granted (PIN mode only: in multi-tenant mode sudo is a GitHub
 *        round trip, POST /api/auth/github/start { "purpose": "sudo" }, and this answers 404)
 *
 * 204 granted · 401 no session, or { "error": "sudo_invalid", attemptsLeft? } · 403 foreign origin ·
 * 415/413/400 bad body · 429 { "error": "rate_limited", retryAfterSeconds } · 500 server misconfigured ·
 * 503 Redis down
 */

/** A wrong (or impossible) PIN: 401 `sudo_invalid`, with the guesses left when the limiter counted it. */
function sudoInvalid(attemptsLeft?: number): Response {
  return apiError("sudo_invalid", 401, attemptsLeft === undefined ? {} : { attemptsLeft });
}

export const GET = withApiHandler("api/auth/sudo", async () => {
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  if (isMultiTenant()) return json({ mode: "github", numeric: false }, 200);
  return json({ mode: "pin", numeric: pinShape().numeric }, 200);
});

export const POST = withApiHandler("api/auth/sudo", async ({ request }) => {
  const origin = requireSameOrigin(request);
  if (origin) return origin;
  const tenant = await requireTenantSession();
  if (tenant instanceof Response) return tenant;
  if (isMultiTenant()) return apiError("not_found", 404);

  const body = await readJsonBody(request, { maxBytes: 1024 });
  if (!body.ok) return body.response;

  const value = body.value;
  const pin =
    typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).pin === "string"
      ? ((value as Record<string, unknown>).pin as string).trim()
      : "";

  const result = await grantSudo(pin);
  if (result.ok) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });

  switch (result.reason) {
    case "rate_limited":
      return apiError("rate_limited", 429, { retryAfterSeconds: result.retryAfterSeconds });
    case "misconfigured":
      return apiError("server_misconfigured", 500);
    case "invalid":
      return sudoInvalid(result.attemptsLeft);
    case "malformed":
      return sudoInvalid();
  }
});

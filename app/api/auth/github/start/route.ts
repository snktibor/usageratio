import { apiError, json, readJsonBody, requireSameOrigin, withApiHandler } from "@/lib/api";
import { isMultiTenant } from "@/lib/registration";
import { countSignInAttempt, startSignIn } from "@/lib/sign-in";

/**
 * POST /api/auth/github/start — begins a GitHub sign-in (multi-tenant mode only; 404 otherwise).
 *
 *   { "purpose": "login" | "signup" | "sudo", "returnTo"?: "/settings", "locale"?: "hu", "code"?: "…" }
 *     → 200 { "url": "https://github.com/login/oauth/authorize?…" } with the attempt's nonce cookie
 *
 * The page then navigates to `url` itself (a form posting here could not
 * follow a redirect to github.com under the CSP's `form-action 'self'`).
 * `code` is a sign-up code (purpose "signup"), read from the /signup link's
 * fragment; "sudo" needs a signed-in session. `returnTo` and `locale` are
 * checked against allow-lists (lib/sign-in.ts); anything else means home.
 *
 * 200 · 400 bad body / signup_code_invalid · 401 sudo without a session · 403 foreign origin /
 * registration_closed · 404 single-user instance · 429 too many attempts from this address (20 per
 * 10 minutes, with the callback; 300 shared when no trusted proxy names the address) ·
 * 500 server_misconfigured (the OAuth App is not set up) · 503 Redis down
 */

const PURPOSES = new Set(["login", "signup", "sudo"]);
export const POST = withApiHandler("api/auth/github/start", async ({ request }) => {
  if (!isMultiTenant()) return apiError("not_found", 404);
  const foreign = requireSameOrigin(request);
  if (foreign) return foreign;

  const limit = await countSignInAttempt();
  if (!limit.allowed) return apiError("rate_limited", 429, { retryAfterSeconds: limit.retryAfterSeconds });

  const body = await readJsonBody(request, { maxBytes: 2048 });
  if (!body.ok) return body.response;
  const value = (typeof body.value === "object" && body.value !== null ? body.value : {}) as Record<string, unknown>;
  if (typeof value.purpose !== "string" || !PURPOSES.has(value.purpose)) return apiError("invalid_payload", 400);

  const result = await startSignIn({
    purpose: value.purpose as "login" | "signup" | "sudo",
    returnTo: value.returnTo,
    locale: value.locale,
    signupCode: value.code,
  });
  if (!result.ok) {
    switch (result.reason) {
      case "misconfigured":
        return apiError("server_misconfigured", 500);
      case "unauthorized":
        return apiError("unauthorized", 401);
      case "signup_code_invalid":
        return apiError("signup_code_invalid", 400);
      case "registration_closed":
        return apiError("registration_closed", 403);
    }
  }
  return json({ url: result.url }, 200, { "Set-Cookie": result.cookie });
});

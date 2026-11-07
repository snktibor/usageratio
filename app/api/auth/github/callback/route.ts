import { routing } from "@/i18n/routing";
import { apiError, withApiHandler } from "@/lib/api";
import { isMultiTenant } from "@/lib/registration";
import { currentCookies } from "@/lib/request-context";
import { countSignInAttempt, finishSignIn, oauthCookieName } from "@/lib/sign-in";

/**
 * GET /api/auth/github/callback?code&state — where GitHub sends the browser back (multi-tenant
 * mode only; 404 otherwise). Always answers 303 to a page of this site: the one the attempt asked
 * to return to, or the home page with `?signin_error=<code>` (lib/sign-in.ts `SignInErrorCode`).
 * GitHub's own error text is never echoed. The response clears the attempt's nonce cookie, and on
 * success sets the session cookie.
 */

export const dynamic = "force-dynamic";

export const GET = withApiHandler("api/auth/github/callback", async ({ url }) => {
  if (!isMultiTenant()) return apiError("not_found", 404);
  const limit = await countSignInAttempt();
  // A page, not a JSON 429: the browser landed here from GitHub.
  if (!limit.allowed) {
    return new Response(null, {
      status: 303,
      headers: { Location: `/${routing.defaultLocale}?signin_error=rate_limited`, "Cache-Control": "no-store" },
    });
  }

  const nonce = (await currentCookies()).get(await oauthCookieName())?.value;
  const result = await finishSignIn(
    {
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
      error: url.searchParams.get("error"),
      nonce,
    },
    new Date(),
  );
  const headers = new Headers({ Location: result.location, "Cache-Control": "no-store" });
  for (const cookie of result.cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
});

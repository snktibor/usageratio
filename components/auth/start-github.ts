/**
 * Starts a GitHub sign-in from the browser: asks /api/auth/github/start for
 * the authorize URL (the server sets the attempt's nonce cookie on that same
 * response), then navigates there. Resolves only with a failure code; on
 * success the page is already leaving.
 */
export type StartFailure =
  | "signup_code_invalid"
  | "invite_invalid"
  | "registration_closed"
  | "rate_limited"
  | "misconfigured"
  | "unavailable";

export async function startGithubSignIn(params: {
  purpose: "login" | "signup" | "join" | "sudo";
  locale: string;
  returnTo?: string;
  code?: string;
}): Promise<StartFailure> {
  let response: Response;
  try {
    response = await fetch("/api/auth/github/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      cache: "no-store",
    });
  } catch {
    return "unavailable";
  }
  const payload = (await response.json().catch(() => null)) as { url?: unknown; error?: unknown } | null;
  if (response.ok && typeof payload?.url === "string") {
    window.location.assign(payload.url);
    return new Promise<StartFailure>(() => {});
  }
  switch (payload?.error) {
    case "signup_code_invalid":
    case "invite_invalid":
    case "registration_closed":
    case "rate_limited":
      return payload.error;
    case "server_misconfigured":
      return "misconfigured";
    default:
      return "unavailable";
  }
}

/** The current page as a sign-in may return to it: its path without the locale prefix. */
export function currentReturnTo(locale: string): string {
  const path = window.location.pathname;
  const stripped = path === `/${locale}` ? "/" : path.startsWith(`/${locale}/`) ? path.slice(locale.length + 1) : path;
  return stripped || "/";
}

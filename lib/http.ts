/** Origin checks shared by the JSON endpoints behind the dashboard's session (see lib/api.ts). */

/**
 * Browsers put an Origin on every POST and PUT. The SameSite=Lax session cookie
 * already stays home on cross-site requests; a foreign Origin is turned away all the same.
 */
export function isForeignOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const host = (request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "").split(",")[0]?.trim();
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

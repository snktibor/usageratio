/**
 * A `Set-Cookie` header value, for the route handlers that start a session
 * or a sign-in on their own response (lib/api.ts gives route handlers a
 * read-only cookie jar). The name and value are sent as they are: callers
 * only ever pass fixed names and base64url values.
 */
export interface SetCookieOptions {
  maxAge: number;
  secure: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict";
}

export function serializeCookie(name: string, value: string, options: SetCookieOptions): string {
  const parts = [`${name}=${value}`, "Path=/", `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/** The header that makes the browser drop `name`. */
export function clearCookie(name: string, secure: boolean): string {
  return serializeCookie(name, "", { maxAge: 0, secure });
}

/**
 * A cookie name for this connection: `__Host-` over HTTPS, which makes the
 * browser refuse the cookie unless it is Secure, host-only (no Domain) and on
 * `/`, so neither a sibling host (demo., the landing) nor a plain-http page
 * can set or read it. Plain http (local development) cannot use the prefix.
 */
export function hostCookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}

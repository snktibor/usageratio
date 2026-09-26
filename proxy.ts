import { randomBytes, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import createMiddleware from "next-intl/middleware";
import { routing } from "./i18n/routing";
import { buildCsp, CSP_REPORT_TO_GROUP, CSP_REPORT_URI, cspModeFromEnv } from "./lib/csp";

const intlMiddleware = createMiddleware(routing);

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Mirrors lib/request-context.ts's isHttpsRequest, reading the request
 * directly instead of next/headers — proxy has no request scope for that
 * module to tap into, only the NextRequest itself.
 */
function isHttpsRequest(request: NextRequest): boolean {
  const override = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (override && TRUE_VALUES.has(override)) return true;
  if (override && FALSE_VALUES.has(override)) return false;
  if (process.env.VERCEL) return true;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return proto === "https";
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** The platform's request id when it sent one (x-vercel-id, or a proxy's x-request-id); a fresh UUID otherwise. */
function requestIdFor(headers: Headers): string {
  for (const name of ["x-vercel-id", "x-request-id"]) {
    const value = headers.get(name)?.trim();
    if (value && REQUEST_ID_PATTERN.test(value)) return value;
  }
  return randomUUID();
}

/**
 * Sets request headers so next-intl's middleware (which copies `request.headers`
 * when it builds its own `NextResponse.next`/`rewrite`) and Next's renderer (which
 * extracts the nonce from the request's `content-security-policy(-report-only)`
 * header) both see them. `NextRequest.headers` is mutable in this Next version,
 * but falls back to constructing a fresh `NextRequest` in case that ever changes.
 */
function withRequestHeaders(request: NextRequest, entries: Record<string, string>): NextRequest {
  try {
    for (const [name, value] of Object.entries(entries)) request.headers.set(name, value);
    return request;
  } catch {
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(entries)) headers.set(name, value);
    return new NextRequest(request, { headers });
  }
}

export default async function proxy(request: NextRequest): Promise<NextResponse> {
  const nonce = randomBytes(16).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const csp = buildCsp({
    nonce,
    mode: cspModeFromEnv(process.env.SECURITY_CSP),
    isDev,
    https: isHttpsRequest(request),
  });

  const nextRequest = withRequestHeaders(request, {
    "x-nonce": nonce,
    ...(csp && { [csp.headerName]: csp.value }),
  });

  const response = (await intlMiddleware(nextRequest)) ?? NextResponse.next();

  if (csp) {
    response.headers.set(csp.headerName, csp.value);
    response.headers.set("Reporting-Endpoints", `${CSP_REPORT_TO_GROUP}="${CSP_REPORT_URI}"`);
  }
  if (!response.headers.get("x-request-id")) {
    response.headers.set("x-request-id", requestIdFor(request.headers));
  }

  return response;
}

export const config = {
  // Matches every route that needs locale handling, including locale-prefixed
  // ones — the catch-all below already covers those, so no per-locale entry
  // is needed here when a new language is added.
  // Excludes API endpoints, static files, etc.
  matcher: ["/", "/((?!api|_next|_vercel|.*\\..*).*)"],
};

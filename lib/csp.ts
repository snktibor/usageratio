/**
 * The app's Content Security Policy. Pure and framework-free so it can be
 * unit tested directly: `proxy.ts` supplies the per-request nonce and the
 * environment (dev vs. prod, http vs. https) and sets the returned header.
 *
 * Scripts get 'strict-dynamic' plus the nonce (dev also needs 'unsafe-eval':
 * React's server-error reconstruction relies on it). <style> elements get the
 * nonce through `style-src-elem`; `style-src` itself keeps 'unsafe-inline' as
 * a fallback for browsers that predate the fine-grained style-src-* directives
 * (which, per the CSP3 fallback rules, ignore `style-src` once `style-src-elem`
 * is present). `style-src-attr` allows inline `style={{}}` attributes — React
 * has no way to put a nonce on those, but an attribute cannot run script, and
 * `img-src`/`connect-src 'self'` close off exfiltrating data through them.
 *
 * Violations are reported both ways browsers understand: the legacy
 * `report-uri` directive (no extra header needed) and `report-to`, paired
 * with the `Reporting-Endpoints` header `proxy.ts` sets alongside this one.
 */

export type CspMode = "enforce" | "report" | "off";

export interface BuildCspOptions {
  /** Per-request nonce (proxy.ts: 16 random bytes, base64). */
  nonce: string;
  mode: CspMode;
  isDev: boolean;
  /** Whether the request arrived over HTTPS — adds `upgrade-insecure-requests`. */
  https: boolean;
}

export type CspHeaderName = "Content-Security-Policy" | "Content-Security-Policy-Report-Only";

export interface CspHeader {
  headerName: CspHeaderName;
  value: string;
}

/** The `report-to` group name and its matching path, shared with `Reporting-Endpoints` in proxy.ts. */
export const CSP_REPORT_TO_GROUP = "csp-endpoint";
export const CSP_REPORT_URI = "/api/csp-report";

export function buildCsp({ nonce, mode, isDev, https }: BuildCspOptions): CspHeader | null {
  if (mode === "off") return null;

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    `style-src-elem 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-inline'" : ""}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "manifest-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    ...(https ? ["upgrade-insecure-requests"] : []),
    `report-uri ${CSP_REPORT_URI}`,
    `report-to ${CSP_REPORT_TO_GROUP}`,
  ];

  // A nonce only means anything under dynamic rendering, so a report-only
  // policy in development never blocks the debugging tools React relies on,
  // while still surfacing violations at /api/csp-report.
  const headerName: CspHeaderName =
    isDev || mode === "report" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";

  return { headerName, value: directives.join("; ") };
}

function isCspMode(value: string): value is CspMode {
  return value === "enforce" || value === "report" || value === "off";
}

/** `SECURITY_CSP` (enforce | report | off), defaulting to enforce for an unset or unrecognized value. */
export function cspModeFromEnv(raw: string | undefined): CspMode {
  const normalized = raw?.trim().toLowerCase();
  return normalized && isCspMode(normalized) ? normalized : "enforce";
}

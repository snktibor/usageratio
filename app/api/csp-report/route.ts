import { apiError, withApiHandler } from "@/lib/api";
import { log } from "@/lib/log";
import { clientIp } from "@/lib/request-context";

/**
 * POST /api/csp-report — where the browser sends a Content-Security-Policy
 * violation (the `report-uri`/`report-to` directives in proxy.ts's policy).
 * Unauthenticated by nature: the browser sends these on its own, with no
 * session and often no Origin. Never touches the store; every violation is
 * only ever logged.
 *
 * Accepts the two shapes browsers actually send:
 *   - `application/csp-report` (the legacy, still the most common): a single
 *     `{ "csp-report": { "document-uri", "violated-directive", "blocked-uri", … } }`.
 *   - `application/reports+json` (the Reporting API, `report-to`): an array
 *     of `{ "type": "csp-violation", "body": { "documentURL", "violatedDirective", … } }`.
 *
 * Each violation is logged as `csp.violation { documentUri, violatedDirective,
 * blockedUri, sample }`; anything else in the payload is dropped.
 *
 * 204 always (nothing meaningful to return to a beacon the browser doesn't
 * read) · 413 over 8 KiB · 415 any other Content-Type · 429 over 20/minute
 * from one IP (a tiny in-process counter — this single endpoint is not worth
 * a shared/store-backed limiter, and it must keep working even if the store
 * is down or not configured).
 */

const MAX_BODY_BYTES = 8_192;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
// Bounded so a flood of spoofed IPs cannot grow this without limit; cleared
// wholesale rather than tracked per-entry, since it is a soft, best-effort cap.
const RATE_LIMIT_MAX_BUCKETS = 5_000;

const CSP_REPORT_CONTENT_TYPE = /^application\/csp-report\s*(;.*)?$/i;
const REPORTS_JSON_CONTENT_TYPE = /^application\/reports\+json\s*(;.*)?$/i;

const buckets = new Map<string, { count: number; windowStart: number }>();

/** True once `ip` has made more than RATE_LIMIT_MAX requests in the current window. */
function isRateLimited(ip: string, now: number): boolean {
  if (buckets.size > RATE_LIMIT_MAX_BUCKETS) buckets.clear();
  const bucket = buckets.get(ip);
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    buckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT_MAX;
}

type BodyResult = { ok: true; text: string } | { ok: false; response: Response };

/** The body as text, refusing anything over `maxBytes` — from Content-Length, then again while reading. */
async function readCappedText(request: Request, maxBytes: number): Promise<BodyResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, response: apiError("payload_too_large", 413, { maxBytes }) };
  }
  if (!request.body) return { ok: true, text: "" };

  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: apiError("payload_too_large", 413, { maxBytes }) };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, response: apiError("unreadable_body", 400) };
  }
  return { ok: true, text: new TextDecoder("utf-8").decode(Buffer.concat(chunks)) };
}

interface Violation {
  documentUri?: string;
  violatedDirective?: string;
  blockedUri?: string;
  sample?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** `application/csp-report`: `{ "csp-report": { "document-uri", "violated-directive", … } }`. */
function fromLegacyReport(parsed: unknown): Violation[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const report = (parsed as Record<string, unknown>)["csp-report"];
  if (typeof report !== "object" || report === null) return [];
  const r = report as Record<string, unknown>;
  return [
    {
      documentUri: asString(r["document-uri"]),
      violatedDirective: asString(r["violated-directive"] ?? r["effective-directive"]),
      blockedUri: asString(r["blocked-uri"]),
      sample: asString(r["script-sample"]),
    },
  ];
}

/** `application/reports+json`: an array of `{ "type": "csp-violation", "body": { "documentURL", … } }`. */
function fromReportingApi(parsed: unknown): Violation[] {
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry): Violation[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const { type, body } = entry as Record<string, unknown>;
    if (type !== "csp-violation" || typeof body !== "object" || body === null) return [];
    const b = body as Record<string, unknown>;
    return [
      {
        documentUri: asString(b.documentURL),
        violatedDirective: asString(b.violatedDirective ?? b.effectiveDirective),
        blockedUri: asString(b.blockedURL),
        sample: asString(b.sample),
      },
    ];
  });
}

export const POST = withApiHandler("api/csp-report", async ({ request }) => {
  const contentType = (request.headers.get("content-type") ?? "").trim();
  const isLegacy = CSP_REPORT_CONTENT_TYPE.test(contentType);
  const isReportingApi = REPORTS_JSON_CONTENT_TYPE.test(contentType);
  if (!isLegacy && !isReportingApi) return apiError("unsupported_media_type", 415);

  if (isRateLimited(await clientIp(), Date.now())) {
    return apiError("rate_limited", 429, { retryAfterSeconds: 60 });
  }

  const body = await readCappedText(request, MAX_BODY_BYTES);
  if (!body.ok) return body.response;

  try {
    const parsed: unknown = body.text ? JSON.parse(body.text) : null;
    const violations = isLegacy ? fromLegacyReport(parsed) : fromReportingApi(parsed);
    for (const violation of violations) log.warn("csp.violation", { ...violation });
  } catch (error) {
    // A malformed beacon must not fail the request — there is no client here to retry sensibly.
    log.warn("csp.violation.unparsable", { err: error });
  }

  return new Response(null, { status: 204 });
});

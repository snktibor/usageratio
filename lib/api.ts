import { errors as upstash } from "@upstash/redis";
import { isAuthenticated } from "@/lib/auth";
import { reportError } from "@/lib/error-reporter";
import { isForeignOrigin } from "@/lib/http";
import { log } from "@/lib/log";
import { StorageNotConfiguredError } from "@/lib/redis";
import { type CookieJar, currentRequest, currentRequestId, requestIdFrom, runWithRequest } from "@/lib/request-context";
import { safeEqual } from "@/lib/security";

/**
 * What every route handler shares: the JSON error envelope, the body reader
 * with its size cap, the three guards (session, same origin, bearer token),
 * and the wrapper that opens the request context and turns an exception into
 * a 503 or 500 with the request id in it.
 *
 * Errors are `{ "error": <code>, "requestId": <id>, ...extra }` with
 * `Cache-Control: no-store`. The codes are stable (the clients and the UI
 * match on them); the UI translates them.
 */

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "unsupported_media_type"
  | "payload_too_large"
  | "unreadable_body"
  | "invalid_json"
  | "invalid_payload"
  | "invalid_token"
  | "rate_limited"
  | "server_misconfigured"
  | "encryption_key_missing"
  | "storage_not_configured"
  | "storage_unavailable"
  | "internal_error"
  | "sudo_required"
  | "sudo_invalid"
  | "too_many_groups"
  | "too_many_providers"
  | "too_many_machines"
  | "machine_mismatch"
  | "no_token"
  | "token_unreadable"
  | "groups_have_reports"
  | "not_found"
  | "demo_read_only"
  | "machine_exists"
  | "group_exists"
  | "group_has_events"
  | "provider_has_events";

export const MIN_API_TOKEN_LENGTH = 16;

export function json(body: Record<string, unknown>, status: number, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/**
 * The error envelope. `extra` goes into the body, except `scheme: "bearer"`,
 * which only adds the WWW-Authenticate challenge to a 401. A 503 gets
 * Retry-After 60; a 429 gets its `retryAfterSeconds`.
 */
export function apiError(
  code: ApiErrorCode,
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  const { scheme, ...body } = extra;
  const responseHeaders = { ...headers };
  if (status === 503 && !responseHeaders["Retry-After"]) responseHeaders["Retry-After"] = "60";
  if (status === 429 && typeof body.retryAfterSeconds === "number" && !responseHeaders["Retry-After"]) {
    responseHeaders["Retry-After"] = String(Math.max(1, Math.ceil(body.retryAfterSeconds)));
  }
  if (status === 401 && scheme === "bearer") responseHeaders["WWW-Authenticate"] = 'Bearer realm="usage"';
  const requestId = currentRequestId();
  return json({ error: code, ...(requestId && { requestId }), ...body }, status, responseHeaders);
}

export type BodyResult = { ok: true; value: unknown } | { ok: false; response: Response };

const JSON_CONTENT_TYPE = /^application\/json\s*(;.*)?$/i;

/**
 * The request body as parsed JSON, or the response that refuses it: 415 for a
 * wrong Content-Type (when required), 413 for a body over `maxBytes` — from
 * Content-Length before a byte is read, and again while reading, so a body
 * that lies about its length is cut off at the cap — 400 for anything that is
 * not JSON. A UTF-8 byte order mark (Windows PowerShell 5.1 sends one) is dropped.
 */
export async function readJsonBody(
  request: Request,
  options: { maxBytes: number; requireJsonContentType?: boolean },
): Promise<BodyResult> {
  const { maxBytes, requireJsonContentType = true } = options;
  const refuse = (response: Response): BodyResult => ({ ok: false, response });

  if (requireJsonContentType && !JSON_CONTENT_TYPE.test((request.headers.get("content-type") ?? "").trim())) {
    return refuse(apiError("unsupported_media_type", 415));
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return refuse(apiError("payload_too_large", 413, { maxBytes }));
  }
  if (!request.body) return refuse(apiError("invalid_json", 400));

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
        return refuse(apiError("payload_too_large", 413, { maxBytes }));
      }
      chunks.push(value);
    }
  } catch {
    return refuse(apiError("unreadable_body", 400));
  }

  let text = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return refuse(apiError("invalid_json", 400));
  }
}

/** 401 unless the dashboard's PIN session is live. Throws when the store cannot be asked. */
export async function requireSession(): Promise<Response | null> {
  return (await isAuthenticated()) ? null : apiError("unauthorized", 401);
}

/** 403 for a request a foreign origin sent (lib/http.ts). */
export function requireSameOrigin(request: Request): Response | null {
  return isForeignOrigin(request) ? apiError("forbidden_origin", 403) : null;
}

/**
 * The clients' bearer token check. A token shorter than 16 characters is a
 * deployment mistake, answered with 500 rather than letting anything in.
 */
export function requireBearer(request: Request): Response | { tokenId: "master" } {
  const expected = process.env.USAGE_API_TOKEN?.trim();
  if (!expected || expected.length < MIN_API_TOKEN_LENGTH) {
    log.error("api.token_misconfigured", { minLength: MIN_API_TOKEN_LENGTH });
    return apiError("server_misconfigured", 500);
  }
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!bearer?.[1] || !safeEqual(bearer[1], expected)) {
    return apiError("unauthorized", 401, { scheme: "bearer" });
  }
  return { tokenId: "master" };
}

/** A store that did not answer: the SDK's own errors, and the network failures under them. */
function isStorageUnavailable(error: unknown): boolean {
  if (error instanceof upstash.UpstashError) return true;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

/** `name=value` pairs of a `Cookie` request header, percent-decoded where that succeeds. */
function parseCookieHeader(header: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    const raw = pair.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(raw));
    } catch {
      cookies.set(name, raw);
    }
  }
  return cookies;
}

function cookiesNotWritable(action: "set" | "delete"): never {
  throw new Error(`route handlers cannot ${action} cookies here`);
}

/**
 * A read-only cookie jar parsed straight from the request's own `Cookie`
 * header: every route this wraps only ever reads a session (`requireSession`),
 * never sets one, so `set`/`delete` throw rather than silently doing nothing.
 */
function requestCookieJar(request: Request): CookieJar {
  const parsed = parseCookieHeader(request.headers.get("cookie") ?? "");
  return {
    get: (name) => {
      const value = parsed.get(name);
      return value === undefined ? undefined : { value };
    },
    set: () => cookiesNotWritable("set"),
    delete: () => cookiesNotWritable("delete"),
  };
}

function withRequestId(response: Response, requestId: string): Response {
  // A Response.redirect() has immutable headers: copy before adding the id.
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export interface ApiContext {
  request: Request;
  requestId: string;
  url: URL;
}

/**
 * Wraps a route handler: opens the request context (id, route, headers, a
 * cookie jar), times the call, logs it, echoes the id in `x-request-id`, and
 * maps what the handler throws — a store that is not connected or not
 * answering is a 503 the clients retry, anything else a 500 that is logged
 * with its stack.
 *
 * The cookie jar is read-only, parsed from this request's own `Cookie`
 * header — these routes only ever read a session (see lib/request-context.ts
 * `currentCookies`), so this needs no `next/headers` request scope and is
 * exercised the same way in a test as in production. Nesting rule: if an
 * outer `runWithRequest` context already carries a jar (tests that wrap the
 * call themselves, e.g. to inject a writable fake one), that outer jar and
 * its headers are kept as they are, rather than replaced by a fresh one
 * built from this request.
 */
export function withApiHandler(
  name: string,
  handler: (context: ApiContext) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) => {
    const requestId = requestIdFrom(request.headers);
    const started = performance.now();
    const outer = currentRequest();
    const context =
      outer?.cookies !== undefined
        ? { ...outer, requestId, route: name }
        : { requestId, route: name, headers: request.headers, cookies: requestCookieJar(request) };
    return runWithRequest(context, async () => {
      let response: Response;
      try {
        response = await handler({ request, requestId, url: new URL(request.url) });
      } catch (error) {
        if (error instanceof StorageNotConfiguredError) {
          log.error("storage.not_configured", { route: name, err: error });
          response = apiError("storage_not_configured", 503);
        } else if (isStorageUnavailable(error)) {
          log.error("storage.unavailable", { route: name, err: error });
          response = apiError("storage_unavailable", 503);
        } else {
          log.error("api.unhandled", { route: name, err: error });
          // A bug, not an outage: it also goes to the error webhook (ERROR_WEBHOOK_URL), which never throws.
          await reportError(error, { path: new URL(request.url).pathname, requestId, route: name });
          response = apiError("internal_error", 500);
        }
      }
      const durationMs = Math.round((performance.now() - started) * 10) / 10;
      log.info("api.request", { route: name, method: request.method, status: response.status, durationMs });
      return withRequestId(response, requestId);
    });
  };
}

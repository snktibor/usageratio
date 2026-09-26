import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { after } from "next/server";
import { log, setRequestIdSource } from "@/lib/log";

/**
 * The request the code is currently serving, reachable without threading it
 * through every call: its id (for the logs and the error envelopes), its
 * route, and — injectable, for tests — its headers and cookie store.
 *
 * Next's own `headers()` / `cookies()` throw outside a request scope
 * (node_modules/next/dist/server/app-render/work-unit-async-storage.external.js),
 * so anything that reads them can only be exercised through this seam.
 * `withApiHandler` (lib/api.ts) opens a context for every route handler;
 * tests open one with `runWithRequest` and their own `Headers` / `CookieJar`.
 */

export interface CookieOptions {
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
  path?: string;
  maxAge?: number;
  expires?: Date;
}

/** The subset of Next's cookie store the app uses. */
export interface CookieJar {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options?: CookieOptions): void;
  delete(name: string): void;
}

export interface RequestContext {
  requestId: string;
  route: string;
  headers?: Headers;
  cookies?: CookieJar;
  /** Tests: `defer` runs its task at once instead of after the response. */
  deferInline?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `context` as the current request; nested calls see the innermost. */
export function runWithRequest<T>(context: RequestContext, fn: () => Promise<T> | T): Promise<T> {
  return storage.run(context, async () => fn());
}

export function currentRequest(): RequestContext | null {
  return storage.getStore() ?? null;
}

export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

// Every log line written inside a request carries its id (lib/log.ts cannot import this module).
setRequestIdSource(currentRequestId);

/** The incoming request's headers: the context's when injected, Next's otherwise. */
export async function currentHeaders(): Promise<Headers> {
  const context = storage.getStore();
  if (context?.headers) return context.headers;
  return headers();
}

/** The request's cookie store: the context's when injected, Next's otherwise. */
export async function currentCookies(): Promise<CookieJar> {
  const context = storage.getStore();
  if (context?.cookies) return context.cookies;
  const store = await cookies();
  return {
    get: (name) => store.get(name),
    set: (name, value, options) => {
      store.set(name, value, options);
    },
    delete: (name) => {
      store.delete(name);
    },
  };
}

const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Whether the forwarding headers can be believed. On Vercel the platform sets
 * them and a client cannot spoof them; a self-hosted deployment says so with
 * TRUST_PROXY (default: trusted, as behind any sane reverse proxy).
 */
function trustProxy(): boolean {
  if (process.env.VERCEL) return true;
  const raw = process.env.TRUST_PROXY?.trim().toLowerCase();
  return !(raw && FALSE_VALUES.has(raw));
}

/** The caller's address for rate limiting and the audit trail; "unknown" when it cannot be trusted. */
export async function clientIp(): Promise<string> {
  if (!trustProxy()) return "unknown";
  const h = await currentHeaders();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip")?.trim() || "unknown";
}

/**
 * Whether the session cookie may carry the Secure flag. COOKIE_SECURE=true|false
 * decides outright (self-hosting); otherwise Vercel is HTTPS, and a proxy says so
 * with x-forwarded-proto.
 */
export async function isHttpsRequest(): Promise<boolean> {
  const override = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (override && TRUE_VALUES.has(override)) return true;
  if (override && FALSE_VALUES.has(override)) return false;
  if (process.env.VERCEL) return true;
  const proto = (await currentHeaders()).get("x-forwarded-proto")?.split(",")[0]?.trim();
  return proto === "https";
}

const pending = new Set<Promise<void>>();

/**
 * Work that must not delay the response (log lines, a session refresh): after
 * the response inside a Next request (`after()` from next/server, which runs
 * in Route Handlers, Server Functions and Server Components), at once — but
 * still without throwing — in tests and outside a request scope.
 */
export function defer(task: () => Promise<void> | void): void {
  const run = async (): Promise<void> => {
    try {
      await task();
    } catch (error) {
      log.error("defer.failed", { err: error });
    }
  };
  if (!storage.getStore()?.deferInline) {
    try {
      after(run);
      return;
    } catch {
      // `after` throws outside a request scope (E468): fall through and run inline.
    }
  }
  const promise = run().finally(() => pending.delete(promise));
  pending.add(promise);
}

/** Tests: waits for every task `defer` ran inline. */
export async function flushDeferred(): Promise<void> {
  await Promise.all([...pending]);
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** The platform's request id when it sent one (x-vercel-id, or a proxy's x-request-id); a fresh UUID otherwise. */
export function requestIdFrom(requestHeaders: Headers): string {
  for (const name of ["x-vercel-id", "x-request-id"]) {
    const value = requestHeaders.get(name)?.trim();
    if (value && REQUEST_ID_PATTERN.test(value)) return value;
  }
  return randomUUID();
}

import { version } from "@/package.json";

/**
 * Where the app sends a copy of an unexpected error, beyond the log line
 * (lib/log.ts already writes one wherever `reportError` is called). Never
 * throws and never delays the request it is called from: a broken reporter
 * must not become a second outage.
 *
 * The default reporter is a zero-dependency webhook, enabled by setting
 * ERROR_WEBHOOK_URL; with nothing set it does nothing. `setErrorReporter`
 * replaces it (Sentry, a different webhook shape, …) without touching the
 * call sites.
 */

export type ErrorReporter = (error: unknown, context: Record<string, unknown>) => Promise<void> | void;

const WEBHOOK_TIMEOUT_MS = 3000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorDigest(error: unknown): string | null {
  return typeof error === "object" && error !== null && "digest" in error
    ? String((error as { digest: unknown }).digest)
    : null;
}

/** POSTs `{ message, digest, path, requestId, version, commit }` to ERROR_WEBHOOK_URL; a no-op without it. */
export async function webhookErrorReporter(error: unknown, context: Record<string, unknown>): Promise<void> {
  const url = process.env.ERROR_WEBHOOK_URL?.trim();
  if (!url) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: errorMessage(error),
        digest: errorDigest(error),
        path: typeof context.path === "string" ? context.path : null,
        requestId: typeof context.requestId === "string" ? context.requestId : null,
        version,
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      }),
      signal: controller.signal,
    });
  } catch {
    // A broken or slow webhook must never affect the request that failed.
  } finally {
    clearTimeout(timer);
  }
}

let reporter: ErrorReporter = webhookErrorReporter;

/** Replaces the reporter `reportError` calls (tests, or a real APM/webhook integration). */
export function setErrorReporter(fn: ErrorReporter): void {
  reporter = fn;
}

/** Back to the built-in webhook reporter; mainly for tests to undo `setErrorReporter`. */
export function resetErrorReporter(): void {
  reporter = webhookErrorReporter;
}

/** Reports `error`; swallows anything the reporter throws or rejects with. */
export async function reportError(error: unknown, context: Record<string, unknown> = {}): Promise<void> {
  try {
    await reporter(error, context);
  } catch {
    // Never let a reporting failure become a second error.
  }
}

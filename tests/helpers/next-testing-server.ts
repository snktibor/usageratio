import { AsyncLocalStorage } from "node:async_hooks";

/**
 * `next/experimental/testing/server` pulls in Next's `app-render` internals,
 * which need `globalThis.AsyncLocalStorage` — normally set by Next's own
 * server bootstrap (`node-environment-baseline.js`), which never runs under
 * Vitest. Set before the (dynamic, so this runs first) import below, or
 * `unstable_doesMiddlewareMatch` throws "AsyncLocalStorage accessed in a
 * runtime where it is not available".
 */
if (typeof globalThis.AsyncLocalStorage !== "function") {
  (globalThis as unknown as { AsyncLocalStorage: typeof AsyncLocalStorage }).AsyncLocalStorage = AsyncLocalStorage;
}

export const { getRedirectUrl, getRewrittenUrl, isRewrite, unstable_doesMiddlewareMatch } = await import(
  "next/experimental/testing/server"
);

import type { Instrumentation } from "next";
import { isDemoMode } from "@/lib/demo/mode";
import { reportError } from "@/lib/error-reporter";
import { log } from "@/lib/log";
import { storageKind } from "@/lib/redis";
import { version } from "@/package.json";

/**
 * The Node.js half of instrumentation.ts: the start-up log line and the
 * server-side error report. Kept out of instrumentation.ts
 * itself, which Next also compiles for the Edge runtime.
 */

export async function registerNode(): Promise<void> {
  log.info("server.start", {
    version,
    node: process.version,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    storage: storageKind(),
    demo: isDemoMode(),
  });
  // No demo seed here: every cold start would pay for it, even one that only answers an uptime
  // monitor's /api/health. The pages and requireTenantSession() seed on first read instead.
}

export const onRequestErrorNode: Instrumentation.onRequestError = async (error, request, context) => {
  const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : undefined;
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const requestId = header("x-vercel-id") ?? header("x-request-id") ?? null;
  // Never the whole header map: it carries the session cookie and the bearer token. Nor the path:
  // it can name a group or a machine (/api/groups/{group}); the route's pattern says enough.
  log.error("request.error", {
    method: request.method,
    routePath: context.routePath,
    routeType: context.routeType,
    renderSource: context.renderSource,
    digest,
    requestId,
    err: error,
  });
  await reportError(error, { path: request.path, requestId });
};

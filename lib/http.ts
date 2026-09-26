import { apiError } from "@/lib/api";
import { log } from "@/lib/log";
import { StorageNotConfiguredError } from "@/lib/redis";

/** Shared by the JSON endpoints behind the dashboard's PIN session. */

export { json } from "@/lib/api";

/** 503 for a store that is not connected or does not answer. `what` names the caller in the log. */
export function storageFailure(error: unknown, what: string): Response {
  if (error instanceof StorageNotConfiguredError) {
    log.error("storage.not_configured", { what, err: error });
    return apiError("storage_not_configured", 503);
  }
  log.error("storage.unavailable", { what, err: error });
  return apiError("storage_unavailable", 503);
}

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

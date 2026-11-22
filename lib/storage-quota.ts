import { errors as upstash } from "@upstash/redis";
import { reportError } from "@/lib/error-reporter";
import { log } from "@/lib/log";

/**
 * The cost guard's app side: Upstash refusing commands because a plan limit or the monthly
 * budget is reached. The limits themselves are set where the money is (Upstash's budget, Vercel's
 * Spend Management: docs/self-hosting.md "Cost limits"); what the app does is say so on the error
 * webhook (ERROR_WEBHOOK_URL), which no other storage outage does: a store that stops answering
 * is a 503 the clients retry, and an outage that heals by itself is not worth a message, while
 * one that waits for the month to end, or for a higher budget, is.
 *
 * Upstash answers such a command with an error like `ERR max requests limit exceeded. Limit:
 * 10000, Usage: 10000` (also: daily requests, request size, bandwidth, storage, connections, the
 * budget); a pipeline wraps it as `Command 1 [ GET ] failed: ERR max …`.
 */

const QUOTA_MESSAGE = /\b(limit|quota|budget)\b.*\bexceeded\b|\bexceeded\b.*\b(limit|quota|budget)\b/i;

/** At most one message per process this often: every request fails the same way until it is fixed. */
export const STORAGE_QUOTA_REPORT_INTERVAL_MS = 60 * 60 * 1000;

let lastReportedAt: number | null = null;

/** Whether `error` is Upstash refusing a command over a plan limit or the budget. */
export function isStorageQuotaError(error: unknown): error is Error {
  return error instanceof upstash.UpstashError && QUOTA_MESSAGE.test(error.message);
}

/**
 * Logs `storage.quota_exceeded` and, once per `STORAGE_QUOTA_REPORT_INTERVAL_MS`, reports it
 * to the error webhook. Never throws (`reportError` does not).
 */
export async function reportStorageQuota(
  error: Error,
  context: Record<string, unknown>,
  now: number = Date.now(),
): Promise<void> {
  log.error("storage.quota_exceeded", { ...context, err: error });
  if (lastReportedAt !== null && now - lastReportedAt < STORAGE_QUOTA_REPORT_INTERVAL_MS) return;
  lastReportedAt = now;
  await reportError(
    new Error(`Upstash Redis refused a command over a plan limit or budget: ${error.message}`),
    context,
  );
}

/** Forgets the last report, so the next one goes out (tests). */
export function resetStorageQuotaReportsForTests(): void {
  lastReportedAt = null;
}

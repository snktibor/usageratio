import { errors as upstash } from "@upstash/redis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetErrorReporter, setErrorReporter } from "@/lib/error-reporter";
import {
  isStorageQuotaError,
  reportStorageQuota,
  resetStorageQuotaReportsForTests,
  STORAGE_QUOTA_REPORT_INTERVAL_MS,
} from "@/lib/storage-quota";

const LIMIT = new upstash.UpstashError("ERR max requests limit exceeded. Limit: 10000, Usage: 10000");

describe("isStorageQuotaError", () => {
  it("recognizes Upstash's limit and budget refusals, a pipeline's wrapped ones too", () => {
    for (const message of [
      "ERR max requests limit exceeded. Limit: 500000, Usage: 500000",
      "ERR max daily request limit exceeded",
      "ERR max request size exceeded. Limit: 1048576 bytes",
      "ERR max monthly bandwidth limit exceeded",
      "ERR max concurrent connections exceeded, connection limit: 100",
      "ERR DB capacity quota exceeded",
      "ERR monthly budget exceeded",
      "Command 1 [ GET ] failed: ERR max requests limit exceeded. Limit: 10000, Usage: 10000",
    ]) {
      expect(isStorageQuotaError(new upstash.UpstashError(message)), message).toBe(true);
    }
  });

  it("leaves every other failure alone", () => {
    expect(isStorageQuotaError(new upstash.UpstashError("WRONGTYPE Operation against a key"))).toBe(false);
    expect(isStorageQuotaError(new upstash.UpstashError("ERR injected failure for GET"))).toBe(false);
    // The words alone are not enough: it has to be Upstash saying it.
    expect(isStorageQuotaError(new Error("ERR max requests limit exceeded"))).toBe(false);
    expect(isStorageQuotaError("ERR max requests limit exceeded")).toBe(false);
    expect(isStorageQuotaError(null)).toBe(false);
  });
});

describe("reportStorageQuota", () => {
  const reporter = vi.fn();

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setErrorReporter(reporter);
  });

  afterEach(() => {
    resetErrorReporter();
    resetStorageQuotaReportsForTests();
    reporter.mockReset();
    vi.restoreAllMocks();
  });

  it("reports once an hour, and logs every time", async () => {
    const now = 1_700_000_000_000;
    await reportStorageQuota(LIMIT, { route: "api/usage", requestId: "r1" }, now);
    await reportStorageQuota(LIMIT, { route: "api/usage" }, now + 1000);
    await reportStorageQuota(LIMIT, { route: "api/usage" }, now + STORAGE_QUOTA_REPORT_INTERVAL_MS - 1);
    expect(reporter).toHaveBeenCalledTimes(1);
    const [error, context] = reporter.mock.calls[0]!;
    expect((error as Error).message).toBe(
      "Upstash Redis refused a command over a plan limit or budget: ERR max requests limit exceeded. Limit: 10000, Usage: 10000",
    );
    expect(context).toEqual({ route: "api/usage", requestId: "r1" });

    await reportStorageQuota(LIMIT, { route: "housekeeping" }, now + STORAGE_QUOTA_REPORT_INTERVAL_MS);
    expect(reporter).toHaveBeenCalledTimes(2);

    const logged = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    expect(logged.filter((line) => line.includes("storage.quota_exceeded"))).toHaveLength(4);
  });

  it("never throws, even when the reporter does", async () => {
    setErrorReporter(() => {
      throw new Error("webhook down");
    });
    await expect(reportStorageQuota(LIMIT, {})).resolves.toBeUndefined();
  });
});

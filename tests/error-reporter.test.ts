import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportError, resetErrorReporter, setErrorReporter, webhookErrorReporter } from "@/lib/error-reporter";
import { version } from "@/package.json";

describe("reportError / the built-in webhook reporter", () => {
  beforeEach(() => {
    vi.stubEnv("ERROR_WEBHOOK_URL", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetErrorReporter();
  });

  it("does nothing without ERROR_WEBHOOK_URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await reportError(new Error("boom"), { requestId: "r1" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("posts message, digest, path, requestId, version and commit to the webhook", async () => {
    vi.stubEnv("ERROR_WEBHOOK_URL", "https://example.test/hook");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abcdef1234567890");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const error = Object.assign(new Error("boom"), { digest: "E123" });
    await reportError(error, { path: "/api/usage", requestId: "req-9" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://example.test/hook");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      message: "boom",
      digest: "E123",
      path: "/api/usage",
      requestId: "req-9",
      version,
      commit: "abcdef1",
    });
  });

  it("sends null for digest, path and requestId when none are known", async () => {
    vi.stubEnv("ERROR_WEBHOOK_URL", "https://example.test/hook");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await reportError(new Error("plain"));
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ digest: null, path: null, requestId: null });
  });

  it("stringifies a non-Error value as the message", async () => {
    vi.stubEnv("ERROR_WEBHOOK_URL", "https://example.test/hook");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await reportError("just a string");
    const [, init] = fetchSpy.mock.calls[0]!;
    expect(JSON.parse(String(init?.body)).message).toBe("just a string");
  });

  it("never throws when the webhook rejects", async () => {
    vi.stubEnv("ERROR_WEBHOOK_URL", "https://example.test/hook");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    await expect(reportError(new Error("boom"))).resolves.toBeUndefined();
  });

  it("gives up after 3 seconds, aborting the request", async () => {
    vi.useFakeTimers();
    vi.stubEnv("ERROR_WEBHOOK_URL", "https://example.test/hook");
    let aborted = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = (init as RequestInit)?.signal;
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const settled = reportError(new Error("slow"));
    await vi.advanceTimersByTimeAsync(3000);
    await settled;
    expect(aborted).toBe(true);
  });

  it("never throws when setErrorReporter's replacement throws", async () => {
    setErrorReporter(() => {
      throw new Error("a bad reporter");
    });
    await expect(reportError(new Error("boom"))).resolves.toBeUndefined();
  });

  it("setErrorReporter replaces the reporter reportError calls; resetErrorReporter restores the webhook", async () => {
    const custom = vi.fn();
    setErrorReporter(custom);
    await reportError(new Error("via custom"), { path: "/x" });
    expect(custom).toHaveBeenCalledWith(expect.any(Error), { path: "/x" });

    resetErrorReporter();
    vi.stubEnv("ERROR_WEBHOOK_URL", "https://example.test/hook");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    await reportError(new Error("via webhook again"));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("webhookErrorReporter can be called directly", async () => {
    vi.stubEnv("ERROR_WEBHOOK_URL", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await webhookErrorReporter(new Error("boom"), {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

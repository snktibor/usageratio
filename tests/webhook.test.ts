import { afterEach, describe, expect, it, vi } from "vitest";
import { isAllowedWebhookUrl, MAX_WEBHOOK_URL_LENGTH, sendWebhook } from "@/lib/webhook";
import { version } from "@/package.json";

describe("isAllowedWebhookUrl", () => {
  afterEach(() => vi.restoreAllMocks());

  it("accepts a plain https URL", () => {
    expect(isAllowedWebhookUrl("https://hooks.example.com/services/x")).toBe(true);
  });

  it("rejects anything that is not https", () => {
    expect(isAllowedWebhookUrl("http://example.com")).toBe(false);
    expect(isAllowedWebhookUrl("ftp://example.com")).toBe(false);
    expect(isAllowedWebhookUrl("not a url")).toBe(false);
  });

  it("rejects credentials in the URL", () => {
    expect(isAllowedWebhookUrl("https://user:pass@example.com")).toBe(false);
    expect(isAllowedWebhookUrl("https://user@example.com")).toBe(false);
  });

  it("rejects localhost and .local/.internal names, case-insensitively", () => {
    expect(isAllowedWebhookUrl("https://localhost/x")).toBe(false);
    expect(isAllowedWebhookUrl("https://LOCALHOST/x")).toBe(false);
    expect(isAllowedWebhookUrl("https://foo.local/x")).toBe(false);
    expect(isAllowedWebhookUrl("https://foo.internal/x")).toBe(false);
    expect(isAllowedWebhookUrl("https://foo.LOCAL/x")).toBe(false);
  });

  it("rejects IPv4 loopback, RFC1918, link-local and CGNAT literals", () => {
    for (const url of [
      "https://127.0.0.1/x",
      "https://127.255.255.255/x",
      "https://10.0.0.5/x",
      "https://172.16.0.1/x",
      "https://172.31.255.255/x",
      "https://192.168.1.1/x",
      "https://169.254.1.1/x",
      "https://100.64.0.1/x",
      "https://100.100.0.1/x",
      "https://100.127.255.255/x",
    ]) {
      expect(isAllowedWebhookUrl(url), url).toBe(false);
    }
  });

  it("allows IPv4 addresses just outside the blocked ranges", () => {
    for (const url of [
      "https://172.15.255.255/x",
      "https://172.32.0.0/x",
      "https://100.63.255.255/x",
      "https://100.128.0.0/x",
    ]) {
      expect(isAllowedWebhookUrl(url), url).toBe(true);
    }
  });

  it("rejects obfuscated IPv4 literals the URL parser normalizes", () => {
    // 2130706433 and 0x7f000001 are both 127.0.0.1; 127.1 is 127.0.0.1 with trailing zeros implied.
    expect(isAllowedWebhookUrl("https://2130706433/")).toBe(false);
    expect(isAllowedWebhookUrl("https://0x7f000001/")).toBe(false);
    expect(isAllowedWebhookUrl("https://127.1/")).toBe(false);
  });

  it("rejects IPv6 loopback, link-local and unique-local literals", () => {
    for (const url of ["https://[::1]/x", "https://[fe80::1]/x", "https://[fc00::1]/x", "https://[fd12:3456::1]/x"]) {
      expect(isAllowedWebhookUrl(url), url).toBe(false);
    }
  });

  it("rejects an IPv4-mapped IPv6 literal that maps to a blocked address", () => {
    expect(isAllowedWebhookUrl("https://[::ffff:127.0.0.1]/x")).toBe(false);
  });

  it("allows a public IPv6 literal", () => {
    expect(isAllowedWebhookUrl("https://[2001:db8::1]/x")).toBe(true);
  });

  it("rejects a URL longer than MAX_WEBHOOK_URL_LENGTH", () => {
    const long = `https://example.com/${"x".repeat(MAX_WEBHOOK_URL_LENGTH)}`;
    expect(long.length).toBeGreaterThan(MAX_WEBHOOK_URL_LENGTH);
    expect(isAllowedWebhookUrl(long)).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isAllowedWebhookUrl("")).toBe(false);
  });
});

describe("sendWebhook", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("POSTs the payload as JSON with a usageratio User-Agent", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const result = await sendWebhook("https://example.com/hook", { hello: "world" });
    expect(result).toEqual({ ok: true, status: 200 });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(url).toBe("https://example.com/hook");
    expect(init?.method).toBe("POST");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toBe(`usageratio/${version}`);
    expect(JSON.parse(String(init?.body))).toEqual({ hello: "world" });
  });

  it("reports a non-2xx response as ok:false with its status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const result = await sendWebhook("https://example.com/hook", {});
    expect(result).toEqual({ ok: false, status: 404, error: "webhook responded 404" });
  });

  it("reports a network failure as ok:false with no status", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const result = await sendWebhook("https://example.com/hook", {});
    expect(result).toEqual({ ok: false, status: null, error: "network down" });
  });

  it("aborts after the timeout and reports failure", async () => {
    vi.useFakeTimers();
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

    const settled = sendWebhook("https://example.com/hook", {}, { timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await settled;
    expect(aborted).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("never retries: exactly one fetch call regardless of the outcome", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    await sendWebhook("https://example.com/hook", {});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

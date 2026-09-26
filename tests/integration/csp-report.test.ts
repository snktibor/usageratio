import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/csp-report/route";

function post(ip: string, contentType: string, body: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/csp-report", {
      method: "POST",
      headers: { "content-type": contentType, "x-forwarded-for": ip },
      body,
    }),
  );
}

describe("POST /api/csp-report", () => {
  it("204s a legacy application/csp-report violation, with no body", async () => {
    const response = await post(
      "203.0.113.10",
      "application/csp-report",
      JSON.stringify({
        "csp-report": {
          "document-uri": "https://example.com/",
          "violated-directive": "script-src",
          "blocked-uri": "https://evil.example/x.js",
          "script-sample": "alert(1)",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("204s a Reporting API application/reports+json violation", async () => {
    const response = await post(
      "203.0.113.11",
      "application/reports+json",
      JSON.stringify([
        {
          type: "csp-violation",
          body: {
            documentURL: "https://example.com/",
            violatedDirective: "style-src-elem",
            blockedURL: "https://evil.example/style.css",
          },
        },
      ]),
    );
    expect(response.status).toBe(204);
  });

  it("204s even a malformed body — there is no client here to retry sensibly", async () => {
    const response = await post("203.0.113.12", "application/csp-report", "not json");
    expect(response.status).toBe(204);
  });

  it("answers 415 for any Content-Type other than the two report formats", async () => {
    const response = await post("203.0.113.13", "application/json", "{}");
    expect(response.status).toBe(415);
    expect((await response.json()).error).toBe("unsupported_media_type");
  });

  it("answers 413 for a body over 8 KiB", async () => {
    const response = await post(
      "203.0.113.14",
      "application/csp-report",
      JSON.stringify({ "csp-report": { "script-sample": "x".repeat(9_000) } }),
    );
    expect(response.status).toBe(413);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.error).toBe("payload_too_large");
    expect(payload.maxBytes).toBe(8_192);
  });

  it("answers 429 after 20 reports/minute from the same IP, and Retry-After is set", async () => {
    const body = JSON.stringify({ "csp-report": { "document-uri": "https://example.com/" } });
    let last: Response = await post("203.0.113.99", "application/csp-report", body);
    for (let i = 0; i < 20; i++) last = await post("203.0.113.99", "application/csp-report", body);
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBe("60");
    expect((await last.json()).error).toBe("rate_limited");
  });

  it("keeps counting a different IP separately", async () => {
    const body = JSON.stringify({ "csp-report": { "document-uri": "https://example.com/" } });
    const response = await post("203.0.113.200", "application/csp-report", body);
    expect(response.status).toBe(204);
  });
});

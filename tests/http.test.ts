import { describe, expect, it } from "vitest";
import { isForeignOrigin } from "@/lib/http";

function request(headers: Record<string, string>): Request {
  return new Request("https://usageratio.example.com/api/settings", { method: "PUT", headers });
}

describe("isForeignOrigin", () => {
  it("accepts a request whose Origin matches the Host", () => {
    expect(isForeignOrigin(request({ host: "usageratio.example.com", origin: "https://usageratio.example.com" }))).toBe(
      false,
    );
  });

  it("accepts a request without an Origin (not a browser, or a same-origin GET)", () => {
    expect(isForeignOrigin(request({ host: "usageratio.example.com" }))).toBe(false);
  });

  it("prefers x-forwarded-host over Host behind a proxy", () => {
    const headers = {
      host: "internal-upstream:3000",
      "x-forwarded-host": "usageratio.example.com",
      origin: "https://usageratio.example.com",
    };
    expect(isForeignOrigin(request(headers))).toBe(false);
    expect(isForeignOrigin(request({ ...headers, origin: "https://internal-upstream:3000" }))).toBe(true);
  });

  it("turns away another site", () => {
    expect(isForeignOrigin(request({ host: "usageratio.example.com", origin: "https://evil.example" }))).toBe(true);
  });

  it("treats a port mismatch as foreign", () => {
    expect(isForeignOrigin(request({ host: "localhost:3000", origin: "http://localhost:3111" }))).toBe(true);
    expect(isForeignOrigin(request({ host: "localhost:3000", origin: "http://localhost:3000" }))).toBe(false);
  });

  it("treats an Origin that is not a URL as foreign", () => {
    expect(isForeignOrigin(request({ host: "usageratio.example.com", origin: "null" }))).toBe(true);
    expect(isForeignOrigin(request({ host: "usageratio.example.com", origin: "not a url" }))).toBe(true);
  });
});

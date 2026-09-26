import { describe, expect, it } from "vitest";
import { buildCsp, CSP_REPORT_TO_GROUP, CSP_REPORT_URI, cspModeFromEnv } from "@/lib/csp";

const NONCE = "dGVzdC1ub25jZS12YWx1ZQ==";

function directive(value: string, name: string): string | undefined {
  return value.split("; ").find((part) => part === name || part.startsWith(`${name} `));
}

describe("buildCsp", () => {
  it("never allows 'unsafe-inline' on script-src", () => {
    for (const isDev of [true, false]) {
      for (const mode of ["enforce", "report"] as const) {
        const csp = buildCsp({ nonce: NONCE, mode, isDev, https: false });
        expect(csp?.value).toBeDefined();
        expect(directive(csp!.value, "script-src")).not.toContain("'unsafe-inline'");
      }
    }
  });

  it("carries the nonce on script-src and style-src-elem, but not on style-src or style-src-attr", () => {
    const csp = buildCsp({ nonce: NONCE, mode: "enforce", isDev: false, https: false })!;
    expect(directive(csp.value, "script-src")).toContain(`'nonce-${NONCE}'`);
    expect(directive(csp.value, "style-src-elem")).toContain(`'nonce-${NONCE}'`);
    expect(directive(csp.value, "style-src")).not.toContain("nonce-");
    expect(directive(csp.value, "style-src-attr")).not.toContain("nonce-");
    // React's inline style={{}} attributes cannot carry a nonce.
    expect(directive(csp.value, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
  });

  it("relaxes script-src, style-src-elem and connect-src only in development", () => {
    const prod = buildCsp({ nonce: NONCE, mode: "enforce", isDev: false, https: false })!;
    const dev = buildCsp({ nonce: NONCE, mode: "enforce", isDev: true, https: false })!;

    expect(directive(prod.value, "script-src")).not.toContain("'unsafe-eval'");
    expect(directive(dev.value, "script-src")).toContain("'unsafe-eval'");

    expect(directive(prod.value, "style-src-elem")).not.toContain("'unsafe-inline'");
    expect(directive(dev.value, "style-src-elem")).toContain("'unsafe-inline'");

    expect(directive(prod.value, "connect-src")).toBe("connect-src 'self'");
    expect(directive(dev.value, "connect-src")).toBe("connect-src 'self' ws: wss:");
  });

  it("keeps 'strict-dynamic' on script-src in every mode", () => {
    for (const isDev of [true, false]) {
      const csp = buildCsp({ nonce: NONCE, mode: "enforce", isDev, https: false })!;
      expect(directive(csp.value, "script-src")).toContain("'strict-dynamic'");
    }
  });

  it("picks Content-Security-Policy for enforce in production, and Report-Only for report or development", () => {
    expect(buildCsp({ nonce: NONCE, mode: "enforce", isDev: false, https: false })?.headerName).toBe(
      "Content-Security-Policy",
    );
    expect(buildCsp({ nonce: NONCE, mode: "report", isDev: false, https: false })?.headerName).toBe(
      "Content-Security-Policy-Report-Only",
    );
    // Development is always report-only, even when SECURITY_CSP says enforce.
    expect(buildCsp({ nonce: NONCE, mode: "enforce", isDev: true, https: false })?.headerName).toBe(
      "Content-Security-Policy-Report-Only",
    );
  });

  it("returns null for mode 'off', in development too", () => {
    expect(buildCsp({ nonce: NONCE, mode: "off", isDev: false, https: false })).toBeNull();
    expect(buildCsp({ nonce: NONCE, mode: "off", isDev: true, https: true })).toBeNull();
  });

  it("adds upgrade-insecure-requests only over https", () => {
    const http = buildCsp({ nonce: NONCE, mode: "enforce", isDev: false, https: false })!;
    const https = buildCsp({ nonce: NONCE, mode: "enforce", isDev: false, https: true })!;
    expect(http.value).not.toContain("upgrade-insecure-requests");
    expect(https.value).toContain("upgrade-insecure-requests");
  });

  it("points report-uri and report-to at the same csp-report endpoint", () => {
    const csp = buildCsp({ nonce: NONCE, mode: "enforce", isDev: false, https: false })!;
    expect(directive(csp.value, "report-uri")).toBe(`report-uri ${CSP_REPORT_URI}`);
    expect(directive(csp.value, "report-to")).toBe(`report-to ${CSP_REPORT_TO_GROUP}`);
    expect(CSP_REPORT_URI).toBe("/api/csp-report");
  });

  it("locks down base-uri, object-src and frame-ancestors", () => {
    const csp = buildCsp({ nonce: NONCE, mode: "enforce", isDev: false, https: false })!;
    expect(directive(csp.value, "base-uri")).toBe("base-uri 'none'");
    expect(directive(csp.value, "object-src")).toBe("object-src 'none'");
    expect(directive(csp.value, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });
});

describe("cspModeFromEnv", () => {
  it("defaults to enforce for unset or unrecognized values", () => {
    expect(cspModeFromEnv(undefined)).toBe("enforce");
    expect(cspModeFromEnv("")).toBe("enforce");
    expect(cspModeFromEnv("nonsense")).toBe("enforce");
  });

  it("accepts report and off, case-insensitively and trimmed", () => {
    expect(cspModeFromEnv("report")).toBe("report");
    expect(cspModeFromEnv(" REPORT \n")).toBe("report");
    expect(cspModeFromEnv("off")).toBe("off");
    expect(cspModeFromEnv("OFF")).toBe("off");
  });
});

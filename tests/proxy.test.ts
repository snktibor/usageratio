import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import proxy, { config } from "@/proxy";
import { getRedirectUrl, isRewrite, unstable_doesMiddlewareMatch } from "./helpers/next-testing-server";

function cspHeader(response: Response): string | null {
  return response.headers.get("content-security-policy") ?? response.headers.get("content-security-policy-report-only");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy", () => {
  // i18n/routing.ts uses the default localePrefix mode ("always"): every
  // locale, including the default one, needs a URL prefix. "/" therefore
  // redirects to "/en"; "/en" is already the canonical URL and passes through.

  it("redirects '/' to the default locale, carrying a CSP header with a nonce", async () => {
    const response = await proxy(new NextRequest("http://localhost/"));
    expect(getRedirectUrl(response)).toBe("http://localhost/en");
    const header = cspHeader(response);
    expect(header).toBeTruthy();
    expect(header).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });

  it("passes '/en' straight through (already the canonical URL), still carrying the CSP header", async () => {
    const response = await proxy(new NextRequest("http://localhost/en"));
    expect(response.status).toBe(200);
    expect(getRedirectUrl(response)).toBeNull();
    expect(isRewrite(response)).toBe(false);
    const header = cspHeader(response);
    expect(header).toBeTruthy();
    expect(header).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
  });

  it("gives every request its own nonce", async () => {
    const nonceOf = (response: Response) => cspHeader(response)?.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
    const first = nonceOf(await proxy(new NextRequest("http://localhost/en")));
    const second = nonceOf(await proxy(new NextRequest("http://localhost/en")));
    expect(first).toBeTruthy();
    expect(first).not.toBe(second);
  });

  it("sets x-request-id when the request did not carry one, and keeps one that was already there", async () => {
    const fresh = await proxy(new NextRequest("http://localhost/en"));
    expect(fresh.headers.get("x-request-id")).toBeTruthy();

    const withId = await proxy(new NextRequest("http://localhost/en", { headers: { "x-request-id": "req-abc" } }));
    expect(withId.headers.get("x-request-id")).toBe("req-abc");
  });

  it("turns the CSP header off with SECURITY_CSP=off, without breaking the redirect", async () => {
    vi.stubEnv("SECURITY_CSP", "off");
    const response = await proxy(new NextRequest("http://localhost/"));
    expect(cspHeader(response)).toBeNull();
    expect(getRedirectUrl(response)).toBe("http://localhost/en");
  });

  it("matches the app's pages but not API routes or Next/Vercel internals", () => {
    expect(unstable_doesMiddlewareMatch({ config, url: "/" })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: "/setup" })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: "/en/setup" })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: "/api/usage" })).toBe(false);
    expect(unstable_doesMiddlewareMatch({ config, url: "/api/csp-report" })).toBe(false);
    expect(unstable_doesMiddlewareMatch({ config, url: "/_next/static/chunks/main.js" })).toBe(false);
    expect(unstable_doesMiddlewareMatch({ config, url: "/_vercel/insights/view" })).toBe(false);
    expect(unstable_doesMiddlewareMatch({ config, url: "/favicon.ico" })).toBe(false);
  });
});

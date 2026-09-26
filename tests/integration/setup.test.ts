import { createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locales } from "@/i18n/locales.generated";
import en from "@/messages/en.json";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";
import { readZip } from "../read-zip";

// `getTranslations` (next-intl/server) resolves its config through the
// Next.js build plugin (next.config.ts createNextIntlPlugin), which is not
// present under plain Vitest — see i18n/request.ts. The route only ever asks
// for one locale/namespace pair per request, so a translator built from the
// English messages, exactly like tests/setup.test.ts does for lib/setup.ts
// directly, stands in for it here.
vi.mock("next-intl/server", () => ({
  getTranslations: async ({ namespace }: { namespace: string }) =>
    createTranslator({ locale: "en", messages: en, namespace: namespace as "Setup" }),
}));

// i18n/routing.ts also calls next-intl/navigation's `createNavigation`, which
// imports `next/navigation` — resolvable only through Next's own bundler, not
// plain Vitest. lib/request-locale.ts (the only thing app/api/setup/route.ts
// needs from this module) only reads `routing.locales`/`routing.defaultLocale`.
vi.mock("@/i18n/routing", () => ({ routing: { locales, defaultLocale: "en" } }));

const PIN = "12345";

describe("GET /api/setup", () => {
  useRedis();
  beforeEach(() => vi.stubEnv("DASHBOARD_PIN", PIN));
  afterEach(() => vi.unstubAllEnvs());

  // `?locale=en` sidesteps lib/request-locale.ts's fallback to next/headers's
  // `cookies()`, which (like getTranslations above) needs a real Next request
  // scope this test does not have.
  const url = (query: string) => `http://localhost/api/setup?locale=en&${query}`;

  it("redirects to the localized /setup page (303) without a session", async () => {
    const { GET } = await import("@/app/api/setup/route");
    const response = await GET(new Request(url("os=macos&mode=auto")));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/en/setup");
  });

  it("answers 400 invalid_payload for bad parameters", async () => {
    const { GET } = await import("@/app/api/setup/route");
    const cookie = await seedSession(PIN);
    const response = await GET(new Request(url("os=amiga&mode=auto"), { headers: { cookie } }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_payload");
  });

  it("answers 200 with the ZIP package for a valid request", async () => {
    const { GET } = await import("@/app/api/setup/route");
    const cookie = await seedSession(PIN);
    const response = await GET(
      new Request(url("os=macos&mode=manual&group=Work&machine=laptop"), {
        headers: { cookie, host: "localhost:3000" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toContain("usageratio-macos-manual.zip");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();

    const bytes = new Uint8Array(await response.arrayBuffer());
    const entries = readZip(bytes);
    const config = entries.find((entry) => entry.name === "config");
    expect(config).toBeTruthy();
    expect(config?.data.toString("utf8")).toContain('GROUP_ID="Work"');
    expect(entries.some((entry) => entry.name === "install.sh")).toBe(true);
  });
});

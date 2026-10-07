import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * Read once, at build/start time: next.config.ts's `headers()` runs when the
 * server boots, not per request, so an env change needs a redeploy/restart —
 * same as every other build-time env var in this file.
 */
const hstsEnabled = !FALSE_VALUES.has(process.env.SECURITY_HSTS?.trim().toLowerCase() ?? "");
const hstsPreload = TRUE_VALUES.has(process.env.SECURITY_HSTS_PRELOAD?.trim().toLowerCase() ?? "");
const hstsValue = `max-age=63072000; includeSubDomains${hstsPreload ? "; preload" : ""}`;

const SETUP_CLIENT_FILES = [
  "./clients/auto/**/*",
  "./clients/manual/**/*",
  "./clients/setup/**/*",
  "./clients/shared/**/*",
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Only the Dockerfile's build sets this — Vercel's build stays on its own
  // (Fluid Compute) output and must not be touched.
  ...(process.env.DOCKER_BUILD === "1" ? { output: "standalone" as const } : {}),
  // The setup page and its ZIP download read the client scripts from disk at request time.
  // Their folders only: not clients/macos, which no setup package ships, and where a local
  // `swift build` leaves a .build folder whose symlinks break the trace.
  outputFileTracingIncludes: {
    "/setup": SETUP_CLIENT_FILES,
    "/api/setup": SETUP_CLIENT_FILES,
  },
  // The `path.join(process.cwd(), "clients", …)` in lib/setup-package.ts traces the whole folder.
  outputFileTracingExcludes: {
    "/setup": ["./clients/macos/**/*"],
    "/api/setup": ["./clients/macos/**/*"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          // browsing-topics/interest-cohort dropped: Chrome logs "Unrecognized feature"
          // for it now that FLoC was replaced by the Topics API — see the browser check
          // in the CSP work's final report.
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
        ],
      },
      {
        // A static, maximally strict policy for JSON endpoints: no nonce, no
        // page, nothing to allow. proxy.ts's per-request policy covers pages.
        source: "/api/:path*",
        headers: [{ key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'" }],
      },
      ...(hstsEnabled
        ? [
            {
              // Only asserted once a proxy in front says the request was HTTPS —
              // never on plain HTTP, where the header itself would go unencrypted
              // and unread. SECURITY_HSTS=0 turns this off outright (a self-hosted
              // deployment without TLS yet); SECURITY_HSTS_PRELOAD=1 adds `preload`.
              source: "/:path*",
              has: [{ type: "header" as const, key: "x-forwarded-proto", value: "https" }],
              headers: [{ key: "Strict-Transport-Security", value: hstsValue }],
            },
          ]
        : []),
    ];
  },
};

export default withNextIntl(nextConfig);

import {
  ACCOUNT_EXPORT_RATE_LIMIT_PER_USER,
  ALERT_TEST_RATE_LIMIT_BURST_SECONDS,
  ALERT_TEST_RATE_LIMIT_PER_IP,
  ALERT_TEST_RATE_LIMIT_PER_TENANT,
  CYCLE_RATE_LIMIT_PER_TOKEN,
  EXPORT_RATE_LIMIT_PER_IP,
  EXPORT_RATE_LIMIT_PER_TENANT,
  INGEST_RATE_LIMIT_INSTANCE,
  INGEST_RATE_LIMIT_PER_IP,
  INGEST_RATE_LIMIT_PER_MACHINE,
  INGEST_RATE_LIMIT_PER_MACHINE_MULTI,
  INGEST_RATE_LIMIT_PER_TENANT,
  OFFICIAL_REPORT_RATE_LIMIT_PER_IP,
  OFFICIAL_REPORT_RATE_LIMIT_PER_TENANT,
  OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN,
  REGISTRATION_RATE_LIMIT_INSTANCE,
  REGISTRATION_RATE_LIMIT_PER_IP,
  REGISTRATION_RATE_LIMIT_PER_IP_WINDOW_SECONDS,
  SIGN_IN_RATE_LIMIT_PER_IP,
  SIGN_IN_RATE_LIMIT_UNKNOWN_IP,
  SIGN_IN_RATE_LIMIT_WINDOW_SECONDS,
} from "@/lib/config";
import type { RateLimitRule } from "@/lib/rate-limit";
import { GLOBAL_KEYS } from "@/lib/redis-keys";
import { sha256Hex } from "@/lib/security";

/**
 * Which rate limits each endpoint counts a request against (the numbers are in
 * lib/config.ts, the counter in lib/rate-limit.ts). Always narrowest first:
 * `enforceLimits` stops at the first budget a request exceeds, so it never
 * counts against the wider ones after it, and one tenant hammering its own
 * limit leaves the instance's untouched for everybody else.
 *
 * A per-address rule needs the caller's address. Without a trusted proxy
 * (lib/request-context.ts `clientIp` answers "unknown") every caller would
 * share one counter, so those rules are left out then; the token, tenant and
 * instance limits still hold.
 */

/** The caller's address as a key fragment (sha256, 32 hex characters), or null for "unknown". */
export function ipKey(ip: string): string | null {
  return ip === "unknown" ? null : sha256Hex(ip).slice(0, 32);
}

/** The UTC hour, as a fixed-width bucket for the counters aligned to the clock hour. */
export function hourBucket(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}`;
}

const HOUR = 3600;

/**
 * Seconds from `now` to the end of its UTC hour (1 to 3600): the window of a counter keyed by
 * `hourBucket`, so its key expires, and its Retry-After points, at the turn of the hour rather
 * than an hour after the bucket's first hit.
 */
export function secondsToHourEnd(now: Date): number {
  const ms = now.getTime();
  return Math.max(1, Math.ceil((Math.floor(ms / 3_600_000 + 1) * 3_600_000 - ms) / 1000));
}

function ipRule(name: string, key: string | null, limit: number, windowSeconds = HOUR): RateLimitRule[] {
  return key === null ? [] : [{ name, scope: "ip", key, limit, windowSeconds }];
}

/**
 * POST /api/usage: the token+machine (when the body names one), the address, the tenant, and the
 * instance (the cost cap). The tenant's and the instance's windows are the clock hour, which every
 * hourly client reports at the top of.
 */
export function ingestRules(input: {
  tokenId: string;
  tenantId: string;
  machineId: string | null;
  ip: string;
  multiTenant: boolean;
  now: Date;
}): RateLimitRule[] {
  const bucket = hourBucket(input.now);
  const hourLeft = secondsToHourEnd(input.now);
  const rules: RateLimitRule[] = [];
  if (input.machineId !== null) {
    rules.push({
      name: "ingest",
      scope: "machine",
      key: GLOBAL_KEYS.rateLimit.ingestMachine(sha256Hex(`${input.tokenId}:${input.machineId}`).slice(0, 32)),
      limit: input.multiTenant ? INGEST_RATE_LIMIT_PER_MACHINE_MULTI : INGEST_RATE_LIMIT_PER_MACHINE,
      windowSeconds: HOUR,
    });
  }
  rules.push(...ipRule("ingest", ipLimitKey(input.ip, GLOBAL_KEYS.rateLimit.ingestIp), INGEST_RATE_LIMIT_PER_IP));
  rules.push({
    name: "ingest",
    scope: "tenant",
    key: GLOBAL_KEYS.rateLimit.ingestTenant(input.tenantId, bucket),
    limit: INGEST_RATE_LIMIT_PER_TENANT,
    windowSeconds: hourLeft,
  });
  rules.push({
    name: "ingest",
    scope: "instance",
    key: GLOBAL_KEYS.rateLimit.ingestGlobal(bucket),
    limit: INGEST_RATE_LIMIT_INSTANCE,
    windowSeconds: hourLeft,
  });
  return rules;
}

function ipLimitKey(ip: string, key: (ipHash: string) => string): string | null {
  const hash = ipKey(ip);
  return hash === null ? null : key(hash);
}

/** GET /api/usage (the cycle lookup before each report): the token. */
export function cycleRules(tokenId: string): RateLimitRule[] {
  return [
    {
      name: "cycle",
      scope: "token",
      key: GLOBAL_KEYS.rateLimit.cycle(tokenId),
      limit: CYCLE_RATE_LIMIT_PER_TOKEN,
      windowSeconds: HOUR,
    },
  ];
}

/** POST /api/official-usage/report: the token, the address, the tenant. */
export function officialReportRules(input: { tokenId: string; tenantId: string; ip: string }): RateLimitRule[] {
  return [
    {
      name: "official",
      scope: "token",
      key: GLOBAL_KEYS.rateLimit.official(input.tokenId),
      limit: OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN,
      windowSeconds: HOUR,
    },
    ...ipRule("official", ipLimitKey(input.ip, GLOBAL_KEYS.rateLimit.officialIp), OFFICIAL_REPORT_RATE_LIMIT_PER_IP),
    {
      name: "official",
      scope: "tenant",
      key: GLOBAL_KEYS.rateLimit.officialTenant(input.tenantId),
      limit: OFFICIAL_REPORT_RATE_LIMIT_PER_TENANT,
      windowSeconds: HOUR,
    },
  ];
}

/** GET /api/export: the address, the tenant (only its owner may export, so the tenant is the person). */
export function exportRules(input: { tenantId: string; ip: string }): RateLimitRule[] {
  return [
    ...ipRule("export", ipLimitKey(input.ip, GLOBAL_KEYS.rateLimit.exportIp), EXPORT_RATE_LIMIT_PER_IP),
    {
      name: "export",
      scope: "tenant",
      key: GLOBAL_KEYS.rateLimit.exportTenant(input.tenantId),
      limit: EXPORT_RATE_LIMIT_PER_TENANT,
      windowSeconds: HOUR,
    },
  ];
}

/** GET /api/account/export: the user, then the address (the same counter as GET /api/export's). */
export function accountExportRules(input: { userId: string; ip: string }): RateLimitRule[] {
  return [
    {
      name: "account-export",
      scope: "user",
      key: GLOBAL_KEYS.rateLimit.accountExport(input.userId),
      limit: ACCOUNT_EXPORT_RATE_LIMIT_PER_USER,
      windowSeconds: HOUR,
    },
    ...ipRule("export", ipLimitKey(input.ip, GLOBAL_KEYS.rateLimit.exportIp), EXPORT_RATE_LIMIT_PER_IP),
  ];
}

/** POST /api/alerts/test: one per tenant every few seconds, then the tenant's and the address's hour. */
export function alertTestRules(input: { tenantId: string; ip: string }): RateLimitRule[] {
  return [
    {
      name: "alerts-test",
      scope: "tenant",
      key: GLOBAL_KEYS.rateLimit.alertsTestBurst(input.tenantId),
      limit: 1,
      windowSeconds: ALERT_TEST_RATE_LIMIT_BURST_SECONDS,
    },
    ...ipRule("alerts-test", ipLimitKey(input.ip, GLOBAL_KEYS.rateLimit.alertsTestIp), ALERT_TEST_RATE_LIMIT_PER_IP),
    {
      name: "alerts-test",
      scope: "tenant",
      key: GLOBAL_KEYS.rateLimit.alertsTestTenant(input.tenantId),
      limit: ALERT_TEST_RATE_LIMIT_PER_TENANT,
      windowSeconds: HOUR,
    },
  ];
}

/**
 * GitHub sign-in, start and callback together: per address; an "unknown" address (no trusted
 * proxy) is one shared, larger budget, so sign-in still works there.
 */
export function signInRules(ip: string): RateLimitRule[] {
  const hash = ipKey(ip);
  return [
    {
      name: "sign-in",
      scope: "ip",
      key: GLOBAL_KEYS.rateLimit.oauth(hash ?? "unknown"),
      limit: hash === null ? SIGN_IN_RATE_LIMIT_UNKNOWN_IP : SIGN_IN_RATE_LIMIT_PER_IP,
      windowSeconds: SIGN_IN_RATE_LIMIT_WINDOW_SECONDS,
    },
  ];
}

/** A new workspace: per address per day, then the instance per clock hour. */
export function registrationRules(ip: string, now: Date): RateLimitRule[] {
  return [
    ...ipRule(
      "registration",
      ipLimitKey(ip, GLOBAL_KEYS.rateLimit.registrationIp),
      REGISTRATION_RATE_LIMIT_PER_IP,
      REGISTRATION_RATE_LIMIT_PER_IP_WINDOW_SECONDS,
    ),
    {
      name: "registration",
      scope: "instance",
      key: GLOBAL_KEYS.rateLimit.registrationInstance(hourBucket(now)),
      limit: REGISTRATION_RATE_LIMIT_INSTANCE,
      windowSeconds: secondsToHourEnd(now),
    },
  ];
}

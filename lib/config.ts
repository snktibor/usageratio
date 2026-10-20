import { log } from "@/lib/log";
import type { SubLimit } from "@/lib/sub-limits";

/**
 * Central configuration.
 *
 * The budget itself (period, reset moment, the optional token limits) and the
 * groups are edited on the dashboard's settings panel and live in Redis: see
 * lib/settings.ts. The DEFAULT_* constants below only seed that panel; they
 * apply until the first save. Everything else is set here (and redeployed),
 * or per environment with the env vars named next to each constant.
 */

/**
 * Whether the dashboard measures usage against a token limit of its own. Off,
 * it has no limit to count down: the share of the budget comes only from the
 * official percentage typed on the dashboard, split among the machines and
 * groups by their measured tokens. A seed: the settings panel has the switch.
 */
export const DEFAULT_USE_TOKEN_LIMITS = false;

/**
 * Token budget of one cycle, until the settings panel saves its own. Only
 * used while the token limits are switched on.
 * Optional env override: WEEKLY_LIMIT
 */
export const DEFAULT_LIMIT = 500_000;

/**
 * When the cycle restarts, as wall-clock time in `timeZone` (DST-aware). Only
 * reports since the most recent reset are shown. The period, the day, the
 * time and the time zone are all seeds for the settings panel: once it saves
 * a document, lib/settings.ts `resolveConfig` applies its choices (including
 * its own `reset.timeZone`) over these.
 * Optional env overrides: RESET_WEEKDAY (0 = Sunday … 6 = Saturday),
 * RESET_TIME ("HH:MM", 24h) and RESET_TIMEZONE (IANA name; only the initial
 * value — see lib/settings.ts).
 */
export const DEFAULT_RESET: ResetConfig = {
  period: "weekly",
  weekday: 1, // Monday
  monthDay: 1,
  hour: 0,
  minute: 0,
  timeZone: "UTC",
};

/**
 * Whether the dashboard states how many tokens are left (or how far over the
 * limit the usage is), while the token limits are on. A seed like the ones
 * above: the settings panel has the switch.
 */
export const DEFAULT_SHOW_REMAINING = true;

/**
 * Whether every machine is asked to price its usage at API list prices, and
 * the dashboard shows the energy and water behind it (lib/resources.ts). Off:
 * only a machine set up with its own cost opt-in sends a cost. A seed like the
 * ones above: the settings panel has the switch.
 */
export const DEFAULT_COST_ESTIMATE = false;

/** How an alert webhook's message is shaped; see lib/alerts.ts and lib/webhook.ts. */
export type AlertsFormat = "generic" | "slack" | "discord";

/**
 * The settings panel's threshold-alerts section (lib/alerts.ts): a webhook
 * message the first time a provider's usage in the current cycle crosses one
 * of `thresholds`. A seed like the ones above: `webhookUrl: null` is off, and
 * that is what every settings document saved before this feature existed
 * resolves to (see lib/settings.ts `parseStoredSettings`).
 */
export interface AlertsConfig {
  /** Null: alerts are off. https only; see lib/webhook.ts `isAllowedWebhookUrl`. */
  webhookUrl: string | null;
  /** Percent of the budget, 1-100; at most 5, sorted ascending, unique. */
  thresholds: number[];
  /** True: every provider alerts on its own budget, hidden ones included. False: only the ones shown on the dashboard. */
  perProvider: boolean;
  format: AlertsFormat;
  /** The language the webhook's message is written in (an IANA-free tag next-intl already validates: see routing.locales). */
  locale: string;
}

export const DEFAULT_ALERTS_THRESHOLDS: readonly number[] = [50, 80, 100];

export const DEFAULT_ALERTS: AlertsConfig = {
  webhookUrl: null,
  thresholds: [...DEFAULT_ALERTS_THRESHOLDS],
  perProvider: true,
  format: "generic",
  locale: "en",
};

/**
 * How each value in a report's `providers` snapshot is interpreted. Reports are stored raw,
 * so this can be changed at any time and the dashboard re-reads history
 * under the new rule.
 *
 * - "delta":    tokens used since the previous report. The dashboard adds
 *               the reports of the cycle up.
 * - "snapshot": the machine's running total for the current cycle. The
 *               dashboard takes the largest report of the cycle, so a later,
 *               lower one (logs deleted on the machine) cannot pull it back.
 * - "counter":  an ever-growing odometer. The dashboard adds up the increases
 *               between consecutive reports (a drop counts as a restart).
 *
 * Optional env override: TOKEN_MODE
 */
export const TOKEN_MODE: TokenMode = "snapshot";

/** How often the client scripts report; drives the "late"/"inactive" badges. */
export const REPORT_INTERVAL_MINUTES = 60;

/**
 * Raw reports older than this are pruned from Redis. The dashboard reads the
 * current and the previous cycle, which is up to 62 days of a monthly budget.
 */
export const RETENTION_DAYS = 70;

/** A machine silent for longer than this drops off the dashboard. */
export const INACTIVE_MACHINE_DAYS = 35;

/** Reports timestamped further in the future than this are rejected. */
export const MAX_CLOCK_SKEW_MINUTES = 10;

/**
 * The registry caps `storeReport` (lib/usage-store.ts) refuses to grow past:
 * MAX_GROUPS (lib/settings.ts) and MAX_PROVIDERS (lib/providers.ts) are the
 * other two. A concurrent first report of two never-seen machines (or groups,
 * or providers) can overshoot its cap by a few — the check reads the count
 * before the write, not inside its transaction — this is anti-bloat, not an
 * invariant the dashboard depends on.
 */
export const MAX_MACHINES = 200;

/**
 * POST /api/usage: hits per token+machine and the deployment-wide total,
 * both per hour (app/api/usage/route.ts).
 */
export const INGEST_RATE_LIMIT_PER_MACHINE = 60;
export const INGEST_RATE_LIMIT_GLOBAL = 600;

/** GET /api/usage: cycle lookups per token, per hour. */
export const CYCLE_RATE_LIMIT_PER_TOKEN = 120;

/** GET /api/status: lookups per token, per hour (the menu bar app polls every 5 minutes, 12 an hour). */
export const STATUS_RATE_LIMIT_PER_TOKEN = 120;
/** POST /api/official-usage/report calls per token per hour. */
export const OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN = 120;

/** Failed Bearer tokens per IP, per minute, on either method of /api/usage and on GET /api/status. */
export const UNAUTH_RATE_LIMIT_PER_IP = 60;

// ─────────────────────────────────────────────────────────────────────────────

export type TokenMode = "delta" | "snapshot" | "counter";

export type BudgetPeriod = "weekly" | "monthly";

export interface ResetConfig {
  period: BudgetPeriod;
  /** Weekly budgets: 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** Monthly budgets: 1–31; in a shorter month its last day stands in. */
  monthDay: number;
  hour: number;
  minute: number;
  /** IANA time zone, e.g. "Europe/Budapest" */
  timeZone: string;
}

/** A provider's own reset moment, over the shared period and time zone (see lib/settings.ts `resetFor`). */
export interface ResetOverride {
  /** Weekly budgets: 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** Monthly budgets: 1–31 */
  monthDay: number;
  hour: number;
  minute: number;
  /** "report": set by an official report (lib/official-report.ts), not on the panel; the panel drops it on edit. */
  source?: "report";
}

export interface AppConfig {
  /** False: no token limit is used anywhere; see DEFAULT_USE_TOKEN_LIMITS. */
  useTokenLimits: boolean;
  /** Fallback token budget for a provider that has not been saved yet. */
  limit: number;
  /** Saved token budgets by provider/account id. */
  providerLimits: Record<string, number>;
  reset: ResetConfig;
  /** providerId → its own reset moment; a provider without one uses `reset`. */
  resetOverrides: Record<string, ResetOverride>;
  /** False: the dashboard never states the tokens left, nor the overage. */
  showRemaining: boolean;
  /** True: every machine prices its usage, and the dashboard shows its energy and water; see DEFAULT_COST_ESTIMATE. */
  costEstimate: boolean;
  /** Providers the dashboard leaves out, account picker included; their reports are still stored. */
  hiddenProviders: string[];
  /** groupId → the providers whose reports from that group the dashboard leaves out. */
  excludedProviders: Record<string, string[]>;
  /** providerId → its sub-limits, such as Claude's Fable: see lib/sub-limits.ts. */
  subLimits: Record<string, SubLimit[]>;
  /** Threshold webhook alerts; see lib/alerts.ts. */
  alerts: AlertsConfig;
  tokenMode: TokenMode;
  reportIntervalMinutes: number;
  retentionDays: number;
  inactiveMachineDays: number;
  maxClockSkewMinutes: number;
}

const TOKEN_MODES: readonly TokenMode[] = ["delta", "snapshot", "counter"];

/** Whether Intl accepts `timeZone` as an IANA name; used to validate both the env var and the settings panel's. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const warned = new Set<string>();
function warnOnce(name: string, value: string, fallback: unknown): void {
  if (warned.has(name)) return;
  warned.add(name);
  log.warn("config.invalid_env", { name, value, fallback });
}

/**
 * Resolves the deploy-time configuration: constants above, overridden by valid
 * env vars. The budget fields are defaults; `resolveConfig` in lib/settings.ts
 * lays the settings saved on the dashboard over them.
 */
export function getConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  let limit = DEFAULT_LIMIT;
  const rawLimit = env.WEEKLY_LIMIT?.trim();
  if (rawLimit) {
    const parsed = Number(rawLimit.replace(/[_\s]/g, ""));
    if (Number.isSafeInteger(parsed) && parsed > 0) limit = parsed;
    else warnOnce("WEEKLY_LIMIT", rawLimit, DEFAULT_LIMIT);
  }

  const reset: ResetConfig = { ...DEFAULT_RESET };

  const rawWeekday = env.RESET_WEEKDAY?.trim();
  if (rawWeekday) {
    if (/^[0-6]$/.test(rawWeekday)) reset.weekday = Number(rawWeekday);
    else warnOnce("RESET_WEEKDAY", rawWeekday, DEFAULT_RESET.weekday);
  }

  const rawTime = env.RESET_TIME?.trim();
  if (rawTime) {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(rawTime);
    if (match) {
      reset.hour = Number(match[1]);
      reset.minute = Number(match[2]);
    } else {
      warnOnce("RESET_TIME", rawTime, "the default reset time");
    }
  }

  const rawZone = env.RESET_TIMEZONE?.trim();
  if (rawZone) {
    if (isValidTimeZone(rawZone)) reset.timeZone = rawZone;
    else warnOnce("RESET_TIMEZONE", rawZone, DEFAULT_RESET.timeZone);
  }

  let tokenMode = TOKEN_MODE;
  const rawMode = env.TOKEN_MODE?.trim().toLowerCase();
  if (rawMode) {
    if ((TOKEN_MODES as readonly string[]).includes(rawMode)) {
      tokenMode = rawMode as TokenMode;
    } else {
      warnOnce("TOKEN_MODE", rawMode, TOKEN_MODE);
    }
  }

  return {
    useTokenLimits: DEFAULT_USE_TOKEN_LIMITS,
    limit,
    providerLimits: {},
    reset,
    resetOverrides: {},
    showRemaining: DEFAULT_SHOW_REMAINING,
    costEstimate: DEFAULT_COST_ESTIMATE,
    hiddenProviders: [],
    excludedProviders: {},
    subLimits: {},
    alerts: { ...DEFAULT_ALERTS, thresholds: [...DEFAULT_ALERTS.thresholds] },
    tokenMode,
    reportIntervalMinutes: REPORT_INTERVAL_MINUTES,
    retentionDays: RETENTION_DAYS,
    inactiveMachineDays: INACTIVE_MACHINE_DAYS,
    maxClockSkewMinutes: MAX_CLOCK_SKEW_MINUTES,
  };
}

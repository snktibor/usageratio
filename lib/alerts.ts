import type { Locale } from "next-intl";
import { getTranslations } from "next-intl/server";
import { summarizeUsage } from "@/lib/aggregate";
import { type AlertsConfig, type AlertsFormat, getConfig, type ResetConfig } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import { parseOfficialPercent } from "@/lib/ground-truth";
import { log } from "@/lib/log";
import type { OfficialUsageUpdate } from "@/lib/official-usage";
import { providerLabel } from "@/lib/providers";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { countsForProvider, parseStoredSettings, settingsFromConfig, type UsageSettings } from "@/lib/settings";
import { loadEvents, loadIndexes, loadRawSettings } from "@/lib/usage-store";
import type { UsageReport } from "@/lib/validation";
import { sendWebhook, type WebhookResult } from "@/lib/webhook";

/**
 * Threshold alerts: a webhook message the first time a provider's usage in
 * the current cycle crosses one of a few percentages. Two signals feed it,
 * whichever one the dashboard is actually reading:
 *
 *  - measured tokens against the provider's limit, once the token limits are
 *    on: `checkIngestAlerts`, called from POST /api/usage after a report is
 *    stored;
 *  - the official percentage typed on the dashboard, while they are off (it
 *    is then the only figure the dashboard has): `checkOfficialUsageAlerts`,
 *    called from PUT /api/official-usage.
 *
 * A threshold fires once per provider per cycle: `SET … NX` on
 * `usage:alert:{providerId}:{cycleStartMs}:{threshold}` (lib/redis-keys.ts)
 * is the guard, so two concurrent requests crossing the same threshold only
 * ever send one message, and a new cycle (a different cycleStartMs) starts
 * every threshold fresh. Crossing several thresholds in one evaluation (a
 * burst of usage, or the first report of a new cycle already over 100%)
 * sends exactly one message, for the highest of them; the lower ones are
 * still marked as sent, so they never fire late on their own.
 *
 * Never throws into the request that triggers it: both entry points are
 * called through `defer()` (lib/request-context.ts), and every failure here
 * is caught and logged rather than left to bubble up.
 */

const ALERT_TTL_SECONDS = 70 * 86_400;

export interface AlertCycle {
  startMs: number;
  endMs: number;
  /** For the "the cycle ends …" text; UTC when the reset time zone is not known. */
  timeZone?: string;
}

export interface EvaluateAlertsParams {
  providerId: string;
  label: string;
  usedFraction: number;
  cycle: AlertCycle;
  settings: AlertsConfig;
  now: Date;
}

/** `UsageSettings` splits the reset's period from its other fields; `getCycle` (lib/cycle.ts) wants them together. */
function resetConfigOf(settings: Pick<UsageSettings, "period" | "reset">): ResetConfig {
  return { ...settings.reset, period: settings.period };
}

/** `NEXT_PUBLIC_SITE_URL`, else the Vercel production domain; omitted when neither is set. */
function dashboardUrl(): string | undefined {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured;
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return vercel ? `https://${vercel}` : undefined;
}

function formatCycleEnd(endMs: number, locale: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(endMs));
  } catch {
    return new Date(endMs).toISOString();
  }
}

interface PayloadParams {
  providerId: string;
  label: string;
  threshold: number;
  usedPercent: number;
  cycle: { startMs: number; endMs: number };
  format: AlertsFormat;
  locale: string;
  timeZone: string;
}

/** The webhook body for one crossed threshold, shaped for `format`. */
async function buildAlertPayload(params: PayloadParams): Promise<unknown> {
  const { providerId, label, threshold, usedPercent, cycle, format, locale, timeZone } = params;
  const used = Math.round(usedPercent * 10) / 10;

  if (format === "generic") {
    const url = dashboardUrl();
    return {
      event: "usageratio.threshold",
      provider: providerId,
      label,
      threshold,
      usedPercent: used,
      cycle: { start: new Date(cycle.startMs).toISOString(), end: new Date(cycle.endMs).toISOString() },
      ...(url && { dashboardUrl: url }),
    };
  }

  const t = await getTranslations({ locale: locale as Locale, namespace: "Alerts" });
  const text = t("threshold_text", {
    label,
    threshold,
    used,
    end: formatCycleEnd(cycle.endMs, locale, timeZone),
  });
  return format === "slack" ? { text } : { content: text };
}

async function sendAlert(params: EvaluateAlertsParams & { threshold: number; usedPercent: number }): Promise<void> {
  const { providerId, label, threshold, usedPercent, cycle, settings } = params;
  const timeZone = cycle.timeZone ?? "UTC";
  const payload = await buildAlertPayload({
    providerId,
    label,
    threshold,
    usedPercent,
    cycle,
    format: settings.format,
    locale: settings.locale,
    timeZone,
  });
  const result = await sendWebhook(settings.webhookUrl!, payload, { timeoutMs: 5000 });
  if (!result.ok) {
    log.error("alerts.webhook_failed", { providerId, threshold, status: result.status, error: result.error });
  }
}

/**
 * For every threshold at or below `usedFraction * 100`, claims it (`SET NX`)
 * for this provider's current cycle, then sends one webhook message for the
 * highest threshold this call newly claimed — the others are marked sent
 * without a message of their own. A no-op without a webhook URL, or when
 * nothing new was crossed.
 */
export async function evaluateAlerts(params: EvaluateAlertsParams): Promise<void> {
  try {
    const { providerId, usedFraction, cycle, settings } = params;
    if (!settings.webhookUrl) return;

    const usedPercent = usedFraction * 100;
    const crossed = settings.thresholds.filter((threshold) => usedPercent >= threshold).sort((a, b) => a - b);
    if (crossed.length === 0) return;

    const redis = getRedis();
    let highestNew: number | null = null;
    for (const threshold of crossed) {
      const key = KEYS.alert(providerId, cycle.startMs, threshold);
      const result = await redis.set(key, 1, { nx: true, ex: ALERT_TTL_SECONDS });
      if (result === "OK") highestNew = threshold;
    }
    if (highestNew === null) return;

    await sendAlert({ ...params, threshold: highestNew, usedPercent });
  } catch (error) {
    log.error("alerts.evaluate_failed", { providerId: params.providerId, err: error });
  }
}

/**
 * The measured-tokens signal: called after `POST /api/usage` stores a
 * report, while the token limits are on. Re-reads that provider's events
 * (one extra round trip; nothing else already has them at this point) and
 * aggregates them exactly as the dashboard does (lib/aggregate.ts).
 */
export async function checkIngestAlerts(report: UsageReport, now: Date): Promise<void> {
  try {
    const providerIds = Object.keys(report.providers);
    if (providerIds.length === 0) return; // a heartbeat: nothing was measured

    const config = getConfig();
    const indexes = await loadIndexes();
    const settings = parseStoredSettings(indexes.settings, settingsFromConfig(config));
    const { alerts } = settings;
    if (!alerts.webhookUrl || !settings.useTokenLimits) return;

    const cycle = getCycle(now, resetConfigOf(settings));
    const startMs = cycle.start.getTime();
    const endMs = cycle.end.getTime();

    for (const providerId of providerIds) {
      if (!alerts.perProvider && settings.hiddenProviders.includes(providerId)) continue;

      const { eventsByProvider } = await loadEvents([providerId], indexes.groups, startMs);
      const events = (eventsByProvider[providerId] ?? []).filter((event) =>
        countsForProvider(settings.excludedProviders, event.groupId, providerId),
      );
      const summary = summarizeUsage(events, { startMs, endMs }, config.tokenMode);
      const limit = settings.limits[providerId] ?? config.limit;
      if (!(limit > 0)) continue;

      await evaluateAlerts({
        providerId,
        label: providerLabel(providerId),
        usedFraction: summary.total / limit,
        cycle: { startMs, endMs, timeZone: settings.reset.timeZone },
        settings: alerts,
        now,
      });
    }
  } catch (error) {
    log.error("alerts.ingest_check_failed", { err: error });
  }
}

/**
 * The official-percentage signal: called after `PUT /api/official-usage`
 * saves a provider's own figure (not a sub-limit's), while the token limits
 * are off — with them on, `checkIngestAlerts` already covers this provider
 * from measured tokens. Skipped for a figure typed for a cycle that has
 * since rolled over: it says nothing about the current one.
 */
export async function checkOfficialUsageAlerts(update: OfficialUsageUpdate, now: Date): Promise<void> {
  try {
    if (update.subLimitId !== null) return;

    const { percent } = parseOfficialPercent(update.raw);
    if (percent === null) return;

    const config = getConfig();
    const rawSettings = await loadRawSettings();
    const settings = parseStoredSettings(rawSettings, settingsFromConfig(config));
    const { alerts } = settings;
    if (!alerts.webhookUrl || settings.useTokenLimits) return;
    if (!alerts.perProvider && settings.hiddenProviders.includes(update.providerId)) return;

    const cycle = getCycle(now, resetConfigOf(settings));
    if (cycle.start.getTime() !== update.cycleStartMs) return;

    await evaluateAlerts({
      providerId: update.providerId,
      label: providerLabel(update.providerId),
      usedFraction: percent / 100,
      cycle: { startMs: cycle.start.getTime(), endMs: cycle.end.getTime(), timeZone: settings.reset.timeZone },
      settings: alerts,
      now,
    });
  } catch (error) {
    log.error("alerts.official_usage_check_failed", { err: error });
  }
}

/** A sample message for the settings panel's "send test" button; never throws. */
export async function sendTestAlert(params: {
  webhookUrl: string;
  format: AlertsFormat;
  locale: string;
}): Promise<WebhookResult> {
  const now = Date.now();
  const cycle = { startMs: now, endMs: now + 7 * 86_400_000 };
  const payload = await buildAlertPayload({
    providerId: "claude",
    label: providerLabel("claude"),
    threshold: 80,
    usedPercent: 82.4,
    cycle,
    format: params.format,
    locale: params.locale,
    timeZone: "UTC",
  });
  return sendWebhook(params.webhookUrl, payload, { timeoutMs: 5000 });
}

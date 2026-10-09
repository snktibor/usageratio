import type { AppConfig, ResetOverride } from "@/lib/config";
import { wallClockOf } from "@/lib/cycle";
import type { OfficialEntryView } from "@/lib/official-usage";
import { providerCycle } from "@/lib/provider-cycles";
import { normalizeProviderId } from "@/lib/providers";
import { resetFor } from "@/lib/settings";

/**
 * A provider's own usage percentage, as a client read it on its machine (the
 * macOS menu bar app: Claude Code's status line, Codex's session logs), and
 * what the server does with it (POST /api/official-usage/report). Pure.
 *
 * The figure is the provider's weekly window; the dashboard's cycle for that
 * provider must be the same week for it to mean anything. So the window's
 * own reset decides: a provider whose cycle ends elsewhere gets its reset
 * moved to the window's (lib/settings.ts `resetOverrides`, marked as set by a
 * report), and the figure is then stored for that cycle.
 */

export const RESET_TOLERANCE_MS = 15 * 60_000;
const WEEK_MS = 7 * 86_400_000;
/** A reading's clock may run a little ahead of the server's. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_PERCENT = 1000;

export interface OfficialReport {
  providerId: string;
  /** 0–1000: a provider may report more than 100 once the limit is passed. */
  usedPercent: number;
  /** When the provider's weekly window resets (epoch ms). */
  resetsAtMs: number;
  /** When the client read the figure (epoch ms). */
  observedAtMs: number;
}

export type OfficialReportParseResult = { ok: true; report: OfficialReport } | { ok: false; errors: string[] };

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function parseOfficialReport(input: unknown, now: Date): OfficialReportParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const { providerId: rawProviderId, usedPercent, resetsAtMs, observedAtMs } = input as Record<string, unknown>;
  const errors: string[] = [];
  const providerId = normalizeProviderId(rawProviderId);
  if (!providerId) errors.push("providerId must be a valid provider id");
  if (
    typeof usedPercent !== "number" ||
    !Number.isFinite(usedPercent) ||
    usedPercent < 0 ||
    usedPercent > MAX_PERCENT
  ) {
    errors.push(`usedPercent must be a number from 0 to ${MAX_PERCENT}`);
  }
  if (!isTime(resetsAtMs)) errors.push("resetsAtMs must be epoch milliseconds");
  if (!isTime(observedAtMs) || observedAtMs > now.getTime() + MAX_CLOCK_SKEW_MS) {
    errors.push("observedAtMs must be epoch milliseconds, not in the future");
  }
  if (errors.length === 0) {
    const ahead = (resetsAtMs as number) - (observedAtMs as number);
    if (ahead <= 0 || ahead > WEEK_MS + RESET_TOLERANCE_MS) {
      errors.push("resetsAtMs must be within a week after observedAtMs");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    report: {
      providerId: providerId!,
      usedPercent: usedPercent as number,
      resetsAtMs: resetsAtMs as number,
      observedAtMs: observedAtMs as number,
    },
  };
}

export type OfficialReportDecision =
  | { kind: "period_not_weekly" }
  | { kind: "stale_reading" }
  | {
      kind: "accept";
      /** False: a figure at least as recent is already stored for this cycle. */
      save: boolean;
      /** The provider's new reset, when it moves to the window's; null when it already matches. */
      override: ResetOverride | null;
      cycleStartMs: number;
      /** `usedPercent` as the dashboard's ground-truth field stores it. */
      raw: string;
    };

/**
 * What to do with `report` (see the module comment). `stored` is the
 * provider's current `usage:official` entry, `storedCycleStartMs` the cycle
 * it was saved for; both null when there is none.
 */
export function decideOfficialReport(
  report: OfficialReport,
  config: AppConfig,
  now: Date,
  stored: OfficialEntryView | null,
  storedCycleStartMs: number | null,
): OfficialReportDecision {
  if (config.reset.period !== "weekly") return { kind: "period_not_weekly" };
  if (report.resetsAtMs <= now.getTime()) return { kind: "stale_reading" };

  let effective = config;
  let override: ResetOverride | null = null;
  const current = providerCycle(now, config, report.providerId).cycle;
  if (Math.abs(current.end.getTime() - report.resetsAtMs) > RESET_TOLERANCE_MS) {
    const resetAt = new Date(Math.round(report.resetsAtMs / 60_000) * 60_000);
    const { weekday, hour, minute } = wallClockOf(resetAt, config.reset.timeZone);
    override = { weekday, monthDay: resetFor(config, report.providerId).monthDay, hour, minute, source: "report" };
    effective = { ...config, resetOverrides: { ...config.resetOverrides, [report.providerId]: override } };
  }

  const cycleStartMs = providerCycle(now, effective, report.providerId).cycle.start.getTime();
  if (report.observedAtMs < cycleStartMs) return { kind: "stale_reading" };

  const raw = String(Math.round(report.usedPercent * 10) / 10);
  const newer = stored === null || storedCycleStartMs !== cycleStartMs || stored.enteredAt < report.observedAtMs;
  return { kind: "accept", save: newer, override, cycleStartMs, raw };
}

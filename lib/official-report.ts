import type { TimeWindow } from "@/lib/aggregate";
import type { AppConfig, ResetOverride } from "@/lib/config";
import { type Cycle, wallClockOf } from "@/lib/cycle";
import type { StoredOfficialReading } from "@/lib/official-usage";
import { providerCycle } from "@/lib/provider-cycles";
import { normalizeProviderId } from "@/lib/providers";
import {
  beforeFromRaw,
  keepResetsOf,
  MINUTE_MS,
  type ProviderResets,
  RESET_DROP_POINTS,
  type ResetEvent,
  restartOverride,
  segmentStartAt,
} from "@/lib/resets";
import { ownResetOf, resetFor, resetModeOf, withResetOverride } from "@/lib/settings";

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
 *
 * It also notices a usage reset (lib/resets.ts), comparing the reading with
 * the provider's stored one from a report of the same segment: for a
 * "restart" provider, a window that jumped from this cycle's end to a week
 * after R; for a "keep" provider, the same window and a figure at least
 * RESET_DROP_POINTS lower. A revert switches this off for the rest of the
 * cycle (`autoOffCycleStartMs`); readings whose window ends elsewhere are then
 * ignored rather than moving the reset back.
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
  /** Detection is off for the cycle and the window ends elsewhere: nothing is stored or moved. */
  | { kind: "ignored" }
  | {
      kind: "accept";
      /** False: a figure at least as recent is already stored for this segment. */
      save: boolean;
      /** The provider's new reset, when it moves; null when it already matches. */
      override: ResetOverride | null;
      /** The tag to store the figure under: the start of the segment it belongs to. */
      cycleStartMs: number;
      /** `usedPercent` as the dashboard's ground-truth field stores it. */
      raw: string;
      /** A reset the reading revealed, to be recorded under a fresh id; null: none. */
      reset: Omit<ResetEvent, "id"> | null;
    };

const windowOf = (cycle: Cycle): TimeWindow => ({ startMs: cycle.start.getTime(), endMs: cycle.end.getTime() });

/**
 * What to do with `report` (see the module comment). `stored` is the
 * provider's current `usage:official` entry, with its tag; `resets` its
 * resets (lib/resets.ts).
 */
export function decideOfficialReport(
  report: OfficialReport,
  config: AppConfig,
  now: Date,
  stored: StoredOfficialReading | null,
  resets: ProviderResets,
): OfficialReportDecision {
  if (config.reset.period !== "weekly") return { kind: "period_not_weekly" };
  if (report.resetsAtMs <= now.getTime()) return { kind: "stale_reading" };

  const { providerId } = report;
  const { events } = resets;
  const nowMs = now.getTime();
  const raw = String(Math.round(report.usedPercent * 10) / 10);
  const near = (a: number, b: number) => Math.abs(a - b) <= RESET_TOLERANCE_MS;
  const current = windowOf(providerCycle(now, config, providerId, events).cycle);
  const mode = resetModeOf(config, providerId);

  // What a reset is told by: a report's earlier reading of this very segment, while detection is on.
  const earlier =
    resets.autoOffCycleStartMs !== current.startMs &&
    stored !== null &&
    stored.resetsAtMs !== undefined &&
    stored.cycleStartMs === segmentStartAt(current, events, nowMs) &&
    stored.view.enteredAt < report.observedAtMs
      ? { ...stored, resetsAtMs: stored.resetsAtMs, percent: beforeFromRaw(stored.view.raw) }
      : null;
  const before = earlier?.percent ?? null;
  const detected = (atMs: number, kind: "keep" | "restart", cycleStartMs: number): Omit<ResetEvent, "id"> => ({
    atMs,
    kind,
    cycleStartMs,
    before,
    beforeAtMs: earlier!.view.enteredAt,
    source: "report",
    recordedAtMs: nowMs,
    ...(kind === "restart" && { previousOverride: ownResetOf(config, providerId) }),
  });

  // 1. A restart: the earlier reading's window was this cycle, the new one ends a week after R.
  if (
    mode === "restart" &&
    earlier &&
    before !== null &&
    near(earlier.resetsAtMs, current.endMs) &&
    report.resetsAtMs > current.endMs + RESET_TOLERANCE_MS
  ) {
    const atMs = Math.round((report.resetsAtMs - WEEK_MS) / MINUTE_MS) * MINUTE_MS;
    const lastStartMs = keepResetsOf(current, events).at(-1)?.atMs ?? current.startMs;
    if (atMs > lastStartMs && atMs <= Math.min(report.observedAtMs, nowMs)) {
      return {
        kind: "accept",
        save: true,
        override: restartOverride(atMs, config.reset.timeZone),
        cycleStartMs: atMs,
        raw,
        reset: detected(atMs, "restart", current.startMs),
      };
    }
  }

  // 2. A window that ends elsewhere moves the provider's reset to it, without a reset event.
  let effective = config;
  let override: ResetOverride | null = null;
  if (!near(current.endMs, report.resetsAtMs)) {
    if (resets.autoOffCycleStartMs === current.startMs) return { kind: "ignored" };
    const resetAt = new Date(Math.round(report.resetsAtMs / MINUTE_MS) * MINUTE_MS);
    const { weekday, hour, minute } = wallClockOf(resetAt, config.reset.timeZone);
    override = { weekday, monthDay: resetFor(config, providerId).monthDay, hour, minute, source: "report" };
    effective = withResetOverride(config, providerId, override);
  }
  const cycle = windowOf(providerCycle(now, effective, providerId, events).cycle);
  const segmentStartMs = segmentStartAt(cycle, events, nowMs);
  if (report.observedAtMs < segmentStartMs) return { kind: "stale_reading" };

  // 3. A keep reset: the same window, and the figure fell by RESET_DROP_POINTS or more.
  if (
    mode === "keep" &&
    override === null &&
    earlier &&
    before !== null &&
    near(earlier.resetsAtMs, report.resetsAtMs) &&
    before - report.usedPercent >= RESET_DROP_POINTS
  ) {
    // An upper bound: the reset happened between the two readings; it can be corrected by hand.
    const atMs = Math.floor(Math.min(report.observedAtMs, nowMs) / MINUTE_MS) * MINUTE_MS;
    if (atMs > segmentStartMs) {
      return {
        kind: "accept",
        save: true,
        override: null,
        cycleStartMs: atMs,
        raw,
        reset: detected(atMs, "keep", cycle.startMs),
      };
    }
  }

  const newer =
    stored === null || stored.cycleStartMs !== segmentStartMs || stored.view.enteredAt < report.observedAtMs;
  return { kind: "accept", save: newer, override, cycleStartMs: segmentStartMs, raw, reset: null };
}

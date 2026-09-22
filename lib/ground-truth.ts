import type { DashboardModel } from "@/lib/dashboard";
import { assessQuota, type QuotaAssessment } from "@/lib/quota";
import type { SubLimitModel } from "@/lib/sub-limits";

/**
 * Ground truth: the machines' own token counts never exactly match a provider's official
 * figure exactly (a machine was offline, a report got lost), but their
 * proportions hold. Given the official usage percentage, every machine and
 * group is restated as its share of the official figure:
 *
 *   share of the limit = (its measured tokens / all measured tokens) × official %
 *
 * With the token limits on, the official figure is restated in tokens too.
 * Without them there is no limit to convert by: the token counts stay as
 * measured, and the official percentage is the only measure of the budget.
 *
 * Runs in the browser, on every keystroke; pure.
 */

/** The official usage figure, and when it was read off the selected provider's display. */
export interface OfficialReading {
  /** 0–100 */
  percent: number;
  /** Epoch ms; pace is judged as of this moment. Null: as of the dashboard's own time. */
  atMs: number | null;
}

/** What the dashboard renders: the measured model, or its restatement by an official reading. */
export interface DashboardView {
  /** True when an official reading drives the figures. */
  calibrated: boolean;
  /**
   * How much of the budget is gone, and the pace. With the token limits on it
   * counts tokens against the limit. Without them it counts fractions of the
   * budget (`limit` is 1, `total` the official fraction), and is null until an
   * official reading is given: nothing else can tell.
   */
  quota: QuotaAssessment | null;
  /** True: `quota` counts tokens, against the provider's token limit. */
  inTokens: boolean;
  /** What the machines measured, whichever figure is in the lead. `usedFraction` needs a token limit. */
  measured: { total: number; usedFraction: number | null };
  /** Official tokens per measured token; null when not calibrated, nothing was measured, or without a token limit. */
  scale: number | null;
  /** The moment `quota` is true as of: when the official reading was taken, else the dashboard's own time. */
  asOfMs: number;
  groups: DashboardModel["groups"];
  machines: DashboardModel["machines"];
}

/**
 * The text of the official-usage field → a percentage. Accepts a decimal comma
 * or point and a trailing "%". Empty is not an error: it means "not given".
 */
export function parseOfficialPercent(raw: string): { percent: number | null; invalid: boolean } {
  const text = raw.trim().replace(/\s*%$/, "").replace(",", ".");
  if (text === "") return { percent: null, invalid: false };
  // "45." is accepted so the view does not flicker while a decimal is being typed.
  if (!/^\d{1,3}(\.\d{0,2})?$/.test(text)) return { percent: null, invalid: true };
  const percent = Number(text);
  return percent <= 100 ? { percent, invalid: false } : { percent: null, invalid: true };
}

/** A reading taken hours ago says how fast the budget went until then, not until now. */
function readingTime(model: DashboardModel, reading: OfficialReading): number {
  return Math.min(model.generatedAt, Math.max(model.cycle.startMs, reading.atMs ?? model.generatedAt));
}

export function applyGroundTruth(
  model: DashboardModel,
  reading: OfficialReading | null,
): DashboardView {
  const inTokens = model.quota !== null;
  const measured = { total: model.total, usedFraction: model.quota?.usedFraction ?? null };

  if (!reading) {
    return {
      calibrated: false,
      quota: model.quota,
      inTokens,
      measured,
      scale: null,
      asOfMs: model.generatedAt,
      groups: model.groups,
      machines: model.machines,
    };
  }

  const officialFraction = reading.percent / 100;
  // Without a token limit the budget is 1 and every amount a fraction of it; the pace reads the same.
  const limit = model.quota?.limit ?? 1;
  const officialTotal = officialFraction * limit;
  const asOfMs = readingTime(model, reading);

  // `share` is measured tokens over all measured tokens: exactly the proportion to keep.
  const restate = <T extends { share: number; tokens: number }>(row: T): T => ({
    ...row,
    limitShare: row.share * officialFraction,
    tokens: inTokens ? row.share * officialTotal : row.tokens,
  });

  return {
    calibrated: true,
    quota: assessQuota(officialTotal, limit, {
      startMs: model.cycle.startMs,
      endMs: model.cycle.endMs,
      nowMs: asOfMs,
    }),
    inTokens,
    measured,
    scale: inTokens && model.total > 0 ? officialTotal / model.total : null,
    asOfMs,
    groups: model.groups.map(restate),
    machines: model.machines.map(restate),
  };
}

// ── Sub-limits ───────────────────────────────────────────────────────────────

/** Where a sub-limit's figure comes from. */
export type SubLimitSource =
  /** Its own official reading, typed on the dashboard. */
  | "official"
  /** A "share" sub-limit's part of the provider's official figure, by the measured proportion. */
  | "provider"
  /** The machines' measurement against a token limit. */
  | "measured";

export interface SubLimitView {
  sub: SubLimitModel;
  /** Null while nothing tells how much of it is gone. */
  source: SubLimitSource | null;
  /** In fractions of its own budget (`limit` 1). */
  quota: QuotaAssessment | null;
  /** "share": how much of the provider's whole budget it used, 0–1; null otherwise, or while unknown. */
  ofProvider: number | null;
}

/**
 * How far a sub-limit is. Its own official reading comes first. Without one,
 * a "share" sub-limit follows the provider's figure: its measured part of
 * the provider's tokens, over the share it may use. A "separate" one only has
 * the machines' measurement against its own token limit.
 */
export function applySubLimitReading(
  model: DashboardModel,
  view: DashboardView,
  sub: SubLimitModel,
  reading: OfficialReading | null,
): SubLimitView {
  const assess = (fraction: number, nowMs: number) =>
    assessQuota(fraction, 1, { startMs: model.cycle.startMs, endMs: model.cycle.endMs, nowMs });

  if (reading) {
    const fraction = reading.percent / 100;
    return {
      sub,
      source: "official",
      quota: assess(fraction, readingTime(model, reading)),
      ofProvider: sub.shareCap === null ? null : fraction * sub.shareCap,
    };
  }
  // Without a split by model the machines cannot tell its part: better unknown than a false 0%.
  if (!sub.hasSplit) return { sub, source: null, quota: null, ofProvider: null };

  if (sub.shareCap !== null && view.quota) {
    // Its tokens are among the provider's (`model.total`): it takes their proportion of the provider's figure.
    const ofProvider = model.total > 0 ? (view.quota.usedFraction * sub.total) / model.total : 0;
    return {
      sub,
      source: view.calibrated ? "provider" : "measured",
      quota: assess(ofProvider / sub.shareCap, view.asOfMs),
      ofProvider,
    };
  }
  if (sub.quota) {
    return { sub, source: "measured", quota: assess(sub.quota.usedFraction, model.generatedAt), ofProvider: null };
  }
  return { sub, source: null, quota: null, ofProvider: null };
}

/**
 * A sub-limit's figure over the cycle, for the usage chart. Its measured
 * tokens all count at one rate, its figure over all of them, so the line ends
 * on the figure its own field shows, as the provider's total line does. Null
 * while its figure is unknown, or nothing was measured to draw.
 */
export function subLimitTimeline({ sub, quota }: SubLimitView): number[] | null {
  if (!quota || sub.total <= 0) return null;
  const perToken = quota.usedFraction / sub.total;
  return sub.values.map((tokens) => tokens * perToken);
}

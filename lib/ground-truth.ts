import type { DashboardModel, PastSegment } from "@/lib/dashboard";
import { sumOfFigures } from "@/lib/history";
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
 * Everything counts the current segment (lib/dashboard.ts `segment`): after a
 * keep reset, the official percentage is the one since that reset.
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
  /** A closed cycle's segment figures it was restated by (`applySegmentFigures`), one per `model.pastSegments`; absent otherwise. */
  segmentFigures?: (number | null)[];
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

/** A reading taken hours ago says how fast the budget went until then, not until now; never before its segment began. */
function readingTime(model: DashboardModel, reading: OfficialReading): number {
  return Math.min(model.generatedAt, Math.max(model.segment.startMs, reading.atMs ?? model.generatedAt));
}

export function applyGroundTruth(model: DashboardModel, reading: OfficialReading | null): DashboardView {
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
      startMs: model.segment.startMs,
      endMs: model.segment.endMs,
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

/**
 * A closed cycle with keep resets restated by its segments' figures
 * (`model.pastSegments`, one figure per segment, 0–100 or null): the cycle came
 * to their sum, which can pass 100%, and every group and machine gets, for
 * each segment, its part of that segment's measured tokens times the segment's
 * figure, added up. A segment without a figure adds nothing; with none known
 * this is the measured view.
 */
export function applySegmentFigures(model: DashboardModel, figures: (number | null)[]): DashboardView {
  const known = figures.filter((figure): figure is number => figure !== null);
  if (known.length === 0) return applyGroundTruth(model, null);

  const inTokens = model.quota !== null;
  const limit = model.quota?.limit ?? 1;
  // The same rounded sum the field and the list show: 0.08 + 86.07 + 13.85 must be 100, not 99.99999999999999.
  const officialTotal = (sumOfFigures(figures)! / 100) * limit;
  const asOfMs = Math.min(model.generatedAt, model.cycle.endMs);
  const partOf = (tokensIn: (segment: PastSegment) => number) =>
    model.pastSegments.reduce((sum, segment, index) => {
      const figure = figures[index];
      return figure === null || figure === undefined || segment.total <= 0
        ? sum
        : sum + (figure / 100) * (tokensIn(segment) / segment.total);
    }, 0);
  const restate = <T extends { tokens: number }>(row: T, tokensIn: (segment: PastSegment) => number): T => {
    const limitShare = partOf(tokensIn);
    return { ...row, limitShare, tokens: inTokens ? limitShare * limit : row.tokens };
  };

  return {
    calibrated: true,
    quota: assessQuota(officialTotal, limit, { startMs: model.cycle.startMs, endMs: model.cycle.endMs, nowMs: asOfMs }),
    inTokens,
    measured: { total: model.total, usedFraction: model.quota?.usedFraction ?? null },
    scale: inTokens && model.total > 0 ? officialTotal / model.total : null,
    asOfMs,
    groups: model.groups.map((group) =>
      restate(group, (segment) => (Object.hasOwn(segment.groups, group.groupId) ? segment.groups[group.groupId]! : 0)),
    ),
    machines: model.machines.map((machine) =>
      restate(
        machine,
        (segment) =>
          segment.machines.find((row) => row.machineId === machine.machineId && row.groupId === machine.groupId)
            ?.tokens ?? 0,
      ),
    ),
    segmentFigures: figures,
  };
}

/**
 * What one measured token on the timeline (lib/timeline.ts) is as a fraction
 * of the budget, at each of its samples. The current segment's tokens go at
 * the headline figure over its measured tokens (1/limit without a reading).
 * Under an official reading, a finished segment's go at its own before-figure
 * over the tokens measured in it (lib/resets.ts); one whose figure is unknown
 * takes the current rate. A closed cycle's segments (`model.pastSegments`) go
 * at the figures it was restated by (`applySegmentFigures`). Null while
 * nothing tells how much of the budget is gone: no token limit and no reading.
 */
export function timelineRates(model: DashboardModel, view: DashboardView): number[] | null {
  const { quota } = view;
  if (!quota) return null;
  // Right after a reset nothing is measured yet: the segment's samples are all 0, the limit's rate is as good as any.
  const current = model.total > 0 ? quota.usedFraction / model.total : view.inTokens ? 1 / quota.limit : 0;
  if (model.pastSegments.length > 0) return pastSegmentRates(model, view, current);
  const keeps = model.resets.filter((reset) => reset.kind === "keep");
  return model.timeline.times.map((ms) => {
    // The reset that ends the segment this sample falls in; none in the current segment.
    const ending = keeps.find((reset) => reset.atMs > ms);
    if (!ending || !view.calibrated || ending.before === null || !ending.tokens) return current;
    return ending.before / 100 / ending.tokens;
  });
}

/**
 * A closed cycle's rates: each segment's tokens at its own figure over the
 * tokens measured in it. A segment without a figure goes at the token
 * limit's rate, or, without a limit, at the known segments' average rate;
 * every segment does while the view is the measured one.
 */
function pastSegmentRates(model: DashboardModel, view: DashboardView, current: number): number[] {
  const figures = view.segmentFigures;
  if (!figures) return model.timeline.times.map(() => current);
  const known = model.pastSegments.flatMap((segment, index) => {
    const figure = figures[index];
    return figure !== null && figure !== undefined && segment.total > 0 ? [{ figure, total: segment.total }] : [];
  });
  const knownTokens = known.reduce((sum, { total }) => sum + total, 0);
  const fallback =
    view.inTokens && view.quota
      ? 1 / view.quota.limit
      : knownTokens > 0
        ? known.reduce((sum, { figure }) => sum + figure / 100, 0) / knownTokens
        : 0;
  const last = model.pastSegments.length - 1;
  return model.timeline.times.map((ms) => {
    const found = model.pastSegments.findIndex((segment) => ms < segment.endMs);
    const index = found < 0 ? last : found;
    const segment = model.pastSegments[index]!;
    const figure = figures[index];
    return figure === null || figure === undefined || segment.total <= 0 ? fallback : figure / 100 / segment.total;
  });
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

/**
 * How far past `providerUsedFraction` an independently typed `ofProvider` may
 * run before the pair is flagged as mistyped rather than as a rounding gap.
 */
export const SUB_LIMIT_MISMATCH_THRESHOLD = 0.05;

export interface SubLimitView {
  sub: SubLimitModel;
  /** Null while nothing tells how much of it is gone. */
  source: SubLimitSource | null;
  /** In fractions of its own budget (`limit` 1). */
  quota: QuotaAssessment | null;
  /** "share": how much of the provider's whole budget it used, 0–1; null otherwise, or while unknown. */
  ofProvider: number | null;
  /** The provider's own figure at the same moment, whenever one is known; null otherwise. */
  providerUsedFraction: number | null;
  /**
   * True when its own official reading claims more of the provider's whole
   * budget than the provider's own reading admits, past `SUB_LIMIT_MISMATCH_THRESHOLD`:
   * the two figures were typed inconsistently with each other.
   */
  mismatched: boolean;
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
    assessQuota(fraction, 1, { startMs: model.segment.startMs, endMs: model.segment.endMs, nowMs });
  const providerUsedFraction = view.quota?.usedFraction ?? null;

  if (reading) {
    const fraction = reading.percent / 100;
    const ofProvider = sub.shareCap === null ? null : fraction * sub.shareCap;
    // A "share" sub-limit's tokens are among the provider's: its own reading can never
    // honestly claim more of the whole than the provider's own reading admits.
    const mismatched =
      ofProvider !== null &&
      providerUsedFraction !== null &&
      ofProvider - providerUsedFraction > SUB_LIMIT_MISMATCH_THRESHOLD;
    return {
      sub,
      source: "official",
      quota: assess(fraction, readingTime(model, reading)),
      ofProvider,
      providerUsedFraction,
      mismatched,
    };
  }
  // Without a split by model the machines cannot tell its part: better unknown than a false 0%.
  if (!sub.hasSplit)
    return { sub, source: null, quota: null, ofProvider: null, providerUsedFraction, mismatched: false };

  if (sub.shareCap !== null && view.quota) {
    // Its tokens are among the provider's (`model.total`): it takes their proportion of the provider's figure.
    const ofProvider = model.total > 0 ? (view.quota.usedFraction * sub.total) / model.total : 0;
    return {
      sub,
      source: view.calibrated ? "provider" : "measured",
      quota: assess(ofProvider / sub.shareCap, view.asOfMs),
      ofProvider,
      providerUsedFraction,
      mismatched: false,
    };
  }
  if (sub.quota) {
    return {
      sub,
      source: "measured",
      quota: assess(sub.quota.usedFraction, model.generatedAt),
      ofProvider: null,
      providerUsedFraction,
      mismatched: false,
    };
  }
  return { sub, source: null, quota: null, ofProvider: null, providerUsedFraction, mismatched: false };
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

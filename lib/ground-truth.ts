import type { DashboardModel } from "@/lib/dashboard";
import { assessQuota, type QuotaAssessment } from "@/lib/quota";

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
      groups: model.groups,
      machines: model.machines,
    };
  }

  const officialFraction = reading.percent / 100;
  // Without a token limit the budget is 1 and every amount a fraction of it; the pace reads the same.
  const limit = model.quota?.limit ?? 1;
  const officialTotal = officialFraction * limit;
  // A reading taken hours ago says how fast the budget went until then, not until now.
  const asOfMs = Math.min(
    model.generatedAt,
    Math.max(model.cycle.startMs, reading.atMs ?? model.generatedAt),
  );

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
    groups: model.groups.map(restate),
    machines: model.machines.map(restate),
  };
}

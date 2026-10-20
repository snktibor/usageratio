/**
 * The energy and water footprint behind an API-list-price cost estimate: a
 * napkin estimate, never a measurement. No provider publishes per-model
 * figures, so both factors are public estimates, kept here as constants.
 *
 * Energy follows the cost. Simon P. Couch's coding-agent estimate (2026,
 * https://simonpcouch.com/blog/2026-01-20-cc-impact/) back-solves ~390 Wh per
 * million input tokens from Epoch AI's GPT-4o figure, and scales output, cache
 * writes and cache reads by Anthropic's own price ratios (×5, ×1.25, ×0.1).
 * At Claude Opus 4.5's $5 per million input tokens that is a flat ~78 Wh per
 * list-price dollar, whatever the mix of token types — which is exactly what
 * the ccusage cost already accounts for.
 *
 * Water is the total footprint: the data centre's own cooling plus the water
 * used to generate its electricity. Li et al., "Making AI Less 'Thirsty'"
 * (2025, https://arxiv.org/abs/2304.03271), U.S. average: an on-site WUE of
 * 0.55 L/kWh, and 3.14 L/kWh of off-site water at a PUE of 1.17, so
 * 0.55 + 1.17 × 3.14 ≈ 4.2 L per kWh of server energy.
 */

/** Server energy per US dollar of API-list-price cost, in watt-hours. */
export const WH_PER_USD = 78;

/** Total (on-site + off-site) water per kWh of server energy, in litres. */
export const WATER_LITRES_PER_KWH = 4.2;

export interface ResourceEstimate {
  energyKwh: number;
  waterLitres: number;
}

/** The energy and water an API-list-price cost estimate stands for. */
export function estimateResources(costUsd: number): ResourceEstimate {
  const energyKwh = (Math.max(0, costUsd) * WH_PER_USD) / 1000;
  return { energyKwh, waterLitres: energyKwh * WATER_LITRES_PER_KWH };
}

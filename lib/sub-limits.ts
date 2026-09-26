import { summarizeUsage, type TimeWindow, type UsageEvent } from "@/lib/aggregate";
import type { TokenMode } from "@/lib/config";
import { modelKey, modelLabel } from "@/lib/models";
import { assessQuota, type QuotaAssessment } from "@/lib/quota";
import { totalTimeline } from "@/lib/timeline";

/**
 * Sub-limits: a budget measured on some of a provider's models only, such as
 * Claude's separate Fable limit. Either a budget of its own beside the
 * provider's, or a part of the provider's that may use at most a set share of
 * it. The clients' split by model tells how much each one used. Pure.
 */

/**
 * "separate": a budget beside the provider's; its models do not count toward the provider's.
 * "share": part of the provider's budget, of which it may use at most `sharePercent`.
 */
export type SubLimitMode = "separate" | "share";

export interface SubLimit {
  /** Unique within its provider, and kept when the name changes. */
  id: string;
  name: string;
  /**
   * Parts of model ids, in lower case. A model belongs to the first sub-limit
   * one of whose parts its id contains: "fable" takes "claude-fable-5-1".
   */
  models: string[];
  mode: SubLimitMode;
  /** 1–100: the most of the provider's budget it may use. Kept while the mode is "separate". */
  sharePercent: number;
  /** Its own token budget per cycle, for "separate" with the token limits on. Kept otherwise. */
  limit: number;
}

export const MAX_SUB_LIMITS = 5;
export const MAX_SUB_LIMIT_MODELS = 10;
export const MAX_SUB_LIMIT_NAME_LENGTH = 40;

const SUB_LIMIT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MODEL_PART_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function isSubLimitId(value: unknown): value is string {
  return typeof value === "string" && SUB_LIMIT_ID_PATTERN.test(value);
}

/** A model-id part as typed ("Fable ") → as stored ("fable"); null when it is no such part. */
export function normalizeModelPart(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const part = value.trim().toLowerCase();
  return MODEL_PART_PATTERN.test(part) ? part : null;
}

/** A sub-limit's name, trimmed; null unless 1–40 characters without control characters. */
export function normalizeSubLimitName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > MAX_SUB_LIMIT_NAME_LENGTH || /\p{Cc}/u.test(name)) return null;
  return name;
}

/** An id for a new sub-limit, from its name ("Fable 5" → "fable-5"), unique among `taken`. */
export function subLimitIdFor(name: string, taken: string[]): string {
  const base =
    name
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/, "") || "sub-limit";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** The sub-limit a model belongs to: the first with a part its id contains; null for none. */
export function subLimitOf(modelId: string, subLimits: SubLimit[]): SubLimit | null {
  const id = modelId.toLowerCase();
  return subLimits.find((sub) => sub.models.some((part) => id.includes(part))) ?? null;
}

export interface SplitReports {
  /** The provider's own reports: the tokens of its separate sub-limits taken out. */
  main: UsageEvent[];
  /**
   * Each sub-limit's reports, by id: its models' tokens in every report that
   * came with a split by model (zero when the split names none of them).
   * Reports without a split say nothing about any model and are left out.
   */
  bySubLimit: Map<string, UsageEvent[]>;
}

export function splitBySubLimits(events: UsageEvent[], subLimits: SubLimit[]): SplitReports {
  const bySubLimit = new Map(subLimits.map((sub) => [sub.id, [] as UsageEvent[]]));
  if (subLimits.length === 0) return { main: events, bySubLimit };

  const main = events.map((event) => {
    if (!event.models) return event;
    const ofSubLimit = new Map<string, Record<string, number>>();
    const own: Record<string, number> = {};
    let separate = 0;
    for (const [modelId, tokens] of Object.entries(event.models)) {
      const sub = subLimitOf(modelId, subLimits);
      if (sub) ofSubLimit.set(sub.id, { ...ofSubLimit.get(sub.id), [modelId]: tokens });
      if (sub?.mode === "separate") separate += tokens;
      else own[modelId] = tokens;
    }
    for (const sub of subLimits) {
      const models = ofSubLimit.get(sub.id) ?? {};
      const tokens = Object.values(models).reduce((sum, amount) => sum + amount, 0);
      bySubLimit.get(sub.id)!.push({ ...event, tokens, models });
    }
    // The split never adds up to more than the total (lib/validation.ts); the floor guards stored data.
    return separate === 0 ? event : { ...event, tokens: Math.max(0, event.tokens - separate), models: own };
  });
  return { main, bySubLimit };
}

/** A sub-limit and what the machines measured of it this cycle. */
export interface SubLimitModel {
  id: string;
  name: string;
  mode: SubLimitMode;
  /** "share": the most of the provider's budget it may use, 0–1; null for "separate". */
  shareCap: number | null;
  /** Tokens its models measured this cycle. */
  total: number;
  /** Its cumulative tokens at each sample of the dashboard's timeline; the last one is `total`. */
  values: number[];
  /** Whether any report of this cycle came with a split by model: without one nothing is known of it. */
  hasSplit: boolean;
  /** This cycle's models that belong to it, by label, the heaviest first. */
  models: string[];
  /** `total` against its token budget; null while the token limits are off. */
  quota: QuotaAssessment | null;
}

/**
 * `reports` as split by `splitBySubLimits`; `times` are the samples of the
 * dashboard's timeline; `providerLimit` is the provider's token budget, null
 * while the token limits are off.
 */
export function measureSubLimits(
  subLimits: SubLimit[],
  reports: SplitReports["bySubLimit"],
  window: TimeWindow & { nowMs: number },
  times: number[],
  mode: TokenMode,
  providerLimit: number | null,
): SubLimitModel[] {
  return subLimits.map((sub) => {
    const events = reports.get(sub.id) ?? [];
    const inCycle = events.filter((event) => event.ts >= window.startMs && event.ts < window.endMs);
    const total = summarizeUsage(events, window, mode).total;

    // Only orders the labels: each model's largest reading is near enough to its share, in every token mode.
    const tokensByModel = new Map<string, number>();
    for (const event of inCycle) {
      for (const [modelId, tokens] of Object.entries(event.models ?? {})) {
        const key = modelKey(modelId);
        tokensByModel.set(key, Math.max(tokensByModel.get(key) ?? 0, tokens));
      }
    }
    const models = [...tokensByModel]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([key]) => modelLabel(key));

    const shareCap = sub.mode === "share" ? sub.sharePercent / 100 : null;
    const limit = providerLimit === null ? null : shareCap === null ? sub.limit : shareCap * providerLimit;
    return {
      id: sub.id,
      name: sub.name,
      mode: sub.mode,
      shareCap,
      total,
      values: totalTimeline(events, times, window, mode),
      hasSplit: inCycle.length > 0,
      models,
      quota: limit === null ? null : assessQuota(total, limit, window),
    };
  });
}

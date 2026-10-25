import { type CycleSummary, groupSharesOf } from "@/lib/history";

/**
 * All-time totals by group: every cycle a provider ever archived, and its
 * current one so far, added up. The archive itself (`usage:history:*`, see
 * lib/history.ts) keeps only the newest HISTORY_RETENTION cycles, so every
 * archived summary also goes into a ledger that is never trimmed
 * (`usage:alltime:*`, see lib/redis-keys.ts), without the parts these totals
 * do not need. Where both hold a cycle, the archive's summary wins: a
 * correction of its official figure lands there first.
 *
 * A group counts under the id it reported with in each cycle: a machine moved
 * to another group, or a group renamed since, keeps its past usage where it was.
 *
 * Pure; the Redis side (`archiveCycle`, `loadAllTime`) lives in lib/usage-store.ts.
 */

/** A cycle's summary as the ledger keeps it: everything but its models and sub-limits. */
export function ledgerEntryOf(summary: CycleSummary): CycleSummary {
  return { ...summary, models: {}, subLimits: {} };
}

/** Every archived cycle once, oldest first: the archive's summary where it still has one, else the ledger's. */
export function allTimeCycles(ledger: CycleSummary[], history: CycleSummary[]): CycleSummary[] {
  const byStart = new Map<number, CycleSummary>();
  for (const entry of ledger) byStart.set(entry.start, entry);
  for (const entry of history) byStart.set(entry.start, entry);
  return [...byStart.values()].sort((a, b) => a.start - b.start);
}

export interface AllTimeGroup {
  groupId: string;
  tokens: number;
  /** Of all the measured tokens (0–1). */
  share: number;
  /** How many of the cycles it used tokens in. */
  cycles: number;
  /**
   * Its parts of the quota added up over the cycles whose final usage is
   * known (lib/history.ts `groupSharesOf`): 1 is one cycle's whole quota.
   * Null when no cycle it used tokens in has one.
   */
  quota: number | null;
}

export interface AllTimeSummary {
  /** The start of the oldest cycle counted. */
  sinceMs: number;
  /** Cycles with any usage, the current one among them when `includesCurrent`. */
  cycles: number;
  /** How many of `cycles` have a known final usage: the ones `quota` adds up. */
  quotaCycles: number;
  /** Measured tokens. */
  total: number;
  /** The groups' `quota` added up; null when no cycle's final usage is known. */
  quota: number | null;
  /** The current cycle, so far, is among `cycles`. */
  includesCurrent: boolean;
  /** Heaviest first. */
  groups: AllTimeGroup[];
}

/**
 * The totals of `archived` (`allTimeCycles`) and, unless it is one of them,
 * the current cycle so far; null while none of them used any tokens.
 */
export function summarizeAllTime(archived: CycleSummary[], current: CycleSummary | null): AllTimeSummary | null {
  const own = current !== null && !archived.some((entry) => entry.start === current.start) ? current : null;
  const cycles = [...archived, ...(own ? [own] : [])].filter((entry) => entry.total > 0);
  if (cycles.length === 0) return null;

  const groups = new Map<string, AllTimeGroup>();
  let quotaCycles = 0;
  for (const entry of cycles) {
    const shares = groupSharesOf(entry);
    if (shares.some((group) => group.quotaShare !== null)) quotaCycles += 1;
    for (const { groupId, tokens, quotaShare } of shares) {
      const group = groups.get(groupId) ?? { groupId, tokens: 0, share: 0, cycles: 0, quota: null };
      group.tokens += tokens;
      group.cycles += 1;
      if (quotaShare !== null) group.quota = (group.quota ?? 0) + quotaShare;
      groups.set(groupId, group);
    }
  }

  const list = [...groups.values()];
  const total = list.reduce((sum, group) => sum + group.tokens, 0);
  for (const group of list) group.share = total > 0 ? group.tokens / total : 0;
  const quotas = list.flatMap((group) => (group.quota === null ? [] : [group.quota]));
  return {
    sinceMs: cycles[0]!.start,
    cycles: cycles.length,
    quotaCycles,
    total,
    quota: quotas.length > 0 ? quotas.reduce((sum, quota) => sum + quota, 0) : null,
    includesCurrent: own !== null && own.total > 0,
    groups: list.sort((a, b) => b.tokens - a.tokens || a.groupId.localeCompare(b.groupId)),
  };
}

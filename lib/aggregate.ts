import type { TokenMode } from "@/lib/config";

/** One stored report. */
export interface UsageEvent {
  machineId: string;
  groupId: string;
  tokens: number;
  /** Event time, epoch ms. */
  ts: number;
}

/** `startMs` inclusive, `endMs` exclusive. */
export interface TimeWindow {
  startMs: number;
  endMs: number;
}

/** Usage of one machine within one group (a machine normally has exactly one). */
export interface SeriesUsage {
  machineId: string;
  groupId: string;
  tokens: number;
  /** Fraction of the overall usage, 0–1. */
  share: number;
  /** Reports received inside the window. */
  reports: number;
  lastReportAt: number | null;
}

export interface GroupUsage {
  groupId: string;
  tokens: number;
  /** Fraction of the overall usage, 0–1. */
  share: number;
  /** Machines that reported into this group inside the window. */
  machines: number;
}

export interface UsageSummary {
  total: number;
  groups: GroupUsage[];
  series: SeriesUsage[];
}

/** Tokens one series used inside the window; `events` sorted by time, may start before the window. */
function usageOfSeries(events: UsageEvent[], window: TimeWindow, mode: TokenMode): number {
  let usage = 0;
  // Counter mode: the last reading before the window is the baseline.
  let previous: number | null = null;

  for (const event of events) {
    if (event.ts >= window.endMs) break;
    const inWindow = event.ts >= window.startMs;

    if (mode === "delta") {
      if (inWindow) usage += event.tokens;
    } else if (mode === "snapshot") {
      if (inWindow) usage = event.tokens;
    } else {
      if (inWindow && previous !== null) {
        // A reading below the previous one means the counter restarted from zero.
        usage += event.tokens >= previous ? event.tokens - previous : event.tokens;
      }
      previous = event.tokens;
    }
  }
  return usage;
}

/**
 * Aggregates raw reports into per-group and per-machine usage for one window.
 * Pass events from before the window too when available: counter mode uses
 * them as the baseline.
 */
export function summarizeUsage(
  events: UsageEvent[],
  window: TimeWindow,
  mode: TokenMode,
): UsageSummary {
  const bySeries = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const key = JSON.stringify([event.groupId, event.machineId]);
    const list = bySeries.get(key);
    if (list) list.push(event);
    else bySeries.set(key, [event]);
  }

  const series: SeriesUsage[] = [];
  for (const list of bySeries.values()) {
    list.sort((a, b) => a.ts - b.ts);
    const inWindow = list.filter((e) => e.ts >= window.startMs && e.ts < window.endMs);
    const last = inWindow[inWindow.length - 1];
    if (!last) continue;
    series.push({
      machineId: last.machineId,
      groupId: last.groupId,
      tokens: usageOfSeries(list, window, mode),
      share: 0,
      reports: inWindow.length,
      lastReportAt: last.ts,
    });
  }

  const total = series.reduce((sum, s) => sum + s.tokens, 0);

  const groupMap = new Map<string, { tokens: number; machines: Set<string> }>();
  for (const s of series) {
    const group = groupMap.get(s.groupId) ?? { tokens: 0, machines: new Set<string>() };
    group.tokens += s.tokens;
    group.machines.add(s.machineId);
    groupMap.set(s.groupId, group);
    s.share = total > 0 ? s.tokens / total : 0;
  }

  const groups: GroupUsage[] = [...groupMap.entries()].map(([groupId, g]) => ({
    groupId,
    tokens: g.tokens,
    share: total > 0 ? g.tokens / total : 0,
    machines: g.machines.size,
  }));

  groups.sort((a, b) => b.tokens - a.tokens || a.groupId.localeCompare(b.groupId));
  series.sort(
    (a, b) =>
      b.tokens - a.tokens ||
      a.machineId.localeCompare(b.machineId) ||
      a.groupId.localeCompare(b.groupId),
  );

  return { total, groups, series };
}

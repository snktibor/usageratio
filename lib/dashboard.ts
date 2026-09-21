import { summarizeUsage, type UsageEvent } from "@/lib/aggregate";
import type { AppConfig, TokenMode } from "@/lib/config";
import { getCycle, getDaySegments, getPreviousCycle } from "@/lib/cycle";

/** A group the store has seen, with the time of its first report. */
export interface KnownGroup {
  groupId: string;
  firstSeenAt: number;
}

/** The most recent report of a machine, kept even when it is silent this cycle. */
export interface KnownMachine {
  machineId: string;
  groupId: string;
  lastSeenAt: number;
  lastTokens: number;
}

/** Everything the dashboard needs from the store. */
export interface StoreSnapshot {
  /** Reports since the start of the previous cycle. */
  events: UsageEvent[];
  groups: KnownGroup[];
  machines: KnownMachine[];
}

export type QuotaStatus = "good" | "warning" | "critical";
export type MachineHealth = "active" | "late" | "inactive";

export interface DashboardModel {
  generatedAt: number;
  tokenMode: TokenMode;
  timeZone: string;
  limit: number;
  total: number;
  /** total / limit; above 1 when over the limit. */
  usedFraction: number;
  remaining: number;
  overage: number;
  status: QuotaStatus;
  pace: {
    /** Linear projection for the whole cycle; null while it is too early to tell. */
    projectedTotal: number | null;
    /** When the limit runs out at the current pace; null if it lasts until the reset. */
    runOutAt: number | null;
    /** One day's even share of the limit, as a fraction (about 1/7). */
    dailyShare: number;
    /** Too early to project, yet already far beyond a day's share. */
    earlyBurn: boolean;
  };
  previousTotal: number;
  cycle: {
    startMs: number;
    endMs: number;
    elapsedFraction: number;
    segments: { startFraction: number; endFraction: number; weekday: number }[];
  };
  groups: {
    groupId: string;
    tokens: number;
    /** Fraction of this cycle's usage. */
    share: number;
    /** Fraction of the weekly limit. */
    limitShare: number;
    machines: number;
    /** 1–8: categorical colour slot; 0: neutral (more than eight groups). */
    colorSlot: number;
  }[];
  machines: {
    machineId: string;
    groupId: string;
    colorSlot: number;
    tokens: number;
    share: number;
    reports: number;
    lastSeenAt: number;
    health: MachineHealth;
  }[];
}

const COLOR_SLOTS = 8;
/** Usage level that raises a warning regardless of pace. */
const WARNING_FRACTION = 0.8;
/** Bursty usage makes early projections meaningless: wait for one day of data. */
const MIN_ELAPSED_FOR_PROJECTION = 1 / 7;
/** First-day usage above this many daily shares raises a warning without a projection. */
const EARLY_BURN_FACTOR = 2;
const HOUR = 3_600_000;

function healthOf(ageMs: number, reportIntervalMinutes: number): MachineHealth {
  // One missed report is tolerated before a machine counts as late.
  if (ageMs <= (2 * reportIntervalMinutes + 10) * 60_000) return "active";
  if (ageMs <= 24 * HOUR) return "late";
  return "inactive";
}

/** Turns raw store data into everything the dashboard renders. Pure. */
export function buildDashboard(
  now: Date,
  config: AppConfig,
  snapshot: StoreSnapshot,
): DashboardModel {
  const nowMs = now.getTime();
  const cycle = getCycle(now, config.reset);
  const previousCycle = getPreviousCycle(cycle, config.reset);
  const startMs = cycle.start.getTime();
  const endMs = cycle.end.getTime();
  const lengthMs = endMs - startMs;

  const current = summarizeUsage(snapshot.events, { startMs, endMs }, config.tokenMode);
  const previous = summarizeUsage(
    snapshot.events,
    { startMs: previousCycle.start.getTime(), endMs: startMs },
    config.tokenMode,
  );

  const limit = config.weeklyLimit;
  const total = current.total;
  const elapsedFraction = Math.min(1, Math.max(0, (nowMs - startMs) / lengthMs));

  let projectedTotal: number | null = null;
  let runOutAt: number | null = null;
  if (total > 0 && elapsedFraction >= MIN_ELAPSED_FOR_PROJECTION) {
    projectedTotal = total / elapsedFraction;
    if (projectedTotal > limit && total < limit) {
      runOutAt = Math.round(startMs + (limit / total) * (nowMs - startMs));
    }
  }

  // Before a projection exists, only a blatant start is flagged: more than
  // twice a day's even share gone while the first day is not even over.
  const dailyShare = (24 * HOUR) / lengthMs;
  const earlyBurn =
    projectedTotal === null && total < limit && total / limit >= EARLY_BURN_FACTOR * dailyShare;

  let status: QuotaStatus = "good";
  if (total >= limit) status = "critical";
  else if (
    earlyBurn ||
    total / limit >= WARNING_FRACTION ||
    (projectedTotal !== null && projectedTotal > limit)
  ) {
    status = "warning";
  }

  // Colour follows the group for good: slots go by first appearance, never by rank.
  const slotOf = new Map<string, number>();
  const ordered = [...snapshot.groups].sort(
    (a, b) => a.firstSeenAt - b.firstSeenAt || a.groupId.localeCompare(b.groupId),
  );
  const unindexed = current.groups
    .map((g) => g.groupId)
    .filter((id) => !ordered.some((g) => g.groupId === id))
    .sort((a, b) => a.localeCompare(b));
  for (const groupId of [...ordered.map((g) => g.groupId), ...unindexed]) {
    slotOf.set(groupId, slotOf.size < COLOR_SLOTS ? slotOf.size + 1 : 0);
  }

  const machines: DashboardModel["machines"] = current.series.map((s) => {
    const known = snapshot.machines.find((m) => m.machineId === s.machineId);
    const lastSeenAt = Math.max(s.lastReportAt ?? 0, known?.lastSeenAt ?? 0);
    return {
      machineId: s.machineId,
      groupId: s.groupId,
      colorSlot: slotOf.get(s.groupId) ?? 0,
      tokens: s.tokens,
      share: s.share,
      reports: s.reports,
      lastSeenAt,
      health: healthOf(nowMs - lastSeenAt, config.reportIntervalMinutes),
    };
  });

  // Machines that have gone quiet stay listed, so a dead scheduled task is noticed.
  const retentionMs = config.retentionDays * 24 * HOUR;
  const silent = snapshot.machines
    .filter((m) => !machines.some((row) => row.machineId === m.machineId))
    .filter((m) => nowMs - m.lastSeenAt <= retentionMs)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.machineId.localeCompare(b.machineId));
  for (const m of silent) {
    machines.push({
      machineId: m.machineId,
      groupId: m.groupId,
      colorSlot: slotOf.get(m.groupId) ?? 0,
      tokens: 0,
      share: 0,
      reports: 0,
      lastSeenAt: m.lastSeenAt,
      health: healthOf(nowMs - m.lastSeenAt, config.reportIntervalMinutes),
    });
  }

  return {
    generatedAt: nowMs,
    tokenMode: config.tokenMode,
    timeZone: config.reset.timeZone,
    limit,
    total,
    usedFraction: total / limit,
    remaining: Math.max(0, limit - total),
    overage: Math.max(0, total - limit),
    status,
    pace: { projectedTotal, runOutAt, dailyShare, earlyBurn },
    previousTotal: previous.total,
    cycle: {
      startMs,
      endMs,
      elapsedFraction,
      segments: getDaySegments(cycle, config.reset.timeZone).map((segment) => ({
        startFraction: (segment.start.getTime() - startMs) / lengthMs,
        endFraction: (segment.end.getTime() - startMs) / lengthMs,
        weekday: segment.weekday,
      })),
    },
    groups: current.groups.map((g) => ({
      groupId: g.groupId,
      tokens: g.tokens,
      share: g.share,
      limitShare: g.tokens / limit,
      machines: g.machines,
      colorSlot: slotOf.get(g.groupId) ?? 0,
    })),
    machines,
  };
}

import { summarizeUsage, type UsageEvent } from "@/lib/aggregate";
import type { AppConfig, BudgetPeriod, TokenMode } from "@/lib/config";
import { getCycle, getDaySegments, getPreviousCycle } from "@/lib/cycle";
import { assessQuota, type QuotaAssessment } from "@/lib/quota";
import { NEUTRAL_COLOR, resolveGroupColors, type KnownGroup } from "@/lib/settings";

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

export type MachineHealth = "active" | "late" | "inactive";

/**
 * What the machines measured, against the configured limit. The browser may
 * lay an official usage figure over it: see lib/ground-truth.ts.
 */
export interface DashboardModel extends QuotaAssessment {
  generatedAt: number;
  tokenMode: TokenMode;
  timeZone: string;
  period: BudgetPeriod;
  previousTotal: number;
  cycle: {
    startMs: number;
    endMs: number;
    elapsedFraction: number;
    segments: { startFraction: number; endFraction: number; weekday: number; monthDay: number }[];
  };
  groups: {
    groupId: string;
    tokens: number;
    /** Fraction of this cycle's usage. */
    share: number;
    /** Fraction of the limit. */
    limitShare: number;
    machines: number;
    /** "#rrggbb": as set on the settings panel, or drawn when the group first reported. */
    color: string;
  }[];
  machines: {
    machineId: string;
    groupId: string;
    /** The colour of its group. */
    color: string;
    tokens: number;
    /** Fraction of this cycle's usage. */
    share: number;
    /** Fraction of the limit. */
    limitShare: number;
    reports: number;
    lastSeenAt: number;
    health: MachineHealth;
  }[];
}

const HOUR = 3_600_000;

function healthOf(ageMs: number, reportIntervalMinutes: number): MachineHealth {
  // One missed report is tolerated before a machine counts as late.
  if (ageMs <= (2 * reportIntervalMinutes + 10) * 60_000) return "active";
  if (ageMs <= 24 * HOUR) return "late";
  return "inactive";
}

/**
 * Turns raw store data into everything the dashboard renders. Pure.
 * `config` is the effective one: the saved settings already applied.
 */
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

  const limit = config.limit;
  const colorOf = resolveGroupColors(
    snapshot.groups,
    current.groups.map((g) => g.groupId),
  );

  const machines: DashboardModel["machines"] = current.series.map((s) => {
    const known = snapshot.machines.find((m) => m.machineId === s.machineId);
    const lastSeenAt = Math.max(s.lastReportAt ?? 0, known?.lastSeenAt ?? 0);
    return {
      machineId: s.machineId,
      groupId: s.groupId,
      color: colorOf.get(s.groupId) ?? NEUTRAL_COLOR,
      tokens: s.tokens,
      share: s.share,
      limitShare: s.tokens / limit,
      reports: s.reports,
      lastSeenAt,
      health: healthOf(nowMs - lastSeenAt, config.reportIntervalMinutes),
    };
  });

  // Machines that have gone quiet stay listed, so a dead scheduled task is noticed.
  const listedMs = config.inactiveMachineDays * 24 * HOUR;
  const silent = snapshot.machines
    .filter((m) => !machines.some((row) => row.machineId === m.machineId))
    .filter((m) => nowMs - m.lastSeenAt <= listedMs)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.machineId.localeCompare(b.machineId));
  for (const m of silent) {
    machines.push({
      machineId: m.machineId,
      groupId: m.groupId,
      color: colorOf.get(m.groupId) ?? NEUTRAL_COLOR,
      tokens: 0,
      share: 0,
      limitShare: 0,
      reports: 0,
      lastSeenAt: m.lastSeenAt,
      health: healthOf(nowMs - m.lastSeenAt, config.reportIntervalMinutes),
    });
  }

  return {
    ...assessQuota(current.total, limit, { startMs, endMs, nowMs }),
    generatedAt: nowMs,
    tokenMode: config.tokenMode,
    timeZone: config.reset.timeZone,
    period: config.reset.period,
    previousTotal: previous.total,
    cycle: {
      startMs,
      endMs,
      elapsedFraction: Math.min(1, Math.max(0, (nowMs - startMs) / lengthMs)),
      segments: getDaySegments(cycle, config.reset.timeZone).map((segment) => ({
        startFraction: (segment.start.getTime() - startMs) / lengthMs,
        endFraction: (segment.end.getTime() - startMs) / lengthMs,
        weekday: segment.weekday,
        monthDay: segment.monthDay,
      })),
    },
    groups: current.groups.map((g) => ({
      groupId: g.groupId,
      tokens: g.tokens,
      share: g.share,
      limitShare: g.tokens / limit,
      machines: g.machines,
      color: colorOf.get(g.groupId) ?? NEUTRAL_COLOR,
    })),
    machines,
  };
}

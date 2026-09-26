import { summarizeCost, summarizeUsage, type UsageEvent } from "@/lib/aggregate";
import type { AppConfig, BudgetPeriod, TokenMode } from "@/lib/config";
import { getCycle, getDaySegments, getPreviousCycle } from "@/lib/cycle";
import { type OfficialEntryView, officialUsageField } from "@/lib/official-usage";
import { providerLabel } from "@/lib/providers";
import { assessQuota, type QuotaAssessment } from "@/lib/quota";
import {
  configForProvider,
  countsForProvider,
  type KnownGroup,
  NEUTRAL_COLOR,
  resolveGroupColors,
  subLimitsOf,
  visibleProviderIds,
} from "@/lib/settings";
import { measureSubLimits, type SubLimit, type SubLimitModel, splitBySubLimits } from "@/lib/sub-limits";
import { buildTimeline, type CycleTimeline } from "@/lib/timeline";
import type { ReportMode } from "@/lib/validation";

/** The most recent report of a machine, kept even when it is silent this cycle. */
export interface KnownMachine {
  machineId: string;
  groupId: string;
  lastSeenAt: number;
  lastTokens: number;
  /**
   * Optional (and treated as "auto" wherever it is read) so code building a
   * `KnownMachine` outside the store — tests, mainly — need not set it. An
   * older stored entry, or one with no report yet this cycle, reads the
   * same way: "auto" when unknown.
   */
  mode?: ReportMode;
  /** The auto client's own reporting interval in minutes; absent/null unless `mode` is "auto". */
  intervalMinutes?: number | null;
}

/** Everything the dashboard needs from the store. */
export interface StoreSnapshot {
  /** Reports since the start of the previous cycle. */
  events: UsageEvent[];
  groups: KnownGroup[];
  machines: KnownMachine[];
}

/**
 * "manual" is a machine reporting on demand (lib/validation.ts ReportMode
 * "manual"): it is never "late", since there is no schedule to miss.
 */
export type MachineHealth = "active" | "late" | "manual" | "inactive";

/**
 * What the machines measured, and, with the token limits on, how that stands
 * against the limit. The browser may lay an official usage figure over it:
 * see lib/ground-truth.ts.
 */
export interface DashboardModel {
  generatedAt: number;
  tokenMode: TokenMode;
  timeZone: string;
  period: BudgetPeriod;
  /** False: nothing on the page may state the tokens left, nor the overage. */
  showRemaining: boolean;
  /** Tokens the machines measured this cycle; a separate sub-limit's are not among them. */
  total: number;
  /**
   * `total` against the provider's token limit. Null while the token limits
   * are switched off: then only an official reading tells how much of the
   * budget is gone.
   */
  quota: QuotaAssessment | null;
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
    /** Fraction of the limit; null without one. */
    limitShare: number | null;
    machines: number;
    /** "#rrggbb": as set on the settings panel, or drawn when the group first reported. */
    color: string;
  }[];
  /** The groups' measured tokens over the cycle so far, in total and by model; same groups as `groups`. */
  timeline: CycleTimeline;
  /** The provider's sub-limits (such as Claude's Fable), each as its models measured it. */
  subLimits: SubLimitModel[];
  /**
   * An API-list-price cost estimate for this cycle, present only when at
   * least one event of the window carried one (an opt-in; lib/setup.ts COST).
   * Fictional for a subscription plan (Claude Max, ChatGPT Pro...): the UI
   * must always label it as an estimate, never a bill.
   */
  cost?: {
    total: number;
    /** groupId → dollars. */
    byGroup: Record<string, number>;
    /** machineId → dollars. */
    byMachine: Record<string, number>;
    /** modelId (without its snapshot date) → dollars. */
    byModel: Record<string, number>;
  };
  machines: {
    machineId: string;
    groupId: string;
    /** The colour of its group. */
    color: string;
    tokens: number;
    /** Fraction of this cycle's usage. */
    share: number;
    /** Fraction of the limit; null without one. */
    limitShare: number | null;
    reports: number;
    lastSeenAt: number;
    health: MachineHealth;
  }[];
}

/** One provider/account and the complete dashboard calculated for it. */
export interface ProviderDashboardModel {
  id: string;
  label: string;
  dashboard: DashboardModel;
  /** The provider's own ground-truth figure, typed on some browser; null while none is stored for this cycle. */
  officialEntry: OfficialEntryView | null;
  /** Its sub-limits' own figures, by sub-limit id; entries outside the current cycle are already gone. */
  subLimitEntries: Record<string, OfficialEntryView>;
}

const HOUR = 3_600_000;

/**
 * A manual machine has no schedule to be late against: it stays "manual" for
 * as long as a silent one is still listed at all (`inactiveMachineDays`), then
 * "inactive". An auto machine keeps today's thresholds, against its own
 * interval when the report carried one, else the server's default.
 */
function healthOf(
  ageMs: number,
  machine: { mode: ReportMode; intervalMinutes: number | null },
  config: Pick<AppConfig, "reportIntervalMinutes" | "inactiveMachineDays">,
): MachineHealth {
  if (machine.mode === "manual") {
    return ageMs <= config.inactiveMachineDays * 24 * HOUR ? "manual" : "inactive";
  }
  const intervalMinutes = machine.intervalMinutes ?? config.reportIntervalMinutes;
  // One missed report is tolerated before a machine counts as late.
  if (ageMs <= (2 * intervalMinutes + 10) * 60_000) return "active";
  if (ageMs <= 24 * HOUR) return "late";
  return "inactive";
}

/**
 * Turns raw store data into everything the dashboard renders. Pure.
 * `config` is the effective one: the saved settings already applied.
 * `subLimits` are the provider's: a separate one's tokens are taken out of
 * every figure but the models and its own.
 */
export function buildDashboard(
  now: Date,
  config: AppConfig,
  snapshot: StoreSnapshot,
  subLimits: SubLimit[] = [],
): DashboardModel {
  const nowMs = now.getTime();
  const cycle = getCycle(now, config.reset);
  const previousCycle = getPreviousCycle(cycle, config.reset);
  const startMs = cycle.start.getTime();
  const endMs = cycle.end.getTime();
  const lengthMs = endMs - startMs;

  const split = splitBySubLimits(snapshot.events, subLimits);
  const current = summarizeUsage(split.main, { startMs, endMs }, config.tokenMode);
  const previous = summarizeUsage(
    split.main,
    { startMs: previousCycle.start.getTime(), endMs: startMs },
    config.tokenMode,
  );

  const limit = config.useTokenLimits ? config.limit : null;
  const limitShareOf = (tokens: number) => (limit === null ? null : tokens / limit);
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
      limitShare: limitShareOf(s.tokens),
      reports: s.reports,
      lastSeenAt,
      health: healthOf(
        nowMs - lastSeenAt,
        { mode: known?.mode ?? "auto", intervalMinutes: known?.intervalMinutes ?? null },
        config,
      ),
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
      limitShare: limitShareOf(0),
      reports: 0,
      lastSeenAt: m.lastSeenAt,
      health: healthOf(
        nowMs - m.lastSeenAt,
        { mode: m.mode ?? "auto", intervalMinutes: m.intervalMinutes ?? null },
        config,
      ),
    });
  }

  const timeline = buildTimeline(
    split.main,
    current.groups.map((g) => g.groupId),
    { startMs, endMs },
    nowMs,
    config.tokenMode,
    snapshot.events,
  );

  const costSummary = summarizeCost(split.main, { startMs, endMs });
  const cost = costSummary.hasCost
    ? {
        total: costSummary.total,
        byGroup: costSummary.byGroup,
        byMachine: costSummary.byMachine,
        byModel: Object.fromEntries(
          timeline.models.filter((m) => m.cost !== undefined).map((m) => [m.modelId, m.cost!]),
        ),
      }
    : undefined;

  return {
    generatedAt: nowMs,
    tokenMode: config.tokenMode,
    timeZone: config.reset.timeZone,
    period: config.reset.period,
    showRemaining: config.showRemaining,
    total: current.total,
    quota: limit === null ? null : assessQuota(current.total, limit, { startMs, endMs, nowMs }),
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
      limitShare: limitShareOf(g.tokens),
      machines: g.machines,
      color: colorOf.get(g.groupId) ?? NEUTRAL_COLOR,
    })),
    timeline,
    ...(cost && { cost }),
    subLimits: measureSubLimits(
      subLimits,
      split.bySubLimit,
      { startMs, endMs, nowMs },
      timeline.times,
      config.tokenMode,
      limit,
    ),
    machines,
  };
}

/** What the store holds for every provider: see lib/usage-store.ts. */
export interface ProviderStoreSnapshot {
  eventsByProvider: Record<string, UsageEvent[]>;
  groups: KnownGroup[];
  machines: (KnownMachine & { providerId: string })[];
}

/**
 * The dashboard of every provider the settings do not hide. A group's reports
 * of a provider it does not count for are left out of that provider's
 * dashboard, and so are its machines there. `config` is the effective one.
 */
export function buildProviderDashboards(
  now: Date,
  config: AppConfig,
  providerIds: string[],
  store: ProviderStoreSnapshot,
  officialUsage: Map<string, OfficialEntryView> = new Map(),
): ProviderDashboardModel[] {
  return visibleProviderIds(config, providerIds).map((providerId) => {
    const counts = (groupId: string) => countsForProvider(config.excludedProviders, groupId, providerId);
    const subLimits = subLimitsOf(config, providerId);
    return {
      id: providerId,
      label: providerLabel(providerId),
      dashboard: buildDashboard(
        now,
        configForProvider(config, providerId),
        {
          events: (store.eventsByProvider[providerId] ?? []).filter((event) => counts(event.groupId)),
          // All of them: a group's colour must not depend on which provider is selected.
          groups: store.groups,
          machines: store.machines.filter((machine) => machine.providerId === providerId && counts(machine.groupId)),
        },
        subLimits,
      ),
      officialEntry: officialUsage.get(officialUsageField(providerId, null)) ?? null,
      subLimitEntries: Object.fromEntries(
        subLimits.flatMap((sub) => {
          const entry = officialUsage.get(officialUsageField(providerId, sub.id));
          return entry ? [[sub.id, entry]] : [];
        }),
      ),
    };
  });
}

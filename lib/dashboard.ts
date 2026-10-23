import { summarizeCost, summarizeUsage, type TimeWindow, type UsageEvent } from "@/lib/aggregate";
import type { AppConfig, BudgetPeriod, ResetMode, TokenMode } from "@/lib/config";
import { type Cycle, getCycle, getDaySegments, getPreviousCycle } from "@/lib/cycle";
import { type OfficialEntryView, officialUsageField } from "@/lib/official-usage";
import { providerCycle } from "@/lib/provider-cycles";
import { providerLabel } from "@/lib/providers";
import { assessQuota, type QuotaAssessment } from "@/lib/quota";
import {
  keepResetsOf,
  type ProviderResets,
  type ResetEvent,
  type ResetSource,
  resetEventsOf,
  restartStarting,
} from "@/lib/resets";
import { estimateResources, type ResourceEstimate } from "@/lib/resources";
import {
  configForProvider,
  countsForProvider,
  type KnownGroup,
  NEUTRAL_COLOR,
  resetModeOf,
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
  /** The provider's reset events (lib/resets.ts); none: its cycle has no segments. */
  resets?: ResetEvent[];
}

/**
 * "manual" is a machine reporting on demand (lib/validation.ts ReportMode
 * "manual"): it is never "late", since there is no schedule to miss.
 */
export type MachineHealth = "active" | "late" | "manual" | "inactive";

/** One day of a stretch of time, as fractions of it: what the rulers under the meter and the charts lay out. */
export interface DaySpan {
  startFraction: number;
  endFraction: number;
  weekday: number;
  monthDay: number;
}

/** A reset of the cycle on screen (lib/resets.ts): the restart it began with, or one of its keep resets. */
export interface DashboardReset {
  id: string;
  /** R: a whole minute. */
  atMs: number;
  kind: ResetMode;
  /** 0–100, the official figure right before it; null while unknown. A restart's belongs to the previous cycle. */
  before: number | null;
  source: ResetSource;
  /** Keep: the tokens the machines measured in the segment it ended; null for a restart. */
  tokens: number | null;
}

/**
 * What the machines measured, and, with the token limits on, how that stands
 * against the limit. The browser may lay an official usage figure over it:
 * see lib/ground-truth.ts.
 */
export interface DashboardModel {
  generatedAt: number;
  /**
   * A cycle that has already ended, opened from the previous cycles: every
   * figure is final, the charts run to its end, and nothing on the page may
   * project a pace or the tokens left, nor take an official figure.
   */
  closed: boolean;
  tokenMode: TokenMode;
  timeZone: string;
  period: BudgetPeriod;
  /** False: nothing on the page may state the tokens left, nor the overage. */
  showRemaining: boolean;
  /** Tokens the machines measured in the current segment (`segment`); a separate sub-limit's are not among them. */
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
    /** The cycle's days: the chart's ruler. */
    segments: DaySpan[];
  };
  /**
   * The current segment (lib/resets.ts): the stretch since the cycle's last
   * keep reset; the whole cycle while it has none, and for a closed cycle.
   * Every figure but the timeline counts it alone (`total`, `quota`, the
   * groups and machines, the sub-limits, `cost`), and the meter's ruler
   * covers it. It always ends with the cycle.
   */
  segment: { startMs: number; endMs: number; elapsedFraction: number; days: DaySpan[] };
  /** The cycle's resets up to now, oldest first: the restart it began with, then its keep resets; none for a closed cycle. */
  resets: DashboardReset[];
  /** groupId → colour, for every group on the timeline: one that used tokens only before a keep reset is charted, but not among `groups`. */
  groupColors: Record<string, string>;
  groups: {
    groupId: string;
    tokens: number;
    /** Fraction of the segment's usage. */
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
   * An API-list-price cost estimate for this cycle, present only with the
   * settings' cost estimate on and at least one event of the window carrying
   * one (older clients sent one only when set up with COST=1).
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
    /** The energy and water behind `total` (lib/resources.ts). */
    resources: ResourceEstimate;
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

/** What the current figures count from: a keep reset of the cycle ("reset"), or its start ("cycle"). */
export function segmentSince(model: Pick<DashboardModel, "cycle" | "segment">): "reset" | "cycle" {
  return model.segment.startMs > model.cycle.startMs ? "reset" : "cycle";
}

/** One provider/account and the complete dashboard calculated for it. */
export interface ProviderDashboardModel {
  id: string;
  label: string;
  /** How the provider resets a user's usage early (lib/settings.ts `resetModeOf`): what a reset recorded on the dashboard is. */
  resetMode: ResetMode;
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

/** How far `nowMs` is into `span`, 0–1. */
function fractionOf(nowMs: number, span: TimeWindow): number {
  return Math.min(1, Math.max(0, (nowMs - span.startMs) / (span.endMs - span.startMs)));
}

/** The days of `span`, as fractions of it. */
function daySpans(span: Cycle, timeZone: string): DaySpan[] {
  const startMs = span.start.getTime();
  const lengthMs = span.end.getTime() - startMs;
  return getDaySegments(span, timeZone).map((day) => ({
    startFraction: (day.start.getTime() - startMs) / lengthMs,
    endFraction: (day.end.getTime() - startMs) / lengthMs,
    weekday: day.weekday,
    monthDay: day.monthDay,
  }));
}

function dashboardReset(event: ResetEvent, tokens: number | null): DashboardReset {
  return { id: event.id, atMs: event.atMs, kind: event.kind, before: event.before, source: event.source, tokens };
}

/**
 * The cycle on screen, with the cycle before it (the footer's comparison,
 * counter mode's baseline), taken as given rather than worked out from the
 * reset settings: a past one opened from the previous cycles, or the
 * current one with a previous cycle that knows of a restart
 * (lib/provider-cycles.ts `providerCycle`).
 */
export interface CycleWindow {
  cycle: Cycle;
  previous: Cycle;
}

/**
 * Turns raw store data into everything the dashboard renders. Pure.
 * `config` is the effective one: the saved settings already applied.
 * `subLimits` are the provider's: a separate one's tokens are taken out of
 * every figure but the models and its own. `window`: see `CycleWindow`; the
 * snapshot's events must then reach back to its `previous.start`. The
 * provider's keep resets (`snapshot.resets`) split an open cycle into
 * segments: see `DashboardModel.segment`.
 */
export function buildDashboard(
  now: Date,
  config: AppConfig,
  snapshot: StoreSnapshot,
  subLimits: SubLimit[] = [],
  window?: CycleWindow,
): DashboardModel {
  const nowMs = now.getTime();
  const cycle = window?.cycle ?? getCycle(now, config.reset);
  const previousCycle = window?.previous ?? getPreviousCycle(cycle, config.reset);
  const startMs = cycle.start.getTime();
  const endMs = cycle.end.getTime();
  const closed = endMs <= nowMs;
  const cycleWindow = { startMs, endMs };

  // A closed cycle counts whole: adding its segments up is the past-cycle views' job.
  const resetEvents = closed ? [] : (snapshot.resets ?? []);
  const keepResets = keepResetsOf(cycleWindow, resetEvents).filter((reset) => reset.atMs <= nowMs);
  const restart = restartStarting(resetEvents, startMs);
  const resetsMs = keepResets.map((reset) => reset.atMs);
  const segmentStartMs = resetsMs.at(-1) ?? startMs;

  const split = splitBySubLimits(snapshot.events, subLimits);
  const current = summarizeUsage(split.main, cycleWindow, config.tokenMode, segmentStartMs);
  const previous = summarizeUsage(
    split.main,
    { startMs: previousCycle.start.getTime(), endMs: startMs },
    config.tokenMode,
  );
  // The timeline charts the whole cycle: a group that used tokens only before a reset keeps its line.
  const whole = keepResets.length === 0 ? current : summarizeUsage(split.main, cycleWindow, config.tokenMode);
  const chartedIds = [...new Set([...current.groups, ...whole.groups].map((group) => group.groupId))];

  const limit = config.useTokenLimits ? config.limit : null;
  const limitShareOf = (tokens: number) => (limit === null ? null : tokens / limit);
  const colorOf = resolveGroupColors(snapshot.groups, chartedIds);

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
    chartedIds,
    cycleWindow,
    nowMs,
    config.tokenMode,
    snapshot.events,
    resetsMs,
  );

  // The clients price every report; the page shows it only with the settings' cost estimate on.
  const costSummary = config.costEstimate ? summarizeCost(split.main, cycleWindow, segmentStartMs) : null;
  const cost = costSummary?.hasCost
    ? {
        total: costSummary.total,
        byGroup: costSummary.byGroup,
        byMachine: costSummary.byMachine,
        byModel: Object.fromEntries(
          timeline.models.filter((m) => m.cost !== undefined).map((m) => [m.modelId, m.cost!]),
        ),
        resources: estimateResources(costSummary.total),
      }
    : undefined;

  return {
    generatedAt: nowMs,
    closed,
    tokenMode: config.tokenMode,
    timeZone: config.reset.timeZone,
    period: config.reset.period,
    showRemaining: config.showRemaining,
    total: current.total,
    quota: limit === null ? null : assessQuota(current.total, limit, { startMs: segmentStartMs, endMs, nowMs }),
    previousTotal: previous.total,
    cycle: {
      startMs,
      endMs,
      elapsedFraction: fractionOf(nowMs, cycleWindow),
      segments: daySpans(cycle, config.reset.timeZone),
    },
    segment: {
      startMs: segmentStartMs,
      endMs,
      elapsedFraction: fractionOf(nowMs, { startMs: segmentStartMs, endMs }),
      days: daySpans({ start: new Date(segmentStartMs), end: cycle.end }, config.reset.timeZone),
    },
    resets: [
      ...(restart ? [dashboardReset(restart, null)] : []),
      ...keepResets.map((reset, index) =>
        dashboardReset(
          reset,
          summarizeUsage(split.main, { startMs, endMs: reset.atMs }, config.tokenMode, resetsMs[index - 1] ?? startMs)
            .total,
        ),
      ),
    ],
    groups: current.groups.map((g) => ({
      groupId: g.groupId,
      tokens: g.tokens,
      share: g.share,
      limitShare: limitShareOf(g.tokens),
      machines: g.machines,
      color: colorOf.get(g.groupId) ?? NEUTRAL_COLOR,
    })),
    groupColors: Object.fromEntries(chartedIds.map((groupId) => [groupId, colorOf.get(groupId) ?? NEUTRAL_COLOR])),
    // Each model's cost is left out with the rest, so the model chart names none either.
    timeline: config.costEstimate
      ? timeline
      : { ...timeline, models: timeline.models.map(({ cost: _cost, ...model }) => model) },
    ...(cost && { cost }),
    subLimits: measureSubLimits(
      subLimits,
      split.bySubLimit,
      { startMs, endMs, nowMs },
      timeline.times,
      config.tokenMode,
      limit,
      resetsMs,
    ),
    machines,
  };
}

/** What the store holds for every provider: see lib/usage-store.ts. */
export interface ProviderStoreSnapshot {
  eventsByProvider: Record<string, UsageEvent[]>;
  groups: KnownGroup[];
  machines: (KnownMachine & { providerId: string })[];
  /** Every provider's resets, as `loadIndexes` read them (lib/usage-store.ts). */
  resets?: Record<string, ProviderResets>;
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
  window?: CycleWindow,
): ProviderDashboardModel[] {
  return visibleProviderIds(config, providerIds).map((providerId) => {
    const counts = (groupId: string) => countsForProvider(config.excludedProviders, groupId, providerId);
    const subLimits = subLimitsOf(config, providerId);
    const resets = resetEventsOf(store.resets ?? {}, providerId);
    return {
      id: providerId,
      label: providerLabel(providerId),
      resetMode: resetModeOf(config, providerId),
      dashboard: buildDashboard(
        now,
        configForProvider(config, providerId),
        {
          events: (store.eventsByProvider[providerId] ?? []).filter((event) => counts(event.groupId)),
          // All of them: a group's colour must not depend on which provider is selected.
          groups: store.groups,
          machines: store.machines.filter((machine) => machine.providerId === providerId && counts(machine.groupId)),
          resets,
        },
        subLimits,
        // The current cycle's previous one is the cycle a restart cut short, when one began it.
        window ?? providerCycle(now, config, providerId, resets),
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

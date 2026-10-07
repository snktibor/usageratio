import { currentTime } from "@/lib/clock";
import type { BudgetPeriod } from "@/lib/config";
import { getConfig } from "@/lib/config";
import { getCycle, getPreviousCycle } from "@/lib/cycle";
import { buildProviderDashboards, type ProviderDashboardModel } from "@/lib/dashboard";
import { ensureDemoData } from "@/lib/demo/seed";
import { applyGroundTruth, applySubLimitReading, parseOfficialPercent, type SubLimitSource } from "@/lib/ground-truth";
import { currentOfficialEntries, type OfficialEntryView } from "@/lib/official-usage";
import { mergeProviderIds } from "@/lib/providers";
import type { QuotaAssessment, QuotaStatus } from "@/lib/quota";
import { resolveConfig, storedProviderIds } from "@/lib/settings";
import { loadEvents, loadIndexes } from "@/lib/usage-store";

/**
 * GET /api/status: the current cycle's figures in a compact, versioned shape,
 * for the macOS menu bar app (clients/macos). Every number is the one the
 * dashboard shows: the same model (lib/dashboard.ts), with the same official
 * reading laid over it (lib/ground-truth.ts) that the browser applies.
 *
 * `v` only ever changes for a breaking change; new fields are added to v1.
 * Times are ISO 8601 strings, percentages 0–100 (above 100 when over the
 * limit) rounded to two decimals.
 */

export const STATUS_VERSION = 1;

export interface StatusSubLimit {
  id: string;
  name: string;
  /** Of its own budget; null while nothing tells. */
  percent: number | null;
  source: SubLimitSource | null;
  status: QuotaStatus | null;
}

export interface StatusProvider {
  id: string;
  label: string;
  /** How much of the budget is gone; null with the token limits off and no official reading. */
  percent: number | null;
  /** "official": an official reading typed on the dashboard drives `percent`; "estimate": the machines' measurement. */
  source: "official" | "estimate" | null;
  /** The machines' own measurement against the token limit, whichever figure is in the lead; null without a limit. */
  estimatedPercent: number | null;
  /** The moment `percent` is true as of: when the official reading was taken, else now. */
  asOf: string;
  /** Tokens the machines measured this cycle. */
  tokens: number;
  /** The provider's token limit; null while the token limits are off. */
  limit: number | null;
  status: QuotaStatus | null;
  /** Null when `percent` is. */
  pace: {
    /** Linear projection for the whole cycle; null while it is too early to tell. */
    projectedPercent: number | null;
    /** When the budget runs out at the current pace; null if it lasts until the reset. */
    runOutAt: string | null;
  } | null;
  subLimits: StatusSubLimit[];
  /** The newest report of any machine counted for it this cycle; null before the first one. */
  lastReportAt: string | null;
}

export interface StatusPayload {
  v: typeof STATUS_VERSION;
  generatedAt: string;
  cycle: { period: BudgetPeriod; start: string; end: string; timeZone: string };
  /** In the dashboard's own order; the settings' hidden providers are left out. */
  providers: StatusProvider[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const percentOf = (fraction: number) => Math.round(fraction * 10_000) / 100;

function readingOf(entry: OfficialEntryView | null | undefined) {
  if (!entry) return null;
  const { percent } = parseOfficialPercent(entry.raw);
  return percent === null ? null : { percent, atMs: entry.enteredAt };
}

function paceOf(quota: QuotaAssessment): StatusProvider["pace"] {
  const { projectedTotal, runOutAt } = quota.pace;
  return {
    projectedPercent: projectedTotal === null ? null : percentOf(projectedTotal / quota.limit),
    runOutAt: runOutAt === null ? null : iso(runOutAt),
  };
}

function providerStatus(provider: ProviderDashboardModel): StatusProvider {
  const model = provider.dashboard;
  const view = applyGroundTruth(model, readingOf(provider.officialEntry));
  const lastSeen = Math.max(0, ...model.machines.map((machine) => machine.lastSeenAt));

  return {
    id: provider.id,
    label: provider.label,
    percent: view.quota ? percentOf(view.quota.usedFraction) : null,
    source: view.calibrated ? "official" : view.quota ? "estimate" : null,
    estimatedPercent: view.measured.usedFraction === null ? null : percentOf(view.measured.usedFraction),
    asOf: iso(view.asOfMs),
    tokens: model.total,
    limit: model.quota?.limit ?? null,
    status: view.quota?.status ?? null,
    pace: view.quota ? paceOf(view.quota) : null,
    subLimits: model.subLimits.map((sub) => {
      const subView = applySubLimitReading(model, view, sub, readingOf(provider.subLimitEntries[sub.id]));
      return {
        id: sub.id,
        name: sub.name,
        percent: subView.quota ? percentOf(subView.quota.usedFraction) : null,
        source: subView.source,
        status: subView.quota?.status ?? null,
      };
    }),
    lastReportAt: lastSeen > 0 ? iso(lastSeen) : null,
  };
}

/** The payload, from the dashboards of the current cycle. Pure. */
export function buildStatus(
  now: Date,
  cycle: { period: BudgetPeriod; startMs: number; endMs: number; timeZone: string },
  providers: ProviderDashboardModel[],
): StatusPayload {
  return {
    v: STATUS_VERSION,
    generatedAt: now.toISOString(),
    cycle: { period: cycle.period, start: iso(cycle.startMs), end: iso(cycle.endMs), timeZone: cycle.timeZone },
    providers: providers.map(providerStatus),
  };
}

/**
 * Reads the store the way the dashboard's current cycle does
 * (app/[locale]/(dashboard)/page.tsx), minus the lazy archiving: a status
 * lookup only ever reads.
 */
export async function loadStatus(): Promise<StatusPayload> {
  const now = currentTime();
  // Demo mode only: reseeds the synthetic data once it has gone stale.
  await ensureDemoData(now);
  const indexes = await loadIndexes();
  const providerIds = mergeProviderIds(
    indexes.providers.map((provider) => provider.providerId),
    storedProviderIds(indexes.settings),
  );
  const config = resolveConfig(getConfig(), indexes.settings, providerIds);

  const cycle = getCycle(now, config.reset);
  // The previous cycle rides along: counter mode's baseline needs it.
  const previousCycle = getPreviousCycle(cycle, config.reset);
  const { eventsByProvider, groups } = await loadEvents(providerIds, indexes.groups, previousCycle.start.getTime());
  const officialUsage = currentOfficialEntries(indexes.officialUsage, cycle.start.getTime());
  const providers = buildProviderDashboards(
    now,
    config,
    providerIds,
    { eventsByProvider, groups, machines: indexes.machines },
    officialUsage,
  );

  return buildStatus(
    now,
    {
      period: config.reset.period,
      startMs: cycle.start.getTime(),
      endMs: cycle.end.getTime(),
      timeZone: config.reset.timeZone,
    },
    providers,
  );
}

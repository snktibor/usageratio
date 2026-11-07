import type { TimeWindow } from "@/lib/aggregate";
import { ALERT_TTL_SECONDS } from "@/lib/alerts";
import { parseAuditRecord } from "@/lib/api-token";
import { archiveDueCycles } from "@/lib/archive";
import { getConfig, RETENTION_DAYS } from "@/lib/config";
import { pruneExpiredInvites } from "@/lib/invites";
import { log } from "@/lib/log";
import { providerOfOfficialField } from "@/lib/official-usage";
import { currentSegmentStartMs, earliestStartMs, providerCycle } from "@/lib/provider-cycles";
import { alertGuardSegmentMs } from "@/lib/redis-keys";
import { pruneResets, resetEventsOf, resetsOf } from "@/lib/resets";
import { parseStoredSettings, resolveConfig, settingsFromConfig } from "@/lib/settings";
import { type TenantStore, tenantStore } from "@/lib/tenant";
import { deleteTenant } from "@/lib/tenant-deletion";
import { DEFAULT_TENANT } from "@/lib/tenant-id";
import { loadTenantRecord, markHousekept, tenantsByHousekeepingAge } from "@/lib/tenants";
import { pruneRevokedTokens } from "@/lib/tokens";
import { loadEvents, loadIndexes, loadResets, saveResets } from "@/lib/usage-store";

/**
 * Prunes the index hashes (`usage:machines`, `usage:providers`, `usage:groups`,
 * `usage:official`, `usage:resets`) of entries nothing still points to,
 * `usage:tokens` of tokens revoked long enough ago (lib/tokens.ts), and the
 * audit trail of entries older than its retention window. It never touches
 * the raw event ZSETs (`usage:events:{provider}:{group}`), which already
 * self-prune on every report (`storeReport` in lib/usage-store.ts); this is
 * only about the indexes that would otherwise grow forever with dead ids.
 *
 * One step writes instead of pruning: it archives the cycle that just ended
 * into the cycle history (lib/archive.ts), so the history does not depend on
 * someone opening the dashboard during the following cycle.
 *
 * Every step reads the same snapshot (one `loadIndexes(store)` call, or its own
 * read for `usage:tokens`), so a run is idempotent: nothing left behind by one
 * run is missed by a `dryRun` preview, and a second run right after finds
 * nothing left to remove.
 */

const DAY_MS = 86_400_000;
const DEFAULT_AUDIT_RETENTION_DAYS = 365;
/** The longest a cycle (and so a segment of one) can last: a 31-day month, plus a day of slack for DST and late reports. */
const MAX_SEGMENT_DAYS = 32;

export interface HousekeepingStepReport {
  removed: number;
  ids: string[];
}

export interface HousekeepingReport {
  machines: HousekeepingStepReport;
  providers: HousekeepingStepReport;
  groups: HousekeepingStepReport;
  officialUsage: HousekeepingStepReport;
  /** Reset events no longer needed (ids `providerId:eventId`). */
  resets: HousekeepingStepReport;
  tokens: HousekeepingStepReport;
  audit: { removed: number };
  /** Providers whose just-ended cycle this run archived (with `dryRun`: would archive). */
  history: { archived: number; ids: string[] };
  /** Names dropped from the tenant's key registry: alert guards past their expiry. */
  registry: { removed: number };
  dryRun: boolean;
}

function auditRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.AUDIT_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AUDIT_RETENTION_DAYS;
}

/** The `cycleStartMs` of one `usage:official` field's stored JSON; null when it does not parse. */
function officialCycleStartMs(raw: string): number | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const cycleStartMs = value.cycleStartMs;
    return typeof cycleStartMs === "number" && Number.isFinite(cycleStartMs) ? cycleStartMs : null;
  } catch {
    return null;
  }
}

export async function runHousekeeping(
  store: TenantStore,
  now: Date,
  { dryRun }: { dryRun: boolean },
): Promise<HousekeepingReport> {
  const redis = store.redis;
  const indexes = await loadIndexes(store);
  const providerIds = indexes.providers.map((provider) => provider.providerId);
  const cutoffMs = now.getTime() - RETENTION_DAYS * DAY_MS;

  // Step 1: machines silent for longer than the retention window.
  const staleMachines = indexes.machines.filter((machine) => machine.lastSeenAt < cutoffMs);
  const machineFields = staleMachines.map((machine) => `${machine.providerId}:${machine.machineId}`);
  const liveMachineProviderIds = new Set(
    indexes.machines.filter((machine) => machine.lastSeenAt >= cutoffMs).map((machine) => machine.providerId),
  );

  // Whether provider/group pairs have any stored events at all, one round trip.
  const existence = new Map<string, boolean>();
  if (providerIds.length > 0 && indexes.groups.length > 0) {
    const pipeline = redis.pipeline();
    const checks: string[] = [];
    for (const providerId of providerIds) {
      for (const group of indexes.groups) {
        const key = store.keys.events(providerId, group.groupId);
        pipeline.exists(key);
        checks.push(key);
      }
    }
    const results = (await pipeline.exec()).map(Number);
    checks.forEach((key, index) => {
      existence.set(key, results[index] === 1);
    });
  }
  const providerHasEvents = (providerId: string): boolean =>
    indexes.groups.some((group) => existence.get(store.keys.events(providerId, group.groupId)) === true);
  const groupHasEvents = (groupId: string): boolean =>
    providerIds.some((providerId) => existence.get(store.keys.events(providerId, groupId)) === true);

  // Providers the settings document still names, even with nothing stored yet.
  const defaults = settingsFromConfig(getConfig(), []);
  const settings = parseStoredSettings(indexes.settings, defaults);
  const referencedProviders = new Set<string>([
    ...Object.keys(settings.limits),
    ...settings.hiddenProviders,
    ...Object.keys(settings.subLimits),
  ]);

  // Step 2: providers with no events anywhere, no (surviving) machine, unreferenced, and old enough to be dead rather than new.
  const staleProviders = indexes.providers.filter(
    (provider) =>
      provider.firstSeenAt < cutoffMs &&
      !providerHasEvents(provider.providerId) &&
      !liveMachineProviderIds.has(provider.providerId) &&
      !referencedProviders.has(provider.providerId),
  );

  // Step 3: groups with zero events across every provider, old enough to be dead rather than new. A group with any data never qualifies.
  const staleGroups = indexes.groups.filter((group) => group.firstSeenAt < cutoffMs && !groupHasEvents(group.groupId));

  // Step 4: archive the cycle that just ended into `usage:history:{provider}` (lib/archive.ts), the
  // same way the first dashboard render after it does: a cycle nobody looked at is kept all the same.
  // It runs before step 5 deletes that cycle's official-usage entries, and reads the same snapshot.
  const config = resolveConfig(getConfig(), indexes.settings, providerIds);
  const { eventsByProvider } = await loadEvents(
    store,
    providerIds,
    indexes.groups,
    earliestStartMs(now, config, providerIds, "previous"),
    indexes.resets,
  );
  const archived = await archiveDueCycles(store, {
    providerIds,
    config,
    now,
    eventsByProvider,
    rawOfficialUsage: indexes.officialUsage,
    resets: indexes.resets,
    dryRun,
  });

  // Step 5: official-usage entries from an earlier segment or cycle (each provider's own), or that no longer parse.
  const staleOfficialFields = Object.entries(indexes.officialUsage)
    .filter(([field, raw]) => {
      const cycleStartMs = officialCycleStartMs(raw);
      const providerId = providerOfOfficialField(field);
      const currentStartMs = currentSegmentStartMs(now, config, providerId, resetEventsOf(indexes.resets, providerId));
      return cycleStartMs === null || cycleStartMs < currentStartMs;
    })
    .map(([field]) => field);

  // Step 5b: reset events no longer needed (lib/resets.ts `pruneResets`): a keep reset once its
  // cycle is archived (step 4), a restart once its raw reports are gone, and a revert's detection
  // switch once its cycle is over. Only the decision is made here, from the snapshot; the write
  // re-applies it to a fresh read, so a reset recorded meanwhile is not lost.
  const resetPrunes: { providerId: string; cycle: TimeWindow; previousStartMs: number }[] = [];
  const resetIds: string[] = [];
  for (const [providerId, resets] of Object.entries(indexes.resets)) {
    const { cycle, previous } = providerCycle(now, config, providerId, resets.events);
    const window = { startMs: cycle.start.getTime(), endMs: cycle.end.getTime() };
    const previousStartMs = previous.start.getTime();
    const pruned = pruneResets(resets, window, previousStartMs, cutoffMs);
    if (pruned.events.length === resets.events.length && pruned.autoOffCycleStartMs === resets.autoOffCycleStartMs)
      continue;
    for (const event of resets.events) {
      if (!pruned.events.includes(event)) resetIds.push(`${providerId}:${event.id}`);
    }
    resetPrunes.push({ providerId, cycle: window, previousStartMs });
  }

  // Step 6: audit entries past their retention window, in both trails (the shared token's and the
  // per-machine tokens'). A list is newest first, so the first entry (from the head) that is too
  // old marks where the still-current ones end: that many are cut from the tail.
  const auditCutoffMs = now.getTime() - auditRetentionDays() * DAY_MS;
  const auditPrunes: { key: string; removed: number }[] = [];
  for (const key of [store.keys.apiTokenAudit, store.keys.tokensAudit]) {
    const raw = await redis.lrange<string>(key, 0, -1);
    const firstOld = raw.findIndex((item) => {
      const record = parseAuditRecord(String(item));
      return record !== null && record.at < auditCutoffMs;
    });
    if (firstOld >= 0) auditPrunes.push({ key, removed: raw.length - firstOld });
  }
  const auditRemoved = auditPrunes.reduce((sum, prune) => sum + prune.removed, 0);

  // Step 7: per-machine tokens (lib/tokens.ts) revoked long enough ago to forget entirely.
  const tokensPruned = await pruneRevokedTokens(store, now, { dryRun });

  // Step 8: the key registry's alert guards that are certainly gone. A guard is set while its
  // segment runs (a segment lies within one cycle, at most a month) and expires ALERT_TTL_SECONDS
  // later, so one whose segment started more than a month plus that TTL ago has expired, and can
  // never be written again (alerts only guard the current segment): dropping its name cannot race
  // a write. Other names stay: a key that emptied is registered again when it is next written, and
  // a name without its key costs nothing.
  const registryNames = ((await redis.smembers(store.keys.registry)) as unknown[]).map(String);
  const guardCutoffMs = now.getTime() - ALERT_TTL_SECONDS * 1000 - MAX_SEGMENT_DAYS * DAY_MS;
  const expiredGuards = registryNames.filter((name) => {
    const segmentMs = alertGuardSegmentMs(store.keys, name);
    return segmentMs !== null && segmentMs < guardCutoffMs;
  });

  if (!dryRun) {
    if (machineFields.length > 0) await redis.hdel(store.keys.machines, ...machineFields);
    if (staleProviders.length > 0)
      await redis.hdel(store.keys.providers, ...staleProviders.map((provider) => provider.providerId));
    if (staleGroups.length > 0) await redis.hdel(store.keys.groups, ...staleGroups.map((group) => group.groupId));
    if (staleOfficialFields.length > 0) await redis.hdel(store.keys.officialUsage, ...staleOfficialFields);
    if (resetPrunes.length > 0) {
      const fresh = await loadResets(store);
      for (const { providerId, cycle, previousStartMs } of resetPrunes) {
        await saveResets(store, providerId, pruneResets(resetsOf(fresh, providerId), cycle, previousStartMs, cutoffMs));
      }
    }
    // Cut from the tail, by count: an entry pushed to the head since the read above stays.
    for (const { key, removed } of auditPrunes) await redis.ltrim(key, 0, -(removed + 1));
    if (expiredGuards.length > 0) await redis.srem(store.keys.registry, ...(expiredGuards as [string, ...string[]]));
  }

  const report: HousekeepingReport = {
    machines: { removed: machineFields.length, ids: machineFields },
    providers: { removed: staleProviders.length, ids: staleProviders.map((provider) => provider.providerId) },
    groups: { removed: staleGroups.length, ids: staleGroups.map((group) => group.groupId) },
    officialUsage: { removed: staleOfficialFields.length, ids: staleOfficialFields },
    resets: { removed: resetIds.length, ids: resetIds },
    tokens: tokensPruned,
    audit: { removed: auditRemoved },
    history: { archived: archived.length, ids: archived },
    registry: { removed: expiredGuards.length },
    dryRun,
  };

  for (const [step, { removed, ids }] of Object.entries({
    machines: report.machines,
    providers: report.providers,
    groups: report.groups,
    official_usage: report.officialUsage,
    resets: report.resets,
    tokens: report.tokens,
  })) {
    if (removed > 0) log.info(`housekeeping.${step}_pruned`, { removed, ids, dryRun });
  }
  if (auditRemoved > 0) log.info("housekeeping.audit_pruned", { removed: auditRemoved, dryRun });
  if (expiredGuards.length > 0)
    log.info("housekeeping.registry_pruned", { removed: expiredGuards.length, ids: expiredGuards, dryRun });
  if (archived.length > 0)
    log.info("housekeeping.history_archived", { archived: archived.length, ids: archived, dryRun });
  log.info("housekeeping.run", {
    dryRun,
    machines: report.machines.removed,
    providers: report.providers.removed,
    groups: report.groups.removed,
    officialUsage: report.officialUsage.removed,
    resets: report.resets.removed,
    tokens: report.tokens.removed,
    audit: report.audit.removed,
    archived: report.history.archived,
    registry: report.registry.removed,
  });

  if (!dryRun) await redis.set(store.keys.housekeepingLast, JSON.stringify({ at: now.getTime(), report }));

  return report;
}

/** What one cron run did across the tenants (`runScheduledHousekeeping`). */
export interface TenantsHousekeepingSummary {
  /** Tenants whose housekeeping ran to the end. */
  processed: number;
  /** Tenants whose housekeeping threw: logged and skipped, the others still ran. */
  failed: number;
  /** Tenants left for the next run because the time budget ran out. */
  pending: number;
}

/** How long one cron run may keep starting tenants: well inside Vercel's 300-second function limit. */
export const HOUSEKEEPING_BUDGET_MS = 240_000;

/**
 * The daily cron run (app/api/cron/housekeeping/route.ts): every tenant's
 * housekeeping, the one housekept longest ago first, until the time budget is
 * spent. A tenant not reached is first in line the next day; one that throws
 * is logged, skipped and stamped like the others (so it cannot starve them by
 * going first every day). A dry run stamps nothing. The budget is only checked
 * before a tenant starts: the route's maxDuration (300 s) leaves room for the
 * one that is running when it runs out.
 *
 * `report` is the default tenant's report (the whole story on a single-tenant
 * instance); null when this run did not reach it.
 */
export async function runScheduledHousekeeping(
  now: Date,
  options: { dryRun: boolean; budgetMs?: number; elapsedMs?: () => number },
): Promise<{ report: HousekeepingReport | null; tenants: TenantsHousekeepingSummary }> {
  const { dryRun, budgetMs = HOUSEKEEPING_BUDGET_MS } = options;
  const started = performance.now();
  const elapsedMs = options.elapsedMs ?? (() => performance.now() - started);

  const order = await tenantsByHousekeepingAge();
  const summary: TenantsHousekeepingSummary = { processed: 0, failed: 0, pending: 0 };
  let report: HousekeepingReport | null = null;
  for (const [index, tenantId] of order.entries()) {
    if (elapsedMs() >= budgetMs) {
      summary.pending = order.length - index;
      log.warn("housekeeping.budget_spent", { pending: summary.pending, budgetMs });
      break;
    }
    try {
      // A tenant whose deletion was cut short is not housekept (that would write to it): the
      // deletion is finished instead, and the tenant is gone from the order for good.
      if ((await loadTenantRecord(tenantId))?.status === "deleting") {
        if (!dryRun) await deleteTenant(tenantId, now);
        summary.processed += 1;
        continue;
      }
      const tenantReport = await runHousekeeping(tenantStore(tenantId), now, { dryRun });
      if (tenantId === DEFAULT_TENANT) report = tenantReport;
      // The invite keys expire on their own; their listing entries are dropped here.
      const invitesPruned = await pruneExpiredInvites(tenantId, now, dryRun);
      if (invitesPruned > 0) log.info("housekeeping.invites_pruned", { tenantId, count: invitesPruned, dryRun });
      if (!dryRun) await markHousekept(tenantId, now.getTime());
      summary.processed += 1;
    } catch (error) {
      summary.failed += 1;
      log.error("housekeeping.tenant_failed", { tenantId, err: error });
      // Stamped all the same, so a tenant that keeps failing goes to the back of the line instead
      // of taking the budget first every day.
      if (!dryRun) await markHousekept(tenantId, now.getTime()).catch(() => undefined);
    }
  }
  return { report, tenants: summary };
}

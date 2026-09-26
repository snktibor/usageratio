import { parseAuditRecord } from "@/lib/api-token";
import { getConfig, RETENTION_DAYS } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import { log } from "@/lib/log";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { parseStoredSettings, resolveConfig, settingsFromConfig } from "@/lib/settings";
import { pruneRevokedTokens } from "@/lib/tokens";
import { loadIndexes } from "@/lib/usage-store";

/**
 * Prunes the index hashes (`usage:machines`, `usage:providers`, `usage:groups`,
 * `usage:official`) of entries nothing still points to, `usage:tokens` of
 * tokens revoked long enough ago (lib/tokens.ts), and the audit trail of
 * entries older than its retention window. It never touches the raw event
 * ZSETs (`usage:events:{provider}:{group}`), which already self-prune on
 * every report (`storeReport` in lib/usage-store.ts); this is only about the
 * indexes that would otherwise grow forever with dead ids.
 *
 * Every step reads the same snapshot (one `loadIndexes()` call, or its own
 * read for `usage:tokens`), so a run is idempotent: nothing left behind by one
 * run is missed by a `dryRun` preview, and a second run right after finds
 * nothing left to remove.
 */

const DAY_MS = 86_400_000;
const DEFAULT_AUDIT_RETENTION_DAYS = 365;

export interface HousekeepingStepReport {
  removed: number;
  ids: string[];
}

export interface HousekeepingReport {
  machines: HousekeepingStepReport;
  providers: HousekeepingStepReport;
  groups: HousekeepingStepReport;
  officialUsage: HousekeepingStepReport;
  tokens: HousekeepingStepReport;
  audit: { removed: number };
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

export async function runHousekeeping(now: Date, { dryRun }: { dryRun: boolean }): Promise<HousekeepingReport> {
  const redis = getRedis();
  const indexes = await loadIndexes();
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
        const key = KEYS.events(providerId, group.groupId);
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
    indexes.groups.some((group) => existence.get(KEYS.events(providerId, group.groupId)) === true);
  const groupHasEvents = (groupId: string): boolean =>
    providerIds.some((providerId) => existence.get(KEYS.events(providerId, groupId)) === true);

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

  // Step 4: official-usage entries from a cycle that has since rolled over, or that no longer parse.
  const config = resolveConfig(getConfig(), indexes.settings, providerIds);
  const cycle = getCycle(now, config.reset);
  const staleOfficialFields = Object.entries(indexes.officialUsage)
    .filter(([, raw]) => {
      const cycleStartMs = officialCycleStartMs(raw);
      return cycleStartMs === null || cycleStartMs < cycle.start.getTime();
    })
    .map(([field]) => field);

  // Step 5: audit entries past their retention window. The list is newest first, so the first
  // (from the head) that is too old marks where the still-current entries end.
  const auditRaw = await redis.lrange<string>(KEYS.apiTokenAudit, 0, -1);
  const auditCutoffMs = now.getTime() - auditRetentionDays() * DAY_MS;
  let auditKeep = auditRaw.length;
  for (let index = 0; index < auditRaw.length; index += 1) {
    const record = parseAuditRecord(String(auditRaw[index]));
    if (record && record.at < auditCutoffMs) {
      auditKeep = index;
      break;
    }
  }
  const auditRemoved = auditRaw.length - auditKeep;

  // Step 6: per-machine tokens (lib/tokens.ts) revoked long enough ago to forget entirely.
  const tokensPruned = await pruneRevokedTokens(now, { dryRun });

  if (!dryRun) {
    if (machineFields.length > 0) await redis.hdel(KEYS.machines, ...machineFields);
    if (staleProviders.length > 0)
      await redis.hdel(KEYS.providers, ...staleProviders.map((provider) => provider.providerId));
    if (staleGroups.length > 0) await redis.hdel(KEYS.groups, ...staleGroups.map((group) => group.groupId));
    if (staleOfficialFields.length > 0) await redis.hdel(KEYS.officialUsage, ...staleOfficialFields);
    if (auditRemoved > 0) {
      if (auditKeep === 0) await redis.del(KEYS.apiTokenAudit);
      else await redis.ltrim(KEYS.apiTokenAudit, 0, auditKeep - 1);
    }
  }

  const report: HousekeepingReport = {
    machines: { removed: machineFields.length, ids: machineFields },
    providers: { removed: staleProviders.length, ids: staleProviders.map((provider) => provider.providerId) },
    groups: { removed: staleGroups.length, ids: staleGroups.map((group) => group.groupId) },
    officialUsage: { removed: staleOfficialFields.length, ids: staleOfficialFields },
    tokens: tokensPruned,
    audit: { removed: auditRemoved },
    dryRun,
  };

  for (const [step, { removed, ids }] of Object.entries({
    machines: report.machines,
    providers: report.providers,
    groups: report.groups,
    official_usage: report.officialUsage,
    tokens: report.tokens,
  })) {
    if (removed > 0) log.info(`housekeeping.${step}_pruned`, { removed, ids, dryRun });
  }
  if (auditRemoved > 0) log.info("housekeeping.audit_pruned", { removed: auditRemoved, dryRun });
  log.info("housekeeping.run", {
    dryRun,
    machines: report.machines.removed,
    providers: report.providers.removed,
    groups: report.groups.removed,
    officialUsage: report.officialUsage.removed,
    tokens: report.tokens.removed,
    audit: report.audit.removed,
  });

  if (!dryRun) await redis.set(KEYS.housekeepingLast, JSON.stringify({ at: now.getTime(), report }));

  return report;
}

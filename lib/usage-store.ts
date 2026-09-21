import type { UsageEvent } from "@/lib/aggregate";
import type { KnownGroup, KnownMachine, StoreSnapshot } from "@/lib/dashboard";
import { getRedis, toStringRecord } from "@/lib/redis";
import type { UsageReport } from "@/lib/validation";

/**
 * Redis layout
 *
 *   usage:events:{groupId}  ZSET  score = report time (epoch ms)
 *                                 member = {"m": machineId, "t": tokens, "ts": ms}
 *   usage:groups            HASH  groupId   → first-seen time (ms)
 *   usage:machines          HASH  machineId → {"g": groupId, "ts": ms, "t": tokens}
 *
 * One time-ordered set per group makes both filters a single native command:
 * a group is a key, a period is a score range (ZRANGE … BYSCORE). The weekly
 * reset therefore needs no job and deletes nothing — the cycle is just the
 * lower bound of the query, and changing the reset time re-slices history.
 * Members are unique per (machine, tokens, time), so a retried POST is a no-op.
 */
const KEYS = {
  groups: "usage:groups",
  machines: "usage:machines",
  events: (groupId: string) => `usage:events:${groupId}`,
};

const DAY_MS = 86_400_000;

/** Persists one report. `duplicate` is true when the identical report was already stored. */
export async function storeReport(
  report: UsageReport,
  now: Date,
  retentionDays: number,
): Promise<{ duplicate: boolean }> {
  const eventsKey = KEYS.events(report.groupId);
  const member = JSON.stringify({ m: report.machineId, t: report.tokens, ts: report.timestampMs });
  const lastReport = JSON.stringify({ g: report.groupId, ts: report.timestampMs, t: report.tokens });

  const tx = getRedis().multi();
  tx.hsetnx(KEYS.groups, report.groupId, String(now.getTime()));
  tx.zadd(eventsKey, { nx: true }, { score: report.timestampMs, member });
  tx.zremrangebyscore(eventsKey, 0, now.getTime() - retentionDays * DAY_MS);
  tx.expire(eventsKey, (retentionDays + 1) * 86_400);
  tx.hset(KEYS.machines, { [report.machineId]: lastReport });
  const results: unknown[] = await tx.exec();

  return { duplicate: Number(results[1]) === 0 };
}

function parseEvent(raw: unknown, groupId: string): UsageEvent | null {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (typeof value !== "object" || value === null) return null;
    const { m, t, ts } = value as Record<string, unknown>;
    if (typeof m !== "string" || typeof t !== "number" || typeof ts !== "number") return null;
    if (!Number.isFinite(t) || t < 0 || !Number.isFinite(ts)) return null;
    return { machineId: m, groupId, tokens: t, ts };
  } catch {
    return null;
  }
}

function parseMachine(machineId: string, raw: string): KnownMachine | null {
  try {
    const { g, ts, t } = JSON.parse(raw) as Record<string, unknown>;
    if (typeof g !== "string" || typeof ts !== "number" || !Number.isFinite(ts)) return null;
    return { machineId, groupId: g, lastSeenAt: ts, lastTokens: typeof t === "number" ? t : 0 };
  } catch {
    return null;
  }
}

/** Loads all reports since `sinceMs`, plus the group and machine indexes. Two round trips. */
export async function loadSnapshot(sinceMs: number): Promise<StoreSnapshot> {
  const redis = getRedis();

  const indexes = redis.pipeline();
  indexes.hgetall(KEYS.groups);
  indexes.hgetall(KEYS.machines);
  const [rawGroups, rawMachines]: unknown[] = await indexes.exec();

  const groups: KnownGroup[] = Object.entries(toStringRecord(rawGroups)).map(
    ([groupId, firstSeen]) => ({ groupId, firstSeenAt: Number(firstSeen) || 0 }),
  );
  const machines: KnownMachine[] = Object.entries(toStringRecord(rawMachines))
    .map(([machineId, raw]) => parseMachine(machineId, raw))
    .filter((machine): machine is KnownMachine => machine !== null);

  const events: UsageEvent[] = [];
  if (groups.length > 0) {
    const ranges = redis.pipeline();
    for (const group of groups) {
      ranges.zrange(KEYS.events(group.groupId), sinceMs, "+inf", { byScore: true });
    }
    const results: unknown[] = await ranges.exec();

    results.forEach((members, index) => {
      const groupId = groups[index]?.groupId;
      if (groupId === undefined || !Array.isArray(members)) return;
      for (const raw of members) {
        // Entries that do not parse (e.g. edited by hand) are skipped, not fatal.
        const event = parseEvent(raw, groupId);
        if (event) events.push(event);
      }
    });
  }

  return { events, groups, machines };
}

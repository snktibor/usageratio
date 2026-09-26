import { getConfig } from "@/lib/config";
import { buildDemoDataset, DEMO_PROVIDERS, type DemoDataset } from "@/lib/demo/dataset";
import { isDemoMode } from "@/lib/demo/mode";
import { ingestReport } from "@/lib/ingest";
import { log } from "@/lib/log";
import { getRedis } from "@/lib/redis";
import { archiveCycle, registerProviders, saveOfficialUsage, saveSettings } from "@/lib/usage-store";

/**
 * Writes the synthetic dataset (lib/demo/dataset.ts) into the store through
 * the very same code the real clients and the settings panel use: every
 * report goes through `ingestReport` with `now` set to the report's own time,
 * so validation, cycles and checkpoints are exercised, not bypassed.
 *
 * Two callers: `npm run seed` (scripts/seed.ts) fills a developer's Redis,
 * and demo mode (`DEMO_MODE=1`) seeds the in-memory store at start-up and
 * again once it has grown stale.
 */

/** Demo mode reseeds the store once it is older than this, so the machines never drift to "late". */
export const DEMO_STALE_MS = 30 * 60_000;

const SEEDED_AT_KEY = "usage:demo:seededAt";
const SEEDING_LOCK_KEY = "usage:demo:seeding";

/** Only the usage data. Sessions, login counters and the stored API token are never touched. */
const DATA_KEYS = ["usage:settings", "usage:providers", "usage:groups", "usage:machines", "usage:official"];
const DATA_KEY_PATTERNS = ["usage:events:*", "usage:history:*", "usage:demo:*"];

export interface SeedOptions {
  now: Date;
  /** Delete the existing usage data first. */
  wipe?: boolean;
  /** Build and count, write nothing. */
  dryRun?: boolean;
  dataset?: DemoDataset;
}

export interface SeedSummary {
  wiped: number;
  reports: number;
  stored: number;
  duplicates: number;
  /** Reports the validator refused, with the reason; empty when the dataset is sound. */
  invalid: string[];
  official: number;
  /** Archived cycles written (lib/history.ts); the dashboard's own lazy archiving adds more on read. */
  history: number;
}

async function scanKeys(pattern: string): Promise<string[]> {
  const redis = getRedis();
  const keys: string[] = [];
  let cursor = "0";
  do {
    // With automatic deserialization off the cursor comes back as a string; a number is accepted too.
    const page = (await redis.scan(cursor, { match: pattern, count: 200 })) as [string | number, string[]];
    cursor = String(page[0]);
    keys.push(...page[1]);
  } while (cursor !== "0");
  return keys;
}

/** Deletes the usage data (settings, indexes, events, official figures); returns how many keys went. */
export async function wipeUsageData(): Promise<number> {
  const patterned = await Promise.all(DATA_KEY_PATTERNS.map(scanKeys));
  const keys = [...new Set([...DATA_KEYS, ...patterned.flat()])];
  if (keys.length === 0) return 0;
  return Number(await getRedis().del(...keys));
}

/** The dataset for `now`, split in the time zone the server validates the days in. */
export function demoDatasetFor(now: Date, seed?: number): DemoDataset {
  return buildDemoDataset(now, { timeZone: getConfig().reset.timeZone, ...(seed !== undefined && { seed }) });
}

export async function seedStore(options: SeedOptions): Promise<SeedSummary> {
  const { now, wipe = false, dryRun = false } = options;
  const dataset = options.dataset ?? demoDatasetFor(now);
  const summary: SeedSummary = {
    wiped: 0,
    reports: dataset.reports.length,
    stored: 0,
    duplicates: 0,
    invalid: [],
    official: dataset.official.length,
    history: dataset.history.length,
  };
  if (dryRun) return summary;

  if (wipe) summary.wiped = await wipeUsageData();

  // The settings first: they decide the cycle every report's checkpoints fall in.
  // Dated at the first report, so the groups look as old as their data.
  const firstReportAt = new Date(dataset.reports[0]?.timestampMs ?? now.getTime());
  const providerIds = DEMO_PROVIDERS.map((provider) => provider.id);
  const saved = await saveSettings(dataset.settings, firstReportAt, providerIds);
  if (!saved.ok)
    throw new Error(`Seeding stopped: groups with reports would be removed (${saved.groupsWithReports.join(", ")}).`);
  // The accounts in the dataset's order (Claude first), not in whichever order the first reports name them.
  await registerProviders(providerIds, firstReportAt.getTime() - 60_000);

  // Oldest first, one machine's reports in order: the machine index keeps the latest report of each.
  for (const report of dataset.reports) {
    const result = await ingestReport(report.body, new Date(report.timestampMs));
    if (!result.ok) {
      const reason = "errors" in result ? result.errors.join("; ") : `too many ${result.refused.split("_")[2]}`;
      summary.invalid.push(`${report.machineId} @ ${new Date(report.timestampMs).toISOString()}: ${reason}`);
      continue;
    }
    if (result.duplicate) summary.duplicates += 1;
    else summary.stored += 1;
  }

  for (const entry of dataset.official) {
    const { enteredAtMs, ...update } = entry;
    await saveOfficialUsage(update, new Date(enteredAtMs));
  }

  // Pre-archived cycles (lib/demo/dataset.ts): the dashboard's own lazy archiving
  // (app/[locale]/(dashboard)/page.tsx) only ever reaches the cycle right before the current
  // one, so the rest of the "Previous cycles" section is seeded directly.
  for (const entry of dataset.history) {
    await archiveCycle(entry.providerId, entry.summary);
  }
  return summary;
}

export type DemoDataState = "off" | "fresh" | "busy" | "seeded";

/**
 * Demo mode: (re)seeds the store when it is empty or older than
 * `DEMO_STALE_MS`. A short lock keeps concurrent renders from seeding twice;
 * the loser simply renders what is there. Does nothing outside demo mode, so
 * a real store can never be overwritten by accident.
 */
export async function ensureDemoData(now: Date): Promise<DemoDataState> {
  if (!isDemoMode()) return "off";
  const redis = getRedis();
  const seededAt = Number(await redis.get(SEEDED_AT_KEY));
  if (Number.isFinite(seededAt) && seededAt > 0 && now.getTime() - seededAt < DEMO_STALE_MS) return "fresh";

  const lock = await redis.set(SEEDING_LOCK_KEY, "1", { nx: true, ex: 60 });
  if (lock !== "OK") return "busy";
  try {
    const summary = await seedStore({ now, wipe: true });
    await redis.set(SEEDED_AT_KEY, String(now.getTime()));
    log.info("demo.seeded", { reports: summary.stored, invalid: summary.invalid.length, at: now.toISOString() });
    if (summary.invalid.length > 0) log.warn("demo.invalid_reports", { invalid: summary.invalid.slice(0, 5) });
    return "seeded";
  } finally {
    await redis.del(SEEDING_LOCK_KEY);
  }
}

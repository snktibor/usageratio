import { getConfig, type TokenMode } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import { earliestCycle } from "@/lib/provider-cycles";
import { resetFor, resolveConfig } from "@/lib/settings";
import { loadRawSettings, type StoreReportRefusal, storeReport } from "@/lib/usage-store";
import { parseUsageReport, type UsageReport } from "@/lib/validation";

/**
 * One report, from JSON to the store: validated against `now`, placed in the
 * cycle the saved settings define, written with its day and hour checkpoints.
 *
 * `POST /api/usage` answers with what this returns. An empty `providers`
 * object is a heartbeat (see lib/validation.ts `parseProviders` and
 * lib/usage-store.ts `storeReport`): nothing but the group is written, and
 * `heartbeat: true` comes back so the route can tell the client apart from an
 * ordinary stored report.
 *
 * The demo seed (lib/demo/seed.ts) feeds it backdated reports with `now` set
 * to each report's own time, so the clock-skew and age checks pass without
 * any bypass.
 */

export type IngestResult =
  | { ok: false; errors: string[] }
  /** Refused before writing anything: a registry cap (lib/usage-store.ts) would be exceeded. */
  | { ok: false; refused: StoreReportRefusal; limit: number }
  | {
      ok: true;
      report: UsageReport;
      duplicate: boolean;
      newGroup: boolean;
      newProviders: string[];
      heartbeat: boolean;
      /** The earliest current cycle among the report's providers (the shared reset's for a heartbeat), when the settings could be read. */
      cycle: { start: Date; end: Date } | null;
      tokenMode: TokenMode;
    };

export async function ingestReport(body: unknown, now: Date): Promise<IngestResult> {
  const config = getConfig();

  // The settings panel's saved time zone (once there is one) is the effective
  // one, over the env/deploy default: read it before validating, so `days` is
  // checked against the same zone the cycle (and its checkpoints) use below.
  // A failed read falls back to the env/default zone and skips the cycle
  // lookup entirely, so the report is still stored, just without checkpoints.
  const rawSettings = await loadRawSettings().catch(() => undefined);
  const resolved = rawSettings === undefined ? null : resolveConfig(config, rawSettings);
  const timeZone = resolved?.reset.timeZone ?? config.reset.timeZone;

  const parsed = parseUsageReport(body, {
    now,
    maxClockSkewMinutes: config.maxClockSkewMinutes,
    retentionDays: config.retentionDays,
    timeZone,
  });
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  // The cycle the report falls in bounds its checkpoints (lib/days.ts): each
  // provider's own, since a provider can have its own reset. A report must
  // not fail over it: without the settings it is stored alone, and the next
  // report brings the same checkpoints along.
  const reportAt = new Date(parsed.report.timestampMs);
  const reportCycle = resolved && {
    timeZone: resolved.reset.timeZone,
    startMs: (providerId: string) => getCycle(reportAt, resetFor(resolved, providerId)).start.getTime(),
  };

  const stored = await storeReport(parsed.report, now, config.retentionDays, reportCycle);
  if (!stored.ok) return stored;

  // The earliest current cycle among the report's providers: what the client counted from.
  const cycle = resolved && earliestCycle(now, resolved, Object.keys(parsed.report.providers)).cycle;
  return { report: parsed.report, ...stored, cycle, tokenMode: config.tokenMode };
}

import { apiError, json, requireSession, withApiHandler } from "@/lib/api";
import { currentTime } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { dateInTimeZone, getCycle, getPreviousCycle } from "@/lib/cycle";
import {
  buildExportCsv,
  buildExportJsonPayload,
  type ExportInput,
  exportFilename,
  parseExportQuery,
} from "@/lib/export";
import { mergeProviderIds, providerLabel } from "@/lib/providers";
import { resolveConfig, storedProviderIds, visibleProviderIds } from "@/lib/settings";
import { loadEvents, loadHistory, loadIndexes } from "@/lib/usage-store";

/**
 * GET /api/export — the raw reports of one cycle, plus every archived cycle,
 * for one provider or every visible one. Session-gated read; allowed in demo
 * mode (isAuthenticated() there is always true, see lib/auth.ts), since it
 * only reads.
 *
 *   GET ?format=csv|json &cycle=current|previous (default "current") &provider=<id> (default: every visible provider)
 *
 * CSV columns: provider,groupId,machineId,timestamp,tokens,checkpoint,models
 * JSON shape: { generatedAt, timeZone, cycle: {start,end}, providers: [{ id, label, events, history }] }
 *
 * 200 ok (a file download, `Content-Disposition: attachment`) · 400 bad query ·
 * 401 no session · 404 unknown provider · 503 Redis down
 */

export const GET = withApiHandler("api/export", async ({ url }) => {
  const unauthorized = await requireSession();
  if (unauthorized) return unauthorized;

  const parsed = parseExportQuery(url.searchParams);
  if (!parsed.ok) return apiError("invalid_payload", 400, { details: parsed.errors });
  const { format, cycle: cycleChoice, providerId } = parsed.query;

  const now = currentTime();
  const indexes = await loadIndexes();
  const allProviderIds = mergeProviderIds(
    indexes.providers.map((provider) => provider.providerId),
    storedProviderIds(indexes.settings),
  );
  if (providerId && !allProviderIds.includes(providerId)) return apiError("not_found", 404);

  const config = resolveConfig(getConfig(), indexes.settings, allProviderIds);
  const cycle = getCycle(now, config.reset);
  const previousCycle = getPreviousCycle(cycle, config.reset);
  const window = cycleChoice === "previous" ? previousCycle : cycle;
  const windowMs = { startMs: window.start.getTime(), endMs: window.end.getTime() };

  // One round trip covers both cycles, whichever was asked for.
  const { eventsByProvider } = await loadEvents(allProviderIds, indexes.groups, previousCycle.start.getTime());
  const targetProviderIds = providerId ? [providerId] : visibleProviderIds(config, allProviderIds);
  const historyByProvider = await loadHistory(targetProviderIds);

  const input: ExportInput = {
    generatedAtMs: now.getTime(),
    timeZone: config.reset.timeZone,
    cycle: windowMs,
    providers: targetProviderIds.map((id) => ({
      id,
      label: providerLabel(id),
      events: (eventsByProvider[id] ?? []).filter((event) => event.ts >= windowMs.startMs && event.ts < windowMs.endMs),
      history: historyByProvider[id] ?? [],
    })),
  };

  const filename = exportFilename(providerId, dateInTimeZone(now, config.reset.timeZone), format);
  const headers = { "Content-Disposition": `attachment; filename="${filename}"` };

  if (format === "csv") {
    return new Response(buildExportCsv(input), {
      status: 200,
      headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store", ...headers },
    });
  }
  return json({ ...buildExportJsonPayload(input) }, 200, headers);
});

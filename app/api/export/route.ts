import { apiError, json, requireSession, withApiHandler } from "@/lib/api";
import { currentTime } from "@/lib/clock";
import { getConfig } from "@/lib/config";
import { dateInTimeZone } from "@/lib/cycle";
import {
  buildExportCsv,
  buildExportJsonPayload,
  type ExportInput,
  exportFilename,
  parseExportQuery,
} from "@/lib/export";
import { earliestCycle, earliestStartMs, providerCycle } from "@/lib/provider-cycles";
import { mergeProviderIds, providerLabel } from "@/lib/providers";
import { resetEventsOf } from "@/lib/resets";
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
 * CSV columns: provider,groupId,machineId,timestamp,tokens,checkpoint,models,costUsd
 * JSON shape: { generatedAt, timeZone, cycle: {start,end}, providers: [{ id, label, cycle: {start,end}, events, history }] }
 * (the top-level cycle is the earliest provider's; each provider carries its own window)
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
  const targetProviderIds = providerId ? [providerId] : visibleProviderIds(config, allProviderIds);
  const windowOf = (id: string) => {
    const { cycle, previous } = providerCycle(now, config, id, resetEventsOf(indexes.resets, id));
    const window = cycleChoice === "previous" ? previous : cycle;
    return { startMs: window.start.getTime(), endMs: window.end.getTime() };
  };
  const earliest = earliestCycle(now, config, targetProviderIds);
  const earliestWindow = cycleChoice === "previous" ? earliest.previous : earliest.cycle;

  // One round trip covers both cycles of every provider, whichever was asked for.
  const { eventsByProvider } = await loadEvents(
    allProviderIds,
    indexes.groups,
    earliestStartMs(now, config, targetProviderIds, "previous"),
    indexes.resets,
  );
  const historyByProvider = await loadHistory(targetProviderIds);

  const input: ExportInput = {
    generatedAtMs: now.getTime(),
    timeZone: config.reset.timeZone,
    cycle: { startMs: earliestWindow.start.getTime(), endMs: earliestWindow.end.getTime() },
    providers: targetProviderIds.map((id) => {
      const window = windowOf(id);
      return {
        id,
        label: providerLabel(id),
        cycle: window,
        events: (eventsByProvider[id] ?? []).filter((event) => event.ts >= window.startMs && event.ts < window.endMs),
        history: historyByProvider[id] ?? [],
      };
    }),
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

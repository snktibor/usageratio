import { getConfig } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import { mergeProviderIds } from "@/lib/providers";
import { StorageNotConfiguredError } from "@/lib/redis";
import { safeEqual } from "@/lib/security";
import { resolveConfig, storedProviderIds } from "@/lib/settings";
import { loadRawSettings, loadReportContext, storeReport } from "@/lib/usage-store";
import { parseUsageReport } from "@/lib/validation";

/**
 * POST /api/usage — ingest endpoint for the client scripts.
 *
 *   Authorization: Bearer <USAGE_API_TOKEN>
 *   { "machineId": "mac-studio", "groupId": "Personal",
 *     "providers": { "deepseek": 15000, "claude": 22000 },
 *     "timestamp": "2026-09-21T10:00:00Z" }
 *
 * A `groupId` that is not on the settings panel's list is added to it with a
 * random colour (`"groupRegistered": true` in the response).
 * GET with the same Bearer token returns the current cycle and its ccusage
 * `sinceDate`, so clients can build a true cycle-to-date snapshot.
 *
 * 201 stored · 200 identical report already stored · 400 bad JSON/payload ·
 * 401 bad token · 413 body too large · 500 server misconfigured · 503 Redis down
 */

const MAX_BODY_BYTES = 4096;
const MIN_TOKEN_LENGTH = 16;

function json(body: Record<string, unknown>, status: number, headers?: Record<string, string>) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function authorize(request: Request): Response | null {
  const expectedToken = process.env.USAGE_API_TOKEN?.trim();
  if (!expectedToken || expectedToken.length < MIN_TOKEN_LENGTH) {
    console.error(
      `[usageratio] USAGE_API_TOKEN is missing or shorter than ${MIN_TOKEN_LENGTH} characters.`,
    );
    return json({ error: "server_misconfigured" }, 500);
  }

  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!bearer?.[1] || !safeEqual(bearer[1], expectedToken)) {
    return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="usage"' });
  }
  return null;
}

function dateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Current server-side cycle, used by clients to filter ccusage daily output. */
export async function GET(request: Request): Promise<Response> {
  const unauthorized = authorize(request);
  if (unauthorized) return unauthorized;

  try {
    const config = getConfig();
    const context = await loadReportContext();
    const providerIds = mergeProviderIds(context.providerIds, storedProviderIds(context.settings));
    const effective = resolveConfig(config, context.settings, providerIds);
    const cycle = getCycle(new Date(), effective.reset);
    return json(
      {
        tokenMode: effective.tokenMode,
        providers: providerIds,
        cycle: {
          start: cycle.start.toISOString(),
          end: cycle.end.toISOString(),
          sinceDate: dateInTimeZone(cycle.start, effective.reset.timeZone),
          timeZone: effective.reset.timeZone,
        },
      },
      200,
    );
  } catch (error) {
    if (error instanceof StorageNotConfiguredError) {
      console.error(`[usageratio] ${error.message}`);
      return json({ error: "storage_not_configured" }, 503);
    }
    console.error("[usageratio] Reading the current usage cycle failed:", error);
    return json({ error: "storage_unavailable" }, 503, { "Retry-After": "60" });
  }
}

export async function POST(request: Request): Promise<Response> {
  const unauthorized = authorize(request);
  if (unauthorized) return unauthorized;

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return json({ error: "unreadable_body" }, 400);
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large", maxBytes: MAX_BODY_BYTES }, 413);
  }

  let body: unknown;
  try {
    // PowerShell 5.1 may prepend a UTF-8 byte order mark.
    body = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const config = getConfig();
  const now = new Date();
  const parsed = parseUsageReport(body, {
    now,
    maxClockSkewMinutes: config.maxClockSkewMinutes,
    retentionDays: config.retentionDays,
  });
  if (!parsed.ok) return json({ error: "invalid_payload", details: parsed.errors }, 400);

  let stored: Awaited<ReturnType<typeof storeReport>>;
  let rawSettings: string | null | undefined;
  try {
    [stored, rawSettings] = await Promise.all([
      storeReport(parsed.report, now, config.retentionDays),
      // Only feeds the informational `cycle` below. A stored report must never be
      // answered with an error (the client would send its tokens again), so a
      // failed read just leaves the cycle out.
      loadRawSettings().catch(() => undefined),
    ]);
  } catch (error) {
    if (error instanceof StorageNotConfiguredError) {
      console.error(`[usageratio] ${error.message}`);
      return json({ error: "storage_not_configured" }, 503);
    }
    console.error("[usageratio] Storing a report failed:", error);
    return json({ error: "storage_unavailable" }, 503, { "Retry-After": "60" });
  }

  const cycle =
    rawSettings === undefined ? null : getCycle(now, resolveConfig(config, rawSettings).reset);
  return json(
    {
      ok: true,
      duplicate: stored.duplicate,
      groupRegistered: stored.newGroup,
      providersRegistered: stored.newProviders,
      report: parsed.report,
      tokenMode: config.tokenMode,
      cycle: cycle && { start: cycle.start.toISOString(), end: cycle.end.toISOString() },
    },
    stored.duplicate ? 200 : 201,
  );
}

import { getConfig } from "@/lib/config";
import { getCycle } from "@/lib/cycle";
import { StorageNotConfiguredError } from "@/lib/redis";
import { safeEqual } from "@/lib/security";
import { storeReport } from "@/lib/usage-store";
import { parseUsageReport } from "@/lib/validation";

/**
 * POST /api/usage — ingest endpoint for the client scripts.
 *
 *   Authorization: Bearer <USAGE_API_TOKEN>
 *   { "machineId": "mac-studio", "groupId": "Personal", "tokens": 1234,
 *     "timestamp": "2026-09-21T10:00:00Z" }
 *
 * 201 stored · 200 identical report already stored · 400 bad JSON/payload ·
 * 401 bad token · 413 body too large · 500 server misconfigured · 503 Redis down
 */

const MAX_BODY_BYTES = 4096;
const MIN_TOKEN_LENGTH = 16;

function json(body: Record<string, unknown>, status: number, headers?: Record<string, string>) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export async function POST(request: Request): Promise<Response> {
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

  let duplicate: boolean;
  try {
    ({ duplicate } = await storeReport(parsed.report, now, config.retentionDays));
  } catch (error) {
    if (error instanceof StorageNotConfiguredError) {
      console.error(`[usageratio] ${error.message}`);
      return json({ error: "storage_not_configured" }, 503);
    }
    console.error("[usageratio] Storing a report failed:", error);
    return json({ error: "storage_unavailable" }, 503, { "Retry-After": "60" });
  }

  const cycle = getCycle(now, config.reset);
  return json(
    {
      ok: true,
      duplicate,
      report: parsed.report,
      tokenMode: config.tokenMode,
      cycle: { start: cycle.start.toISOString(), end: cycle.end.toISOString() },
    },
    duplicate ? 200 : 201,
  );
}

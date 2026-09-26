import type { UsageEvent } from "@/lib/aggregate";
import type { CycleSummary } from "@/lib/history";
import { normalizeProviderId } from "@/lib/providers";

/**
 * `GET /api/export`: the raw reports of one cycle, as CSV or JSON, plus every
 * archived cycle for context. Pure; the route (app/api/export/route.ts) only
 * loads the data and picks the response's headers.
 */

export type ExportFormat = "csv" | "json";
export type ExportCycleChoice = "current" | "previous";

export interface ExportQuery {
  format: ExportFormat;
  cycle: ExportCycleChoice;
  /** null: every visible provider. */
  providerId: string | null;
}

export type ExportQueryResult = { ok: true; query: ExportQuery } | { ok: false; errors: string[] };

/** Reads `format`, `cycle` (default "current") and `provider` off the request's query string. */
export function parseExportQuery(params: URLSearchParams): ExportQueryResult {
  const errors: string[] = [];

  const rawFormat = params.get("format");
  const format: ExportFormat | null = rawFormat === "csv" || rawFormat === "json" ? rawFormat : null;
  if (!format) errors.push('format must be "csv" or "json"');

  const rawCycle = params.get("cycle") ?? "current";
  const cycle: ExportCycleChoice | null = rawCycle === "current" || rawCycle === "previous" ? rawCycle : null;
  if (!cycle) errors.push('cycle must be "current" or "previous"');

  let providerId: string | null = null;
  const rawProvider = params.get("provider");
  if (rawProvider !== null) {
    providerId = normalizeProviderId(rawProvider);
    if (!providerId) errors.push("provider must be a valid provider id");
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, query: { format: format!, cycle: cycle!, providerId } };
}

export interface ExportProviderInput {
  id: string;
  label: string;
  /** Already filtered to the requested cycle's window. */
  events: UsageEvent[];
  /** Every cycle archived for it, newest first (lib/history.ts); not filtered by the requested cycle. */
  history: CycleSummary[];
}

export interface ExportInput {
  generatedAtMs: number;
  timeZone: string;
  cycle: { startMs: number; endMs: number };
  providers: ExportProviderInput[];
}

export interface ExportEventRow {
  provider: string;
  groupId: string;
  machineId: string;
  /** ISO 8601. */
  timestamp: string;
  tokens: number;
  checkpoint: boolean;
  models: Record<string, number> | null;
}

/** Every provider's events of the requested cycle, one flat, deterministically ordered list. */
export function buildExportRows(input: ExportInput): ExportEventRow[] {
  return input.providers
    .flatMap((provider) =>
      provider.events.map(
        (event): ExportEventRow => ({
          provider: provider.id,
          groupId: event.groupId,
          machineId: event.machineId,
          timestamp: new Date(event.ts).toISOString(),
          tokens: event.tokens,
          checkpoint: event.checkpoint === true,
          models: event.models ?? null,
        }),
      ),
    )
    .sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp) ||
        a.provider.localeCompare(b.provider) ||
        a.groupId.localeCompare(b.groupId) ||
        a.machineId.localeCompare(b.machineId),
    );
}

const CSV_HEADER = ["provider", "groupId", "machineId", "timestamp", "tokens", "checkpoint", "models"] as const;

/** RFC 4180: a field is quoted, its own quotes doubled, only when it needs to be. */
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(values: string[]): string {
  return values.map(csvField).join(",");
}

/** CSV of one cycle's reports, CRLF line endings, columns exactly `provider,groupId,machineId,timestamp,tokens,checkpoint,models`. */
export function buildExportCsv(input: ExportInput): string {
  const lines = [csvRow([...CSV_HEADER])];
  for (const row of buildExportRows(input)) {
    lines.push(
      csvRow([
        row.provider,
        row.groupId,
        row.machineId,
        row.timestamp,
        String(row.tokens),
        String(row.checkpoint),
        row.models ? JSON.stringify(row.models) : "",
      ]),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export interface ExportJsonPayload {
  generatedAt: string;
  timeZone: string;
  cycle: { start: string; end: string };
  providers: {
    id: string;
    label: string;
    events: ExportEventRow[];
    history: CycleSummary[];
  }[];
}

/** The `{ generatedAt, timeZone, cycle, providers }` document. */
export function buildExportJsonPayload(input: ExportInput): ExportJsonPayload {
  return {
    generatedAt: new Date(input.generatedAtMs).toISOString(),
    timeZone: input.timeZone,
    cycle: { start: new Date(input.cycle.startMs).toISOString(), end: new Date(input.cycle.endMs).toISOString() },
    providers: input.providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      events: buildExportRows({ ...input, providers: [provider] }),
      history: provider.history,
    })),
  };
}

/** "usageratio-<provider|all>-<YYYY-MM-DD>.<ext>" */
export function exportFilename(providerId: string | null, dateStamp: string, format: ExportFormat): string {
  return `usageratio-${providerId ?? "all"}-${dateStamp}.${format}`;
}

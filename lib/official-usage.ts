import { parseOfficialPercent } from "@/lib/ground-truth";
import { normalizeProviderId } from "@/lib/providers";
import { isSubLimitId } from "@/lib/sub-limits";

/**
 * The official-usage figures typed on the dashboard: the provider's own, and
 * one per sub-limit. They used to live in the browser's localStorage, one
 * account per machine; now they are stored in Redis (see lib/usage-store.ts)
 * so every browser on the account reads and writes the same figure, and the
 * dashboard's own polling (see components/auto-refresh.tsx) is what carries a
 * fresh one from one browser to the others.
 *
 * A stored entry is tagged with the cycle it was typed in — an official
 * percentage means nothing once the budget has reset — and the reader drops
 * it once that cycle is no longer the current one.
 */

/** What a browser shows for the field: the text as typed, and when that was. */
export interface OfficialEntryView {
  raw: string;
  enteredAt: number;
}

interface StoredOfficialEntry extends OfficialEntryView {
  cycleStartMs: number;
}

export const OFFICIAL_USAGE_RAW_MAX_LENGTH = 16;

/** The Redis hash field for a provider's own figure, or one of its sub-limits'. */
export function officialUsageField(providerId: string, subLimitId: string | null): string {
  return subLimitId === null ? providerId : `${providerId}:${subLimitId}`;
}

function parseStoredEntry(raw: string): StoredOfficialEntry | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { raw: text, enteredAt, cycleStartMs } = value as Record<string, unknown>;
  if (typeof text !== "string" || typeof enteredAt !== "number" || typeof cycleStartMs !== "number") return null;
  if (!Number.isFinite(enteredAt) || !Number.isFinite(cycleStartMs)) return null;
  return { raw: text, enteredAt, cycleStartMs };
}

export function serializeOfficialEntry(entry: StoredOfficialEntry): string {
  return JSON.stringify(entry);
}

/** The provider a `usage:official` field belongs to: "claude" or "claude:fable" → "claude". */
export function providerOfOfficialField(field: string): string {
  const colon = field.indexOf(":");
  return colon < 0 ? field : field.slice(0, colon);
}

/**
 * The stored entries whose cycle still matches, by field: what every browser
 * should show right now. One typed in a cycle that has since rolled over is
 * as good as absent. `cycleStart`: the current cycle's start, or, now that a
 * provider can have its own reset, each provider's (by provider id).
 */
export function currentOfficialEntries(
  stored: Record<string, string>,
  cycleStart: number | ((providerId: string) => number),
): Map<string, OfficialEntryView> {
  const startOf = typeof cycleStart === "number" ? () => cycleStart : cycleStart;
  const entries = new Map<string, OfficialEntryView>();
  for (const [field, raw] of Object.entries(stored)) {
    const entry = parseStoredEntry(raw);
    if (entry && entry.cycleStartMs === startOf(providerOfOfficialField(field)))
      entries.set(field, { raw: entry.raw, enteredAt: entry.enteredAt });
  }
  return entries;
}

/** One stored entry, with the cycle it was saved for; null when it does not parse. */
export function parseStoredOfficialEntry(raw: string): { view: OfficialEntryView; cycleStartMs: number } | null {
  const entry = parseStoredEntry(raw);
  return entry && { view: { raw: entry.raw, enteredAt: entry.enteredAt }, cycleStartMs: entry.cycleStartMs };
}

export interface OfficialUsageUpdate {
  providerId: string;
  subLimitId: string | null;
  /** Empty clears the field. */
  raw: string;
  cycleStartMs: number;
}

export type OfficialUsageParseResult = { ok: true; update: OfficialUsageUpdate } | { ok: false; errors: string[] };

export function parseOfficialUsageUpdate(input: unknown): OfficialUsageParseResult {
  if (typeof input !== "object" || input === null) return { ok: false, errors: ["body must be an object"] };
  const { providerId: rawProviderId, subLimitId, raw, cycleStartMs } = input as Record<string, unknown>;

  const errors: string[] = [];
  const providerId = normalizeProviderId(rawProviderId);
  if (!providerId) errors.push("providerId must be a valid provider id");
  if (subLimitId !== null && !isSubLimitId(subLimitId)) errors.push("subLimitId must be a valid sub-limit id, or null");
  if (typeof raw !== "string" || raw.length > OFFICIAL_USAGE_RAW_MAX_LENGTH) {
    errors.push(`raw must be a string of at most ${OFFICIAL_USAGE_RAW_MAX_LENGTH} characters`);
  }
  if (typeof cycleStartMs !== "number" || !Number.isFinite(cycleStartMs)) {
    errors.push("cycleStartMs must be a finite number");
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    update: {
      providerId: providerId!,
      subLimitId: subLimitId as string | null,
      raw: raw as string,
      cycleStartMs: cycleStartMs as number,
    },
  };
}

/** What to write for a parsed update: null clears the field (an empty `raw`). */
export function storedEntryFor(update: OfficialUsageUpdate, enteredAt: number): string | null {
  if (update.raw.trim() === "") return null;
  return serializeOfficialEntry({ raw: update.raw, enteredAt, cycleStartMs: update.cycleStartMs });
}

/**
 * A correction of a finished cycle's official percentage: the figure frozen
 * into its archived summary (lib/history.ts), which `usage:official` no
 * longer holds once the cycle is over. Only the provider's own figure is
 * archived, so a sub-limit has nothing to correct.
 */
export interface ArchivedOfficialUpdate {
  providerId: string;
  /** The archived cycle's start: its summary's score in `usage:history:{providerId}`. */
  cycleStartMs: number;
  /** 0–100; null clears it (an empty `raw`). */
  official: number | null;
}

export type ArchivedOfficialParseResult =
  | { ok: true; update: ArchivedOfficialUpdate }
  | { ok: false; errors: string[] };

export function parseArchivedOfficialUpdate(input: unknown): ArchivedOfficialParseResult {
  if (typeof input !== "object" || input === null) return { ok: false, errors: ["body must be an object"] };
  const { providerId: rawProviderId, raw, cycleStartMs } = input as Record<string, unknown>;

  const errors: string[] = [];
  const providerId = normalizeProviderId(rawProviderId);
  if (!providerId) errors.push("providerId must be a valid provider id");
  const parsed =
    typeof raw === "string" && raw.length <= OFFICIAL_USAGE_RAW_MAX_LENGTH ? parseOfficialPercent(raw) : null;
  if (parsed === null || parsed.invalid) errors.push("raw must be a percentage between 0 and 100, or empty");
  if (typeof cycleStartMs !== "number" || !Number.isFinite(cycleStartMs)) {
    errors.push("cycleStartMs must be a finite number");
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    update: { providerId: providerId!, cycleStartMs: cycleStartMs as number, official: parsed!.percent },
  };
}

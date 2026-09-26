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

/**
 * The stored entries whose cycle still matches, by field: what every browser
 * should show right now. One typed in a cycle that has since rolled over is
 * as good as absent.
 */
export function currentOfficialEntries(
  stored: Record<string, string>,
  cycleStartMs: number,
): Map<string, OfficialEntryView> {
  const entries = new Map<string, OfficialEntryView>();
  for (const [field, raw] of Object.entries(stored)) {
    const entry = parseStoredEntry(raw);
    if (entry && entry.cycleStartMs === cycleStartMs)
      entries.set(field, { raw: entry.raw, enteredAt: entry.enteredAt });
  }
  return entries;
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

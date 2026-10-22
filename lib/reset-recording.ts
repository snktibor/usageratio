import type { TimeWindow } from "@/lib/aggregate";
import type { ResetMode, ResetOverride } from "@/lib/config";
import { parseOfficialPercent } from "@/lib/ground-truth";
import {
  OFFICIAL_USAGE_RAW_MAX_LENGTH,
  parseStoredOfficialEntry,
  providerOfOfficialField,
  type StoredOfficialReading,
  serializeOfficialEntry,
} from "@/lib/official-usage";
import { normalizeProviderId } from "@/lib/providers";
import {
  addReset,
  beforeFromRaw,
  cycleResets,
  isResetId,
  keepResetsOf,
  MINUTE_MS,
  type ProviderResets,
  type ResetEvent,
  type ResetSource,
  restartOverride,
  sameOverride,
  segmentStartAt,
} from "@/lib/resets";

/**
 * Recording a usage reset by hand (and the rules a detected one follows
 * too): what may be recorded, edited or deleted in the current cycle, and
 * what each change does to the provider's resets and its own reset. Pure;
 * lib/reset-store.ts writes the result, /api/resets is the route.
 *
 * A keep reset may fall anywhere in (cycle start, now]. A restart ends the
 * cycle, so it must come after the cycle's last keep reset; a cycle that
 * began with one can edit it, but only to before its own first keep reset.
 */

export type ResetRefusal = "outside_cycle" | "duplicate_reset" | "has_later_resets" | "not_found" | "not_revertable";

export interface ResetContext {
  now: Date;
  /** The provider's mode now: what a new reset is recorded as. */
  mode: ResetMode;
  /** The provider's current cycle. */
  cycle: TimeWindow;
  resets: ProviderResets;
  /** The provider's own reset now; null: it uses the shared one. */
  override: ResetOverride | null;
  timeZone: string;
}

export type ResetChange =
  | { ok: false; refused: ResetRefusal }
  | {
      ok: true;
      resets: ProviderResets;
      /** The reset recorded or edited, as it now stands; for a delete, as it stood. */
      event: ResetEvent;
      /** The provider's own reset to store: absent leaves it alone, null removes it. */
      override?: ResetOverride | null;
    };

const refuse = (refused: ResetRefusal): ResetChange => ({ ok: false, refused });
const byTime = (a: ResetEvent, b: ResetEvent) => a.atMs - b.atMs;

/** One of the current cycle's resets: a keep reset of it, or the restart it began with. */
function findEditable(ctx: ResetContext, id: string): ResetEvent | undefined {
  return cycleResets(ctx.cycle, ctx.resets.events).find((event) => event.id === id);
}

export function recordReset(
  ctx: ResetContext,
  input: { id: string; atMs: number; before: number | null; beforeAtMs: number | null; source: ResetSource },
): ResetChange {
  const { cycle, now, mode } = ctx;
  if (input.atMs <= cycle.startMs || input.atMs > now.getTime()) return refuse("outside_cycle");
  const keeps = keepResetsOf(cycle, ctx.resets.events);
  if (keeps.some((event) => event.atMs === input.atMs)) return refuse("duplicate_reset");
  if (mode === "restart" && keeps.some((event) => event.atMs > input.atMs)) return refuse("has_later_resets");
  const event: ResetEvent = {
    id: input.id,
    atMs: input.atMs,
    kind: mode,
    cycleStartMs: cycle.startMs,
    before: input.before,
    beforeAtMs: input.beforeAtMs,
    source: input.source,
    recordedAtMs: now.getTime(),
    ...(mode === "restart" && { previousOverride: ctx.override }),
  };
  return {
    ok: true,
    resets: addReset(ctx.resets, event),
    event,
    ...(mode === "restart" && { override: restartOverride(input.atMs, ctx.timeZone) }),
  };
}

export function editReset(
  ctx: ResetContext,
  input: { id: string; atMs?: number; before?: number | null },
): ResetChange {
  const event = findEditable(ctx, input.id);
  if (!event) return refuse("not_found");
  const atMs = input.atMs ?? event.atMs;
  const nowMs = ctx.now.getTime();
  const keeps = keepResetsOf(ctx.cycle, ctx.resets.events);
  let override: ResetOverride | undefined;
  if (event.kind === "keep") {
    if (atMs <= ctx.cycle.startMs || atMs > nowMs) return refuse("outside_cycle");
    if (keeps.some((other) => other.id !== event.id && other.atMs === atMs)) return refuse("duplicate_reset");
  } else {
    if (atMs <= event.cycleStartMs || atMs > nowMs) return refuse("outside_cycle");
    if (keeps.some((keep) => keep.atMs <= atMs)) return refuse("has_later_resets");
    if (atMs !== event.atMs) override = restartOverride(atMs, ctx.timeZone);
  }
  const edited: ResetEvent = {
    ...event,
    atMs,
    ...(input.before !== undefined && { before: input.before, beforeAtMs: null }),
  };
  // A cycle a restart began is named by its start, which moves with the restart.
  const moved = override !== undefined;
  const renamed = (startMs: number) => (moved && startMs === event.atMs ? atMs : startMs);
  const events = ctx.resets.events
    .map((other) => (other.id === event.id ? edited : { ...other, cycleStartMs: renamed(other.cycleStartMs) }))
    .sort(byTime);
  const off = ctx.resets.autoOffCycleStartMs;
  return {
    ok: true,
    resets: { v: 1, events, autoOffCycleStartMs: off === null ? null : renamed(off) },
    event: edited,
    ...(override && { override }),
  };
}

export function deleteReset(ctx: ResetContext, input: { id: string; revert: boolean }): ResetChange {
  const event = findEditable(ctx, input.id);
  if (!event) return refuse("not_found");
  if (input.revert && event.source !== "report") return refuse("not_revertable");
  if (event.kind === "restart" && keepResetsOf(ctx.cycle, ctx.resets.events).length > 0) {
    return refuse("has_later_resets");
  }
  const events = ctx.resets.events.filter((other) => other.id !== event.id);
  // A revert turns detection off for the cycle it leaves current: the one a restart cut short, else this one.
  const autoOffCycleStartMs = input.revert
    ? event.kind === "restart"
      ? event.cycleStartMs
      : ctx.cycle.startMs
    : ctx.resets.autoOffCycleStartMs;
  // A restart's own reset goes back, unless the panel changed it since.
  const restore = event.kind === "restart" && sameOverride(ctx.override, restartOverride(event.atMs, ctx.timeZone));
  return {
    ok: true,
    resets: { v: 1, events, autoOffCycleStartMs },
    event,
    ...(restore && { override: event.previousOverride ?? null }),
  };
}

/**
 * The before-figure of a reset recorded without one: the provider's stored
 * figure, if it belongs to the segment the reset falls in and was read
 * before it; unknown otherwise.
 */
export function beforeFromStored(
  stored: StoredOfficialReading | null,
  cycle: TimeWindow,
  events: ResetEvent[],
  atMs: number,
): { before: number | null; beforeAtMs: number | null } {
  const unknown = { before: null, beforeAtMs: null };
  if (!stored || stored.cycleStartMs !== segmentStartAt(cycle, events, atMs) || stored.view.enteredAt >= atMs) {
    return unknown;
  }
  const before = beforeFromRaw(stored.view.raw);
  return before === null ? unknown : { before, beforeAtMs: stored.view.enteredAt };
}

/**
 * The retag rule: after a provider's resets changed, each of its
 * `usage:official` fields (its own and its sub-limits') is tagged with the
 * segment its `enteredAt` falls in (lib/provider-cycles.ts `officialTagAt`).
 * Returns only the fields whose tag changes; a field `tagAt` has no answer
 * for (null) keeps its tag.
 */
export function retaggedOfficialEntries(
  stored: Record<string, string>,
  providerId: string,
  tagAt: (atMs: number) => number | null,
): Record<string, string> {
  const changed: Record<string, string> = {};
  for (const [field, raw] of Object.entries(stored)) {
    if (providerOfOfficialField(field) !== providerId) continue;
    const entry = parseStoredOfficialEntry(raw);
    if (!entry) continue;
    const tag = tagAt(entry.view.enteredAt);
    if (tag === null || tag === entry.cycleStartMs) continue;
    changed[field] = serializeOfficialEntry({
      ...entry.view,
      cycleStartMs: tag,
      ...(entry.resetsAtMs !== undefined && { resetsAtMs: entry.resetsAtMs }),
    });
  }
  return changed;
}

// ── Request bodies (/api/resets) ────────────────────────────────────────────

export interface ResetPost {
  providerId: string;
  atMs: number;
  /** Absent: taken from the stored figure (`beforeFromStored`). */
  before?: number | null;
  /** The figure since the reset ("Was there a reset?"), stored at `atMs`. */
  afterRaw?: string;
}

export interface ResetPut {
  providerId: string;
  id: string;
  atMs?: number;
  before?: number | null;
}

export interface ResetDelete {
  providerId: string;
  id: string;
  /** A detected reset only: put its before-figure back and stop detecting this cycle. */
  revert: boolean;
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readProviderId(value: unknown, errors: string[]): string {
  const providerId = normalizeProviderId(value);
  if (!providerId) errors.push("providerId must be a valid provider id");
  return providerId ?? "";
}

function readAtMs(value: unknown, errors: string[]): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value % MINUTE_MS === 0) return value;
  errors.push("atMs must be epoch milliseconds on a whole minute");
  return 0;
}

/** undefined: absent. */
function readBefore(value: unknown, errors: string[]): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) return value;
  errors.push("before must be a percentage from 0 to 100, or null");
  return undefined;
}

function readId(value: unknown, errors: string[]): string {
  if (isResetId(value)) return value;
  errors.push("id must be a reset's id");
  return "";
}

export function parseResetPost(input: unknown): ParseResult<ResetPost> {
  const body = asRecord(input);
  if (!body) return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];
  const providerId = readProviderId(body.providerId, errors);
  const atMs = readAtMs(body.atMs, errors);
  const before = readBefore(body.before, errors);
  let afterRaw: string | undefined;
  if (body.afterRaw !== undefined) {
    const raw = typeof body.afterRaw === "string" ? body.afterRaw.trim() : "";
    if (raw.length > 0 && raw.length <= OFFICIAL_USAGE_RAW_MAX_LENGTH && parseOfficialPercent(raw).percent !== null) {
      afterRaw = raw;
    } else {
      errors.push("afterRaw must be a percentage from 0 to 100");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      providerId,
      atMs,
      ...(before !== undefined && { before }),
      ...(afterRaw !== undefined && { afterRaw }),
    },
  };
}

export function parseResetPut(input: unknown): ParseResult<ResetPut> {
  const body = asRecord(input);
  if (!body) return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];
  const providerId = readProviderId(body.providerId, errors);
  const id = readId(body.id, errors);
  const atMs = body.atMs === undefined ? undefined : readAtMs(body.atMs, errors);
  const before = readBefore(body.before, errors);
  if (atMs === undefined && before === undefined && errors.length === 0) errors.push("atMs or before must be given");
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { providerId, id, ...(atMs !== undefined && { atMs }), ...(before !== undefined && { before }) },
  };
}

export function parseResetDelete(input: unknown): ParseResult<ResetDelete> {
  const body = asRecord(input);
  if (!body) return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];
  const providerId = readProviderId(body.providerId, errors);
  const id = readId(body.id, errors);
  if (body.revert !== undefined && typeof body.revert !== "boolean") errors.push("revert must be true or false");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { providerId, id, revert: body.revert === true } };
}

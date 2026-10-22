import type { TimeWindow, UsageEvent } from "@/lib/aggregate";
import type { ResetConfig, ResetMode, ResetOverride, TokenMode } from "@/lib/config";
import { type Cycle, getPreviousCycle, wallClockOf } from "@/lib/cycle";
import { readStoredResetOverride } from "@/lib/settings";

/**
 * Usage resets: a provider clearing a user's usage before the cycle is over.
 * Pure; the Redis side (`usage:resets`, lib/redis-keys.ts) is in
 * lib/usage-store.ts, and the rules for recording one in lib/reset-recording.ts.
 *
 * Two kinds, set per provider (lib/settings.ts `resetModeOf`):
 *
 *  - "keep" (Claude): the usage drops to near 0 but the cycle still ends when
 *    it would have. Its resets split the cycle into segments, each with a
 *    final percentage of its own; the cycle's total is their sum.
 *  - "restart" (Codex): the reset becomes the new weekly reset. It cuts the
 *    cycle short at R, and a fresh cycle starts there: the provider's own
 *    reset (`resetOverrides`) moves to R, marked `source: "reset"`.
 *
 * Snapshot reports are running totals since the cycle start the server gave
 * the client, and the server stamps each with it (`UsageEvent.basisMs`). In a
 * cycle a restart began, those counted from the old start are stale:
 * `dropStaleBasis`.
 */

export type ResetSource = "manual" | "report";

export interface ResetEvent {
  /** Random, for edits and deletes. */
  id: string;
  /** R: the moment of the reset, a whole minute. */
  atMs: number;
  /** The provider's mode when it was recorded. */
  kind: ResetMode;
  /** S: the start of the cycle it happened in (for a restart: the cycle it cut short). */
  cycleStartMs: number;
  /** 0–100, the share used right before it; null while unknown. */
  before: number | null;
  /** When `before` was read; null when it was typed in. */
  beforeAtMs: number | null;
  source: ResetSource;
  recordedAtMs: number;
  /** Restart only: the provider's own reset before it; null: it used the shared one. */
  previousOverride?: ResetOverride | null;
}

/** One provider's field of `usage:resets`. */
export interface ProviderResets {
  v: 1;
  /** Sorted by `atMs`. */
  events: ResetEvent[];
  /** Automatic detection is off for the cycle that starts here (set by a revert); null: on. */
  autoOffCycleStartMs: number | null;
}

/** A stretch of a cycle between its start, its keep resets and its end. */
export interface Segment extends TimeWindow {
  /** The keep reset it began with; null for the cycle's first. */
  reset: ResetEvent | null;
}

export const MINUTE_MS = 60_000;
const RESET_ID = /^[A-Za-z0-9-]{1,64}$/;

export function emptyResets(): ProviderResets {
  return { v: 1, events: [], autoOffCycleStartMs: null };
}

export function isResetId(value: unknown): value is string {
  return typeof value === "string" && RESET_ID.test(value);
}

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPercent = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
const byTime = (a: ResetEvent, b: ResetEvent) => a.atMs - b.atMs;

/** One stored event: every field checked, the event kept or dropped whole. */
function readEvent(value: unknown): ResetEvent | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { id, atMs, kind, cycleStartMs, before, beforeAtMs, source, recordedAtMs, previousOverride } = value as Record<
    string,
    unknown
  >;
  if (!isResetId(id) || !isTime(atMs) || !isTime(cycleStartMs) || !isTime(recordedAtMs)) return null;
  if (kind !== "keep" && kind !== "restart") return null;
  if (source !== "manual" && source !== "report") return null;
  if (before !== null && !isPercent(before)) return null;
  if (beforeAtMs !== null && !isTime(beforeAtMs)) return null;
  const event: ResetEvent = { id, atMs, kind, cycleStartMs, before, beforeAtMs, source, recordedAtMs };
  if (kind === "restart") {
    event.previousOverride = previousOverride == null ? null : readStoredResetOverride(previousOverride);
  }
  return event;
}

/** One provider's stored document, leniently: damaged JSON reads as no resets, a damaged event is dropped. */
export function parseProviderResets(raw: string): ProviderResets {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptyResets();
  }
  if (typeof value !== "object" || value === null) return emptyResets();
  const { events, autoOffCycleStartMs } = value as Record<string, unknown>;
  return {
    v: 1,
    events: (Array.isArray(events) ? events : [])
      .map(readEvent)
      .filter((event): event is ResetEvent => event !== null)
      .sort(byTime),
    autoOffCycleStartMs: isTime(autoOffCycleStartMs) ? autoOffCycleStartMs : null,
  };
}

export function serializeProviderResets(resets: ProviderResets): string {
  return JSON.stringify(resets);
}

/** One provider's resets out of the loaded hash (lib/usage-store.ts `loadResets`); none when it has none. */
export function resetsOf(all: Record<string, ProviderResets>, providerId: string): ProviderResets {
  return Object.hasOwn(all, providerId) ? all[providerId]! : emptyResets();
}

export function resetEventsOf(all: Record<string, ProviderResets>, providerId: string): ResetEvent[] {
  return resetsOf(all, providerId).events;
}

// ── Segments ─────────────────────────────────────────────────────────────────

/** The keep resets that split `cycle`, in order: recorded in it, and strictly inside it. */
export function keepResetsOf(cycle: TimeWindow, events: ResetEvent[]): ResetEvent[] {
  return events
    .filter(
      (event) =>
        event.kind === "keep" &&
        event.cycleStartMs === cycle.startMs &&
        event.atMs > cycle.startMs &&
        event.atMs < cycle.endMs,
    )
    .sort(byTime);
}

/** `cycle` cut at its keep resets; one segment when it has none. */
export function segmentsOf(cycle: TimeWindow, events: ResetEvent[]): Segment[] {
  const segments: Segment[] = [];
  let startMs = cycle.startMs;
  let opened: ResetEvent | null = null;
  for (const reset of keepResetsOf(cycle, events)) {
    segments.push({ startMs, endMs: reset.atMs, reset: opened });
    startMs = reset.atMs;
    opened = reset;
  }
  segments.push({ startMs, endMs: cycle.endMs, reset: opened });
  return segments;
}

/** The start of the segment of `cycle` that `atMs` (at or after the cycle's start) falls in. */
export function segmentStartAt(cycle: TimeWindow, events: ResetEvent[], atMs: number): number {
  let startMs = cycle.startMs;
  for (const reset of keepResetsOf(cycle, events)) if (reset.atMs <= atMs) startMs = reset.atMs;
  return startMs;
}

/** The restart a cycle starting at `startMs` began with, if one did. */
export function restartStarting(events: ResetEvent[], startMs: number): ResetEvent | undefined {
  return events.find((event) => event.kind === "restart" && event.atMs === startMs);
}

/** A cycle's own resets, in order: the restart it began with, then its keep resets. */
export function cycleResets(cycle: TimeWindow, events: ResetEvent[]): ResetEvent[] {
  const restart = restartStarting(events, cycle.startMs);
  return [...(restart ? [restart] : []), ...keepResetsOf(cycle, events)];
}

// ── Cycles ───────────────────────────────────────────────────────────────────

/**
 * The cycle right before `cycle` (which runs on `reset`), and the reset that
 * one ran on. A cycle a restart began comes after the one it cut short,
 * `[S, R)`, which ran on the provider's reset from before it (`shared` when it
 * had none of its own); any other is worked out backwards.
 */
export function cycleBefore(
  cycle: Cycle,
  reset: ResetConfig,
  shared: ResetConfig,
  events: ResetEvent[],
): { cycle: Cycle; reset: ResetConfig } {
  const restart = restartStarting(events, cycle.start.getTime());
  if (!restart) return { cycle: getPreviousCycle(cycle, reset), reset };
  return {
    cycle: { start: new Date(restart.cycleStartMs), end: new Date(restart.atMs) },
    reset: restart.previousOverride ? { ...shared, ...restart.previousOverride } : shared,
  };
}

/** The provider's own reset a restart at `atMs` sets: R's wall clock in the reset time zone. */
export function restartOverride(atMs: number, timeZone: string): ResetOverride {
  const { weekday, day, hour, minute } = wallClockOf(new Date(atMs), timeZone);
  return { weekday, monthDay: day, hour, minute, source: "reset" };
}

/** Whether two own resets are the same moment from the same source (null: none). */
export function sameOverride(a: ResetOverride | null, b: ResetOverride | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.weekday === b.weekday &&
    a.monthDay === b.monthDay &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.source === b.source
  );
}

// ── Counting basis ───────────────────────────────────────────────────────────

/**
 * `events` without the snapshot reports a restart made stale: made at or
 * after it, but counted from a cycle start before it (the server had not
 * heard of the reset yet). Unstamped events (stored before the stamp
 * existed) are kept; delta and counter modes do not depend on the basis.
 */
export function dropStaleBasis(events: UsageEvent[], resets: ResetEvent[], mode: TokenMode): UsageEvent[] {
  if (mode !== "snapshot") return events;
  const restarts = resets.flatMap((reset) => (reset.kind === "restart" ? [reset.atMs] : []));
  if (restarts.length === 0) return events;
  return events.filter(
    (event) => event.basisMs === undefined || !restarts.some((atMs) => event.ts >= atMs && event.basisMs! < atMs),
  );
}

// ── Small helpers ────────────────────────────────────────────────────────────

export function addReset(resets: ProviderResets, event: ResetEvent): ProviderResets {
  return { ...resets, events: [...resets.events, event].sort(byTime) };
}

/** A stored figure's text as a before-figure: 0–100, a report's figure over 100 counting as 100; null when it is no number. */
export function beforeFromRaw(raw: string): number | null {
  const text = raw.trim().replace(/\s*%$/, "").replace(",", ".");
  const value = Number(text);
  return text !== "" && Number.isFinite(value) && value >= 0 ? Math.min(100, value) : null;
}

/**
 * What housekeeping keeps of one provider's resets: the keep events from its
 * previous cycle's start on (an older one's cycle is archived by now,
 * lib/archive.ts), the restart events while their raw reports are kept
 * (from `retainFromMs` on: `dropStaleBasis` needs the restart for as long as
 * the snapshot reports it made stale exist), and a revert's detection switch
 * while its cycle runs.
 */
export function pruneResets(
  resets: ProviderResets,
  cycle: TimeWindow,
  previousStartMs: number,
  retainFromMs: number,
): ProviderResets {
  const off = resets.autoOffCycleStartMs;
  return {
    v: 1,
    events: resets.events.filter((event) => event.atMs >= (event.kind === "restart" ? retainFromMs : previousStartMs)),
    autoOffCycleStartMs: off !== null && off < cycle.startMs ? null : off,
  };
}

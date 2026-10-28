import { describe, expect, it } from "vitest";
import type { UsageEvent } from "@/lib/aggregate";
import {
  addReset,
  beforeFromRaw,
  cycleBefore,
  cycleResets,
  dropStaleBasis,
  emptyResets,
  keepResetsOf,
  type ProviderResets,
  parseProviderResets,
  promptsReset,
  pruneResets,
  type ResetEvent,
  resetEventsOf,
  restartOverride,
  restartStarting,
  sameOverride,
  segmentStartAt,
  segmentsOf,
  serializeProviderResets,
} from "@/lib/resets";

const at = (iso: string) => Date.parse(iso);
// The shared reset is Monday 00:00 UTC: this cycle runs Monday 2026-09-21 to Monday 2026-09-28.
const CYCLE = { startMs: at("2026-09-21T00:00:00Z"), endMs: at("2026-09-28T00:00:00Z") };
const SHARED = { period: "weekly" as const, weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" };
const R = at("2026-09-22T14:00:00Z");

function reset(overrides: Partial<ResetEvent> = {}): ResetEvent {
  return {
    id: "r1",
    atMs: R,
    kind: "keep",
    cycleStartMs: CYCLE.startMs,
    before: 80,
    beforeAtMs: at("2026-09-22T13:40:00Z"),
    source: "manual",
    recordedAtMs: at("2026-09-22T14:05:00Z"),
    ...overrides,
  };
}

describe("parseProviderResets / serializeProviderResets", () => {
  it("round-trips a document", () => {
    const resets: ProviderResets = {
      v: 1,
      events: [reset(), reset({ id: "r2", kind: "restart", atMs: at("2026-09-23T08:00:00Z"), previousOverride: null })],
      autoOffCycleStartMs: CYCLE.startMs,
    };
    expect(parseProviderResets(serializeProviderResets(resets))).toEqual(resets);
  });

  it("round-trips a restart with the own reset it replaced, marker included", () => {
    const previousOverride = { weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" as const };
    const resets: ProviderResets = {
      v: 1,
      events: [reset({ kind: "restart", previousOverride })],
      autoOffCycleStartMs: null,
    };
    expect(parseProviderResets(serializeProviderResets(resets))).toEqual(resets);
  });

  it("reads a restart whose previous own reset is damaged as one that used the shared reset", () => {
    const doc = JSON.stringify({
      v: 1,
      events: [reset({ kind: "restart", previousOverride: { weekday: 9, monthDay: 1, hour: 0, minute: 0 } })],
      autoOffCycleStartMs: null,
    });
    expect(parseProviderResets(doc).events).toEqual([reset({ kind: "restart", previousOverride: null })]);
  });

  it("reads damaged JSON as no resets, drops a damaged event on its own, and sorts by time", () => {
    expect(parseProviderResets("not json")).toEqual(emptyResets());
    const doc = JSON.stringify({
      v: 1,
      events: [
        reset(),
        { ...reset({ id: "bad" }), atMs: "soon" },
        reset({ id: "r0", atMs: at("2026-09-21T10:00:00Z") }),
      ],
      autoOffCycleStartMs: "x",
    });
    const parsed = parseProviderResets(doc);
    expect(parsed.events.map((event) => event.id)).toEqual(["r0", "r1"]);
    expect(parsed.autoOffCycleStartMs).toBeNull();
  });

  it("reads one provider's events out of the loaded hash", () => {
    const all = { claude: { v: 1 as const, events: [reset()], autoOffCycleStartMs: null } };
    expect(resetEventsOf(all, "claude")).toEqual([reset()]);
    expect(resetEventsOf(all, "openai")).toEqual([]);
    expect(resetEventsOf(all, "constructor")).toEqual([]);
  });
});

describe("segments", () => {
  const events = [
    reset({ id: "b", atMs: at("2026-09-23T08:00:00Z") }),
    reset(),
    // Another cycle's keep reset, and the restart this cycle began with.
    reset({ id: "other", cycleStartMs: at("2026-09-14T00:00:00Z"), atMs: at("2026-09-15T00:00:00Z") }),
    reset({ id: "rs", kind: "restart", atMs: CYCLE.startMs, cycleStartMs: at("2026-09-16T00:00:00Z") }),
  ];

  it("splits a cycle at its own keep resets, in order", () => {
    expect(keepResetsOf(CYCLE, events).map((event) => event.id)).toEqual(["r1", "b"]);
    expect(segmentsOf(CYCLE, events).map(({ startMs, endMs, reset }) => [startMs, endMs, reset?.id ?? null])).toEqual([
      [CYCLE.startMs, R, null],
      [R, at("2026-09-23T08:00:00Z"), "r1"],
      [at("2026-09-23T08:00:00Z"), CYCLE.endMs, "b"],
    ]);
  });

  it("is one segment without resets", () => {
    expect(segmentsOf(CYCLE, [])).toEqual([{ ...CYCLE, reset: null }]);
  });

  it("finds the segment a moment falls in", () => {
    expect(segmentStartAt(CYCLE, events, R - 60_000)).toBe(CYCLE.startMs);
    expect(segmentStartAt(CYCLE, events, R)).toBe(R);
    expect(segmentStartAt(CYCLE, events, at("2026-09-27T00:00:00Z"))).toBe(at("2026-09-23T08:00:00Z"));
  });

  it("lists a cycle's own resets: the restart it began with, then its keep resets", () => {
    expect(restartStarting(events, CYCLE.startMs)?.id).toBe("rs");
    expect(cycleResets(CYCLE, events).map((event) => event.id)).toEqual(["rs", "r1", "b"]);
  });
});

describe("cycleBefore", () => {
  const OWN = { ...SHARED, weekday: 2, monthDay: 22, hour: 14, minute: 0 };
  const cycle = { start: new Date(R), end: new Date("2026-09-29T14:00:00Z") };

  it("works backwards without a restart", () => {
    const before = cycleBefore(cycle, OWN, SHARED, []);
    expect(before.cycle.start.toISOString()).toBe("2026-09-15T14:00:00.000Z");
    expect(before.reset).toBe(OWN);
  });

  it("is the cycle a restart cut short, on the reset it ran on", () => {
    const restart = reset({ kind: "restart", previousOverride: null });
    const before = cycleBefore(cycle, OWN, SHARED, [restart]);
    expect(before.cycle).toEqual({ start: new Date(CYCLE.startMs), end: new Date(R) });
    expect(before.reset).toEqual(SHARED);
    const withOwn = cycleBefore(cycle, OWN, SHARED, [
      { ...restart, previousOverride: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
    ]);
    expect(withOwn.reset).toMatchObject({ weekday: 4, hour: 9, minute: 0, timeZone: "UTC" });
  });
});

describe("restartOverride / sameOverride", () => {
  it("makes the reset moment the provider's own reset, in the reset time zone", () => {
    expect(restartOverride(R, "UTC")).toEqual({
      weekday: 2,
      monthDay: 22,
      hour: 14,
      minute: 0,
      source: "reset",
      anchorMs: R,
    });
    expect(restartOverride(R, "Europe/Budapest")).toEqual({
      weekday: 2,
      monthDay: 22,
      hour: 16,
      minute: 0,
      source: "reset",
      anchorMs: R,
    });
  });

  it("tells whether an own reset is still the one a restart set", () => {
    const own = restartOverride(R, "UTC");
    const { source: _, ...edited } = own;
    expect(sameOverride(own, restartOverride(R, "UTC"))).toBe(true);
    expect(sameOverride(own, edited)).toBe(false);
    expect(sameOverride(null, null)).toBe(true);
    expect(sameOverride(own, null)).toBe(false);
  });
});

describe("dropStaleBasis", () => {
  const restart = reset({ kind: "restart" });
  const event = (ts: string, basisMs?: number): UsageEvent => ({
    machineId: "mac",
    groupId: "Work",
    tokens: 1,
    ts: at(ts),
    ...(basisMs !== undefined && { basisMs }),
  });
  const events = [
    event("2026-09-22T10:00:00Z", CYCLE.startMs), // before R: kept
    event("2026-09-22T15:00:00Z", CYCLE.startMs), // after R, counted from S: stale
    event("2026-09-22T16:00:00Z", R), // after R, counted from R: kept
    event("2026-09-22T17:00:00Z"), // stored before the stamp existed: kept
  ];

  it("drops snapshot events after a restart that were counted from before it", () => {
    expect(dropStaleBasis(events, [restart], "snapshot")).toEqual([events[0], events[2], events[3]]);
  });

  it("keeps everything in delta and counter mode, and without a restart", () => {
    expect(dropStaleBasis(events, [restart], "delta")).toBe(events);
    expect(dropStaleBasis(events, [restart], "counter")).toBe(events);
    expect(dropStaleBasis(events, [reset()], "snapshot")).toBe(events);
  });
});

describe("addReset / beforeFromRaw / pruneResets", () => {
  it("keeps the events sorted by time", () => {
    const resets = addReset(
      { v: 1, events: [reset()], autoOffCycleStartMs: null },
      reset({ id: "early", atMs: R - 3_600_000 }),
    );
    expect(resets.events.map((event) => event.id)).toEqual(["early", "r1"]);
  });

  it("reads a stored figure as a before-figure: 0–100, over 100 counting as 100", () => {
    expect(beforeFromRaw("41.2")).toBe(41.2);
    expect(beforeFromRaw("104.5")).toBe(100);
    expect(beforeFromRaw("45,5 %")).toBe(45.5);
    expect(beforeFromRaw("")).toBeNull();
    expect(beforeFromRaw("abc")).toBeNull();
  });

  it("drops events older than the previous cycle, and a revert's switch once its cycle is over", () => {
    const previousStartMs = at("2026-09-14T00:00:00Z");
    const resets: ProviderResets = {
      v: 1,
      events: [
        reset({ id: "old", atMs: at("2026-09-10T00:00:00Z"), cycleStartMs: at("2026-09-07T00:00:00Z") }),
        reset({ id: "prev", atMs: at("2026-09-15T00:00:00Z"), cycleStartMs: previousStartMs }),
        reset(),
      ],
      autoOffCycleStartMs: previousStartMs,
    };
    const retainFromMs = at("2026-07-01T00:00:00Z");
    const pruned = pruneResets(resets, CYCLE, previousStartMs, retainFromMs);
    expect(pruned.events.map((event) => event.id)).toEqual(["prev", "r1"]);
    expect(pruned.autoOffCycleStartMs).toBeNull();
    expect(
      pruneResets({ ...resets, autoOffCycleStartMs: CYCLE.startMs }, CYCLE, previousStartMs, retainFromMs)
        .autoOffCycleStartMs,
    ).toBe(CYCLE.startMs);
  });

  it("keeps a restart while its raw reports are kept, a keep reset only until its cycle is archived", () => {
    const previousStartMs = at("2026-09-14T00:00:00Z");
    const retainFromMs = at("2026-08-01T00:00:00Z");
    const olderThanPrevious = at("2026-09-02T00:00:00Z");
    const resets: ProviderResets = {
      v: 1,
      events: [
        reset({ id: "gone", kind: "restart", atMs: at("2026-07-20T00:00:00Z"), previousOverride: null }),
        reset({ id: "restart", kind: "restart", atMs: olderThanPrevious, previousOverride: null }),
        reset({ id: "keep", atMs: olderThanPrevious }),
        reset(),
      ],
      autoOffCycleStartMs: null,
    };
    expect(pruneResets(resets, CYCLE, previousStartMs, retainFromMs).events.map((event) => event.id)).toEqual([
      "restart",
      "r1",
    ]);
  });
});

describe("promptsReset", () => {
  it("asks once the figure is edited below 10%, at least 5 points down", () => {
    expect(promptsReset(62, 8)).toBe(true);
    expect(promptsReset(14, 9)).toBe(true);
  });

  it("does not ask for a small correction, a figure still at 10% or above, or without both figures", () => {
    expect(promptsReset(12, 8)).toBe(false);
    expect(promptsReset(62, 10)).toBe(false);
    expect(promptsReset(null, 3)).toBe(false);
    expect(promptsReset(62, null)).toBe(false);
  });
});

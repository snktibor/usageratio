import { describe, expect, it } from "vitest";
import {
  beforeFromStored,
  deleteReset,
  editReset,
  parseResetDelete,
  parseResetPost,
  parseResetPut,
  type ResetContext,
  recordReset,
  retaggedOfficialEntries,
} from "@/lib/reset-recording";
import { emptyResets, type ResetEvent, restartOverride } from "@/lib/resets";

const at = (iso: string) => Date.parse(iso);
// Wednesday 2026-09-23 12:00 UTC, in the cycle Monday 2026-09-21 to Monday 2026-09-28.
const NOW = new Date("2026-09-23T12:00:00Z");
const CYCLE = { startMs: at("2026-09-21T00:00:00Z"), endMs: at("2026-09-28T00:00:00Z") };
const R = at("2026-09-22T14:00:00Z");
const HOUR = 3_600_000;

function event(overrides: Partial<ResetEvent> = {}): ResetEvent {
  return {
    id: "r1",
    atMs: R,
    kind: "keep",
    cycleStartMs: CYCLE.startMs,
    before: 80,
    beforeAtMs: null,
    source: "manual",
    recordedAtMs: R,
    ...overrides,
  };
}

function ctx(overrides: Partial<ResetContext> = {}): ResetContext {
  return { now: NOW, mode: "keep", cycle: CYCLE, resets: emptyResets(), override: null, timeZone: "UTC", ...overrides };
}

const input = (overrides: Partial<Parameters<typeof recordReset>[1]> = {}) => ({
  id: "new",
  atMs: R,
  before: 80,
  beforeAtMs: null,
  source: "manual" as const,
  ...overrides,
});

const withEvents = (...events: ResetEvent[]) => ({ v: 1 as const, events, autoOffCycleStartMs: null });

describe("recordReset", () => {
  it("records a keep reset in the current cycle", () => {
    const change = recordReset(ctx(), input());
    if (!change.ok) throw new Error(change.refused);
    expect(change.event).toEqual({
      id: "new",
      atMs: R,
      kind: "keep",
      cycleStartMs: CYCLE.startMs,
      before: 80,
      beforeAtMs: null,
      source: "manual",
      recordedAtMs: NOW.getTime(),
    });
    expect(change.resets.events).toEqual([change.event]);
    expect(change).not.toHaveProperty("override");
  });

  it("refuses a moment outside (start, now], or the minute of an existing reset", () => {
    expect(recordReset(ctx(), input({ atMs: CYCLE.startMs }))).toEqual({ ok: false, refused: "outside_cycle" });
    expect(recordReset(ctx(), input({ atMs: NOW.getTime() + 60_000 }))).toEqual({
      ok: false,
      refused: "outside_cycle",
    });
    expect(recordReset(ctx(), input({ atMs: NOW.getTime() })).ok).toBe(true);
    expect(recordReset(ctx({ resets: withEvents(event()) }), input())).toEqual({
      ok: false,
      refused: "duplicate_reset",
    });
  });

  it("puts a keep reset between earlier ones", () => {
    const resets = withEvents(event({ id: "a", atMs: R - 10 * HOUR }), event({ id: "b", atMs: R + 10 * HOUR }));
    const change = recordReset(ctx({ resets }), input());
    if (!change.ok) throw new Error(change.refused);
    expect(change.resets.events.map((e) => e.id)).toEqual(["a", "new", "b"]);
  });

  it("records a restart: it moves the provider's own reset to R and remembers the old one", () => {
    const old = { weekday: 4, monthDay: 1, hour: 9, minute: 0 };
    const change = recordReset(ctx({ mode: "restart", override: old }), input());
    if (!change.ok) throw new Error(change.refused);
    expect(change.event).toMatchObject({ kind: "restart", cycleStartMs: CYCLE.startMs, previousOverride: old });
    expect(change.override).toEqual(restartOverride(R, "UTC"));
  });

  it("refuses a restart before a keep reset of the cycle: it would end the cycle under it", () => {
    const resets = withEvents(event({ id: "k", atMs: R + HOUR }));
    expect(recordReset(ctx({ mode: "restart", resets }), input())).toEqual({ ok: false, refused: "has_later_resets" });
  });
});

describe("editReset", () => {
  it("moves a keep reset and retypes its figure", () => {
    const change = editReset(ctx({ resets: withEvents(event({ beforeAtMs: R - HOUR })) }), {
      id: "r1",
      atMs: R + HOUR,
      before: 75,
    });
    if (!change.ok) throw new Error(change.refused);
    expect(change.event).toMatchObject({ atMs: R + HOUR, before: 75, beforeAtMs: null });
  });

  it("finds only this cycle's resets", () => {
    const other = event({ cycleStartMs: at("2026-09-14T00:00:00Z"), atMs: at("2026-09-15T00:00:00Z") });
    expect(editReset(ctx({ resets: withEvents(other) }), { id: "r1", before: 1 })).toEqual({
      ok: false,
      refused: "not_found",
    });
    expect(editReset(ctx(), { id: "nope", before: 1 })).toEqual({ ok: false, refused: "not_found" });
  });

  it("refuses to move a keep reset outside the cycle or onto another reset's minute", () => {
    const resets = withEvents(event(), event({ id: "b", atMs: R + HOUR }));
    expect(editReset(ctx({ resets }), { id: "r1", atMs: CYCLE.startMs })).toEqual({
      ok: false,
      refused: "outside_cycle",
    });
    expect(editReset(ctx({ resets }), { id: "r1", atMs: R + HOUR })).toEqual({
      ok: false,
      refused: "duplicate_reset",
    });
  });

  describe("the restart the cycle began with", () => {
    const restart = event({ id: "rs", kind: "restart", cycleStartMs: CYCLE.startMs, previousOverride: null });
    const keep = event({ id: "k", atMs: R + 2 * HOUR, cycleStartMs: R });
    const restartCycle = { startMs: R, endMs: R + 7 * 24 * HOUR };

    it("moves the provider's reset with it, and the cycle's keep resets keep naming their cycle", () => {
      const change = editReset(
        ctx({
          mode: "restart",
          cycle: restartCycle,
          resets: withEvents(restart, keep),
          override: restartOverride(R, "UTC"),
        }),
        { id: "rs", atMs: R - HOUR },
      );
      if (!change.ok) throw new Error(change.refused);
      expect(change.override).toEqual(restartOverride(R - HOUR, "UTC"));
      expect(change.resets.events.find((e) => e.id === "k")?.cycleStartMs).toBe(R - HOUR);
    });

    it("must stay after the cycle it cut short began, and before the cycle's first keep reset", () => {
      const context = ctx({ mode: "restart", cycle: restartCycle, resets: withEvents(restart, keep) });
      expect(editReset(context, { id: "rs", atMs: CYCLE.startMs })).toEqual({ ok: false, refused: "outside_cycle" });
      expect(editReset(context, { id: "rs", atMs: R + 3 * HOUR })).toEqual({ ok: false, refused: "has_later_resets" });
    });

    it("must stay early enough for the cycle it starts to still be the current one", () => {
      // A week after R, minus an hour: moving R back more than an hour would end its cycle before now.
      const context = ctx({
        now: new Date("2026-09-29T13:00:00Z"),
        mode: "restart",
        cycle: restartCycle,
        resets: withEvents(restart),
      });
      expect(editReset(context, { id: "rs", atMs: at("2026-09-22T10:00:00Z") })).toEqual({
        ok: false,
        refused: "outside_cycle",
      });
      expect(editReset(context, { id: "rs", atMs: at("2026-09-22T13:00:00Z") })).toEqual({
        ok: false,
        refused: "outside_cycle",
      });
      expect(editReset(context, { id: "rs", atMs: at("2026-09-22T13:30:00Z") }).ok).toBe(true);
    });
  });
});

describe("deleteReset", () => {
  it("deletes a keep reset: its segments merge", () => {
    const change = deleteReset(ctx({ resets: withEvents(event()) }), { id: "r1", revert: false });
    if (!change.ok) throw new Error(change.refused);
    expect(change.resets.events).toEqual([]);
    expect(change).not.toHaveProperty("override");
  });

  it("reverts only a detected reset, and turns detection off for the cycle", () => {
    expect(deleteReset(ctx({ resets: withEvents(event()) }), { id: "r1", revert: true })).toEqual({
      ok: false,
      refused: "not_revertable",
    });
    const change = deleteReset(ctx({ resets: withEvents(event({ source: "report" })) }), { id: "r1", revert: true });
    if (!change.ok) throw new Error(change.refused);
    expect(change.resets.autoOffCycleStartMs).toBe(CYCLE.startMs);
  });

  describe("the restart the cycle began with", () => {
    const old = { weekday: 4, monthDay: 1, hour: 9, minute: 0 };
    const restart = event({ id: "rs", kind: "restart", source: "report", previousOverride: old });
    const restartCycle = { startMs: R, endMs: R + 7 * 24 * HOUR };
    const context = (overrides: Partial<ResetContext> = {}) =>
      ctx({
        mode: "restart",
        cycle: restartCycle,
        resets: withEvents(restart),
        override: restartOverride(R, "UTC"),
        ...overrides,
      });

    it("puts the provider's own reset back while it is still the one the restart set", () => {
      const change = deleteReset(context(), { id: "rs", revert: false });
      if (!change.ok) throw new Error(change.refused);
      expect(change.override).toEqual(old);
    });

    it("leaves an own reset changed on the panel since alone", () => {
      const change = deleteReset(context({ override: { weekday: 5, monthDay: 1, hour: 0, minute: 0 } }), {
        id: "rs",
        revert: false,
      });
      if (!change.ok) throw new Error(change.refused);
      expect(change).not.toHaveProperty("override");
    });

    it("turns detection off for the cycle it restores on a revert", () => {
      const change = deleteReset(context(), { id: "rs", revert: true });
      if (!change.ok) throw new Error(change.refused);
      expect(change.resets.autoOffCycleStartMs).toBe(CYCLE.startMs);
    });

    it("is refused while keep resets follow it", () => {
      const keep = event({ id: "k", atMs: R + HOUR, cycleStartMs: R });
      expect(deleteReset(context({ resets: withEvents(restart, keep) }), { id: "rs", revert: false })).toEqual({
        ok: false,
        refused: "has_later_resets",
      });
    });
  });
});

describe("beforeFromStored", () => {
  const stored = { view: { raw: "62", enteredAt: R - HOUR }, cycleStartMs: CYCLE.startMs };

  it("takes the stored figure of the reset's segment, if it was read before the reset", () => {
    expect(beforeFromStored(stored, CYCLE, [], R)).toEqual({ before: 62, beforeAtMs: R - HOUR });
  });

  it("is unknown for a figure read after it, from another segment, or none", () => {
    const none = { before: null, beforeAtMs: null };
    expect(beforeFromStored(stored, CYCLE, [], R - 2 * HOUR)).toEqual(none);
    expect(beforeFromStored({ ...stored, cycleStartMs: R - 5 * HOUR }, CYCLE, [], R)).toEqual(none);
    expect(beforeFromStored(null, CYCLE, [], R)).toEqual(none);
  });
});

describe("retaggedOfficialEntries", () => {
  it("retags the provider's own and sub-limit fields to their segment, and nothing else", () => {
    const entry = (enteredAt: number, cycleStartMs: number) => JSON.stringify({ raw: "5", enteredAt, cycleStartMs });
    const stored = {
      claude: entry(R + HOUR, CYCLE.startMs), // entered after the reset: moves to it
      "claude:fable": entry(R - HOUR, CYCLE.startMs), // before it: stays
      openai: entry(R + HOUR, CYCLE.startMs), // another provider: untouched
      "claude:old": entry(1, 1), // too old to tag: untouched
    };
    const tagAt = (atMs: number) => (atMs < CYCLE.startMs ? null : atMs >= R ? R : CYCLE.startMs);
    expect(retaggedOfficialEntries(stored, "claude", tagAt)).toEqual({ claude: entry(R + HOUR, R) });
  });

  it("keeps the window's reset a report stored with the figure", () => {
    const resetsAtMs = CYCLE.endMs;
    const stored = {
      claude: JSON.stringify({ raw: "5", enteredAt: R + HOUR, cycleStartMs: CYCLE.startMs, resetsAtMs }),
    };
    const retagged = retaggedOfficialEntries(stored, "claude", () => R);
    expect(JSON.parse(retagged.claude!)).toEqual({ raw: "5", enteredAt: R + HOUR, cycleStartMs: R, resetsAtMs });
  });
});

describe("request bodies", () => {
  it("parses a POST, with or without the optional figures", () => {
    expect(parseResetPost({ providerId: "Claude", atMs: R })).toEqual({
      ok: true,
      value: { providerId: "claude", atMs: R },
    });
    expect(parseResetPost({ providerId: "claude", atMs: R, before: null, afterRaw: " 3 " })).toEqual({
      ok: true,
      value: { providerId: "claude", atMs: R, before: null, afterRaw: "3" },
    });
  });

  it("reports every problem of a POST", () => {
    const result = parseResetPost({ providerId: "!!", atMs: R + 1, before: 101, afterRaw: "abc" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(4);
  });

  it("parses a PUT, which must change something", () => {
    expect(parseResetPut({ providerId: "claude", id: "r1", before: 70 })).toEqual({
      ok: true,
      value: { providerId: "claude", id: "r1", before: 70 },
    });
    expect(parseResetPut({ providerId: "claude", id: "r1" }).ok).toBe(false);
    expect(parseResetPut({ providerId: "claude", id: "bad id!", atMs: R }).ok).toBe(false);
  });

  it("parses a DELETE, revert defaulting to false", () => {
    expect(parseResetDelete({ providerId: "claude", id: "r1" })).toEqual({
      ok: true,
      value: { providerId: "claude", id: "r1", revert: false },
    });
    expect(parseResetDelete({ providerId: "claude", id: "r1", revert: "yes" }).ok).toBe(false);
  });
});

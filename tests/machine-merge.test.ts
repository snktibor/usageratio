import { describe, expect, it } from "vitest";
import { summarizeUsage, type UsageEvent } from "@/lib/aggregate";
import { carryOver, type MergeCycle } from "@/lib/machine-merge";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-09-21T00:00:00Z");
const midnight = (day: number) => START + day * DAY;
const CYCLE: MergeCycle = {
  startMs: START,
  endMs: midnight(7),
  dayEndsMs: [1, 2, 3, 4, 5, 6, 7].map(midnight),
};

function checkpoint(machineId: string, day: number, tokens: number, models?: Record<string, number>): UsageEvent {
  return { machineId, groupId: "Work", tokens, ts: midnight(day), checkpoint: true, ...(models && { models }) };
}

function report(machineId: string, ts: number, tokens: number, extra: Partial<UsageEvent> = {}): UsageEvent {
  return { machineId, groupId: "Work", tokens, ts, ...extra };
}

/** The carry-over as the stored events it becomes, under the target machine. */
function asEvents(points: ReturnType<typeof carryOver>): UsageEvent[] {
  return points.map((point) => ({
    machineId: "laptop",
    groupId: "Work",
    tokens: point.tokens,
    ts: point.ts,
    checkpoint: true,
    carried: true,
    ...(point.models && { models: point.models }),
    ...(point.costUsd !== undefined && { costUsd: point.costUsd }),
  }));
}

const WINDOW = { startMs: CYCLE.startMs, endMs: CYCLE.endMs };

describe("carryOver", () => {
  it("counts each day as the identity that saw more of it: the wrong install's deleted day, the right one's later days", () => {
    // Installed under a wrong name: saw day 1 (100) and day 2 (150), and half of day 3 before it was replaced.
    const wrong = [
      checkpoint("wrong", 1, 100),
      checkpoint("wrong", 2, 250),
      report("wrong", midnight(2) + 12 * HOUR, 300),
    ];
    // Uploaded again under the right name after 60 of day 1's tokens were deleted on the machine.
    const right = [
      checkpoint("laptop", 1, 40),
      checkpoint("laptop", 2, 190),
      checkpoint("laptop", 3, 270),
      report("laptop", midnight(3) + 20 * HOUR, 370),
    ];
    const now = midnight(3) + 21 * HOUR;

    const points = carryOver({ raw: right, carried: [] }, [{ raw: wrong, carried: [] }], [CYCLE], now);
    expect(points.map((point) => [point.ts, point.tokens])).toEqual([
      [midnight(1), 60],
      [midnight(2), 60],
      [midnight(3), 60],
      [now, 60],
    ]);

    // Read back next to the right machine's own reports: 100 + 150 + 80 + 100.
    expect(summarizeUsage([...right, ...asEvents(points)], WINDOW, "snapshot").total).toBe(430);
    const series = summarizeUsage([...right, ...asEvents(points)], WINDOW, "snapshot").series;
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({ machineId: "laptop", tokens: 430, reports: 1 });
  });

  it("carries nothing when the other identity saw no more than the target on any day", () => {
    const same = [checkpoint("x", 1, 100), checkpoint("x", 2, 250)];
    const target = [
      checkpoint("laptop", 1, 100),
      checkpoint("laptop", 2, 250),
      report("laptop", midnight(2) + HOUR, 260),
    ];
    expect(carryOver({ raw: target, carried: [] }, [{ raw: same, carried: [] }], [CYCLE], midnight(3))).toEqual([]);
  });

  it("carries everything of days only the other identity has", () => {
    const early = [checkpoint("old", 1, 100), report("old", midnight(1) + HOUR, 120)];
    const late = [report("laptop", midnight(3) + HOUR, 30)];
    const points = carryOver(
      { raw: late, carried: [] },
      [{ raw: early, carried: [] }],
      [CYCLE],
      midnight(3) + 2 * HOUR,
    );
    expect(points.at(-1)).toMatchObject({ tokens: 120 });
    expect(summarizeUsage([...late, ...asEvents(points)], WINDOW, "snapshot").total).toBe(150);
  });

  it("takes an earlier carry-over into account instead of adding to it", () => {
    const target = [checkpoint("laptop", 1, 40)];
    const earlier = asEvents(
      carryOver({ raw: target, carried: [] }, [{ raw: [checkpoint("a", 1, 100)], carried: [] }], [CYCLE], midnight(2)),
    );
    const points = carryOver(
      { raw: target, carried: earlier },
      [{ raw: [checkpoint("b", 1, 90)], carried: [] }],
      [CYCLE],
      midnight(2),
    );
    expect(points.at(-1)).toMatchObject({ tokens: 60 });
  });

  it("splits the carry-over by model, from what the winning identity saw beyond the target", () => {
    const wrong = [checkpoint("wrong", 1, 100, { opus: 70, sonnet: 30 })];
    const right = [checkpoint("laptop", 1, 40, { opus: 10, sonnet: 30 })];
    const points = carryOver({ raw: right, carried: [] }, [{ raw: wrong, carried: [] }], [CYCLE], midnight(2));
    expect(points[0]).toMatchObject({ tokens: 60, models: { opus: 60 } });
  });

  it("costs the carried tokens at the rate the identity they came from paid over the cycle", () => {
    const wrong = [checkpoint("wrong", 1, 100), report("wrong", midnight(2) - HOUR, 200, { costUsd: 10 })];
    const right = [report("laptop", midnight(2) - HOUR, 100, { costUsd: 4 })];
    const points = carryOver({ raw: right, carried: [] }, [{ raw: wrong, carried: [] }], [CYCLE], midnight(2));
    // Day 1 is the wrong install's alone (100 tokens at 5¢), day 2 both saw 100: only day 1 is carried.
    expect(points.at(-1)).toMatchObject({ tokens: 100, costUsd: 5 });
  });

  it("works each cycle out on its own, since a running total starts over with it", () => {
    const next: MergeCycle = { startMs: CYCLE.endMs, endMs: CYCLE.endMs + 7 * DAY, dayEndsMs: [] };
    const wrong = [checkpoint("wrong", 1, 100), report("wrong", CYCLE.endMs + HOUR, 10)];
    const right = [report("laptop", CYCLE.endMs + 2 * HOUR, 30)];
    const points = carryOver(
      { raw: right, carried: [] },
      [{ raw: wrong, carried: [] }],
      [CYCLE, next],
      CYCLE.endMs + 3 * HOUR,
    );
    expect(points.filter((point) => point.ts >= CYCLE.endMs)).toEqual([]);
    expect(points.at(-1)).toMatchObject({ ts: CYCLE.endMs - 1, tokens: 100 });
  });
});

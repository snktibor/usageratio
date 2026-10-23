import { describe, expect, it } from "vitest";
import { summarizeUsage, type UsageEvent } from "@/lib/aggregate";
import type { TokenMode } from "@/lib/config";
import { modelKey, modelLabel } from "@/lib/models";
import { buildTimeline, sampleTimes, withResetSamples } from "@/lib/timeline";

const HOUR = 3_600_000;
const START = Date.parse("2026-09-20T22:00:00Z");
const WEEK = { startMs: START, endMs: START + 168 * HOUR };

function report(
  machineId: string,
  groupId: string,
  tokens: number,
  hoursIntoCycle: number,
  models?: Record<string, number>,
): UsageEvent {
  return { machineId, groupId, tokens, ts: START + hoursIntoCycle * HOUR, ...(models && { models }) };
}

describe("sampleTimes", () => {
  it("samples a week hourly and ends at now", () => {
    const times = sampleTimes(WEEK.startMs, WEEK.endMs, START + 5.5 * HOUR);
    expect(times).toEqual([0, 1, 2, 3, 4, 5, 5.5].map((h) => START + h * HOUR));
  });

  it("samples a month hourly too, so a zoomed chart can show every hour", () => {
    const end = START + 31 * 24 * HOUR;
    const times = sampleTimes(START, end, end);
    expect(times[1]! - times[0]!).toBe(HOUR);
    expect(times).toHaveLength(31 * 24 + 1);
    expect(times[times.length - 1]).toBe(end);
  });

  it("has a single sample at the very start of the cycle", () => {
    expect(sampleTimes(WEEK.startMs, WEEK.endMs, START)).toEqual([START]);
  });
});

describe("buildTimeline", () => {
  const events = [
    report("mac", "Personal", 100, 0.5),
    report("mac", "Personal", 250, 2.5),
    report("win", "Work", 400, 1.5),
    report("win", "Work", 600, 3),
    // Reported from a clock slightly ahead: still counts in the last sample.
    report("win", "Work", 700, 4.05),
  ];

  it.each<TokenMode>(["delta", "snapshot", "counter"])(
    "ends on the same totals as the rest of the dashboard (%s mode)",
    (mode) => {
      const timeline = buildTimeline(events, ["Work", "Personal"], WEEK, START + 4 * HOUR, mode);
      const summary = summarizeUsage(events, WEEK, mode);
      for (const group of timeline.groups) {
        const expected = summary.groups.find((g) => g.groupId === group.groupId)?.tokens;
        expect(group.values[group.values.length - 1]).toBe(expected);
      }
    },
  );

  it("accumulates snapshots over time, a report counting from its own hour", () => {
    const timeline = buildTimeline(events, ["Work", "Personal"], WEEK, START + 4 * HOUR, "snapshot");
    expect(timeline.times).toEqual([0, 1, 2, 3, 4].map((h) => START + h * HOUR));
    expect(timeline.groups).toEqual([
      { groupId: "Work", values: [0, 0, 400, 600, 700] },
      { groupId: "Personal", values: [0, 100, 100, 250, 250] },
    ]);
  });

  it("charts only the requested groups, zero where a group has no reports", () => {
    const timeline = buildTimeline(events, ["Personal", "Idle"], WEEK, START + 4 * HOUR, "snapshot");
    expect(timeline.groups.map((g) => g.groupId)).toEqual(["Personal", "Idle"]);
    expect(timeline.groups[1]!.values).toEqual([0, 0, 0, 0, 0]);
  });

  it("gives every machine its own line within its group, the group's line being their sum", () => {
    const both = [...events, report("win-2", "Work", 50, 2.5), report("mac", "Work", 30, 0.5)];
    const timeline = buildTimeline(both, ["Work", "Personal"], WEEK, START + 4 * HOUR, "snapshot");

    expect(timeline.machines).toEqual([
      { machineId: "mac", groupId: "Personal", values: [0, 100, 100, 250, 250] },
      { machineId: "win", groupId: "Work", values: [0, 0, 400, 600, 700] },
      { machineId: "win-2", groupId: "Work", values: [0, 0, 0, 50, 50] },
      // The same machine reporting into a second group is a line of that group.
      { machineId: "mac", groupId: "Work", values: [0, 30, 30, 30, 30] },
    ]);
    expect(timeline.groups[0]).toEqual({ groupId: "Work", values: [0, 30, 430, 680, 780] });
  });

  it("leaves out the machines of other groups, and those without usage", () => {
    const quiet = [...events, report("idle", "Personal", 0, 1.5)];
    const timeline = buildTimeline(quiet, ["Personal"], WEEK, START + 4 * HOUR, "snapshot");

    expect(timeline.machines.map((machine) => machine.machineId)).toEqual(["mac"]);
  });

  it("splits by model, leaving out the reports without a split", () => {
    const withModels = [
      report("mac", "Personal", 300, 0.5),
      report("mac", "Personal", 500, 1.5, { "claude-opus-4-5-20251101": 350, "claude-haiku-4-5": 100 }),
      report("win", "Work", 900, 1.5, { "claude-opus-4-5-20251101": 900 }),
      report("win", "Work", 1_000, 2.5, { "claude-opus-4-5-20251101": 950, "claude-haiku-4-5": 50 }),
    ];
    const timeline = buildTimeline(withModels, ["Work", "Personal"], WEEK, START + 3 * HOUR, "snapshot");

    expect(timeline.models.map(({ modelId, label, tokens }) => ({ modelId, label, tokens }))).toEqual([
      { modelId: "claude-opus-4-5", label: "Claude Opus 4.5", tokens: 1_300 },
      { modelId: "claude-haiku-4-5", label: "Claude Haiku 4.5", tokens: 150 },
    ]);
    expect(timeline.models[0]!.groups).toEqual([
      { groupId: "Work", values: [0, 0, 900, 950] },
      { groupId: "Personal", values: [0, 0, 350, 350] },
    ]);
    // The first Personal report had no split: the provider total still counts it.
    expect(timeline.groups[1]!.values).toEqual([0, 300, 500, 500]);
  });

  it("merges dated builds of a model and drops models unused this cycle", () => {
    const timeline = buildTimeline(
      [
        // The previous cycle's model: nothing of it this cycle.
        report("mac", "Personal", 40, -10, { "claude-opus-4": 40 }),
        report("mac", "Personal", 60, 1, { "claude-sonnet-4-20250514": 20, "claude-sonnet-4": 40 }),
      ],
      ["Personal"],
      WEEK,
      START + 2 * HOUR,
      "delta",
    );
    expect(timeline.models).toHaveLength(1);
    expect(timeline.models[0]!.modelId).toBe("claude-sonnet-4");
    expect(timeline.models[0]!.groups[0]!.values).toEqual([0, 60, 60]);
  });
});

describe("buildTimeline with day checkpoints", () => {
  const checkpoint = (tokens: number, hoursIntoCycle: number, models?: Record<string, number>): UsageEvent => ({
    ...report("mac", "Personal", tokens, hoursIntoCycle, models),
    checkpoint: true,
  });
  // Installed 3 hours into the cycle: its first report brought the checkpoints of the finished days along.
  const events = [
    checkpoint(100, 1, { "claude-opus-5": 100 }),
    checkpoint(300, 2, { "claude-opus-5": 250 }),
    report("mac", "Personal", 350, 3, { "claude-opus-5": 290 }),
  ];

  it("places the tokens of the days before a machine's first report on their own days", () => {
    const timeline = buildTimeline(events, ["Personal"], WEEK, START + 4 * HOUR, "snapshot");
    expect(timeline.groups[0]!.values).toEqual([0, 100, 300, 350, 350]);
    expect(timeline.models[0]!.groups[0]!.values).toEqual([0, 100, 250, 290, 290]);
  });

  it.each<TokenMode>(["delta", "counter"])("leaves them out in %s mode", (mode) => {
    const timeline = buildTimeline(events, ["Personal"], WEEK, START + 4 * HOUR, mode);
    const withoutCheckpoints = buildTimeline(events.slice(2), ["Personal"], WEEK, START + 4 * HOUR, mode);
    expect(timeline.groups).toEqual(withoutCheckpoints.groups);
  });

  it("reads the larger of two readings made at the same moment", () => {
    // A day's checkpoint sent again after a late log write, next to its first version.
    const timeline = buildTimeline(
      [checkpoint(120, 2), checkpoint(100, 2), report("mac", "Personal", 150, 3)],
      ["Personal"],
      WEEK,
      START + 3 * HOUR,
      "snapshot",
    );
    expect(timeline.groups[0]!.values).toEqual([0, 0, 120, 150]);
  });
});

describe("model names", () => {
  it("drops the snapshot date from the key", () => {
    expect(modelKey("claude-sonnet-4-5-20250929")).toBe("claude-sonnet-4-5");
    expect(modelKey("deepseek-chat")).toBe("deepseek-chat");
  });

  it.each([
    ["claude-opus-4-5", "Claude Opus 4.5"],
    ["claude-3-5-haiku", "Claude 3.5 Haiku"],
    ["deepseek-chat", "DeepSeek Chat"],
    ["deepseek-v3-1", "DeepSeek V3.1"],
    ["gpt-5-codex", "GPT 5 Codex"],
    ["gemini-2.5-pro", "Gemini 2.5 Pro"],
  ])("labels %s as %s", (key, label) => {
    expect(modelLabel(key)).toBe(label);
  });
});

describe("buildTimeline across a keep reset", () => {
  // 03:20, off the hourly grid.
  const RESET = START + 3 * HOUR + 20 * 60_000;
  const events = [
    report("mac", "Personal", 100, 1),
    report("win", "Work", 50, 2),
    report("mac", "Personal", 300, 3),
    report("mac", "Personal", 80, 4),
    report("mac", "Personal", 120, 5),
  ];
  const NOW = START + 5.5 * HOUR;

  it("samples the moment before the reset and the reset itself", () => {
    expect(withResetSamples(sampleTimes(WEEK.startMs, WEEK.endMs, NOW), [RESET])).toEqual([
      ...[0, 1, 2, 3].map((h) => START + h * HOUR),
      RESET - 1,
      RESET,
      ...[4, 5, 5.5].map((h) => START + h * HOUR),
    ]);
    // A reset on the grid only adds the moment before it; none past the last sample adds anything.
    expect(withResetSamples([START, START + HOUR, START + 2 * HOUR], [START + HOUR, START + 5 * HOUR])).toEqual([
      START,
      START + HOUR - 1,
      START + HOUR,
      START + 2 * HOUR,
    ]);
  });

  it("restarts every line from 0 at the reset (delta mode)", () => {
    const timeline = buildTimeline(events, ["Personal", "Work"], WEEK, NOW, "delta", events, [RESET]);
    const personal = timeline.groups.find((group) => group.groupId === "Personal")!;
    const work = timeline.groups.find((group) => group.groupId === "Work")!;
    expect(personal.values).toEqual([0, 100, 100, 400, 400, 0, 80, 200, 200]);
    expect(work.values).toEqual([0, 0, 50, 50, 50, 0, 0, 0, 0]);
  });

  it.each<TokenMode>(["delta", "snapshot", "counter"])("ends on the segment's own totals (%s mode)", (mode) => {
    const timeline = buildTimeline(events, ["Personal", "Work"], WEEK, NOW, mode, events, [RESET]);
    const summary = summarizeUsage(events, WEEK, mode, RESET);
    for (const group of timeline.groups) {
      const expected = summary.groups.find((g) => g.groupId === group.groupId)?.tokens ?? 0;
      expect(group.values.at(-1)).toBe(expected);
    }
  });

  it("keeps the line of a machine that used tokens only before the reset", () => {
    const timeline = buildTimeline(events, ["Personal", "Work"], WEEK, NOW, "delta", events, [RESET]);
    expect(timeline.machines.find((machine) => machine.machineId === "win")?.values).toEqual([
      0, 0, 50, 50, 50, 0, 0, 0, 0,
    ]);
  });

  it("counts a model's tokens and cost since the reset, and keeps one used only before it", () => {
    const priced: UsageEvent[] = [
      {
        ...report("mac", "Personal", 100, 1, { "claude-opus-4-1": 100 }),
        costUsd: 1,
        modelCosts: { "claude-opus-4-1": 1 },
      },
      report("mac", "Personal", 30, 2, { "claude-sonnet-4-5": 30 }),
      {
        ...report("mac", "Personal", 60, 4, { "claude-opus-4-1": 60 }),
        costUsd: 1.5,
        modelCosts: { "claude-opus-4-1": 1.5 },
      },
    ];
    const timeline = buildTimeline(priced, ["Personal"], WEEK, NOW, "delta", priced, [RESET]);
    expect(timeline.models.map((model) => [model.modelId, model.tokens])).toEqual([
      ["claude-opus-4-1", 60],
      ["claude-sonnet-4-5", 0],
    ]);
    // Cost is a running total: 1.5 at the end, 1 before the reset.
    expect(timeline.models[0]!.cost).toBeCloseTo(0.5);
  });

  it("counts a model across every segment from fromMs on, lines still restarting at the reset", () => {
    const priced: UsageEvent[] = [
      {
        ...report("mac", "Personal", 100, 1, { "claude-opus-4-1": 100 }),
        costUsd: 1,
        modelCosts: { "claude-opus-4-1": 1 },
      },
      {
        ...report("mac", "Personal", 60, 4, { "claude-opus-4-1": 60 }),
        costUsd: 1.5,
        modelCosts: { "claude-opus-4-1": 1.5 },
      },
    ];
    const timeline = buildTimeline(priced, ["Personal"], WEEK, NOW, "delta", priced, [RESET], WEEK.startMs);
    expect(timeline.models.map((model) => [model.modelId, model.tokens])).toEqual([["claude-opus-4-1", 160]]);
    expect(timeline.models[0]!.cost).toBeCloseTo(1.5);
    expect(timeline.groups[0]!.values.at(-1)).toBe(60);
  });
});

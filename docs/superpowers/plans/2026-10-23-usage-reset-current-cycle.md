# Usage reset — current cycle UI (plan 2 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the current cycle the way a recorded usage reset leaves it: the dashboard counts the current
segment, the meter states the resets, the charts mark them and restart their lines from 0, the dashboard
records, edits, deletes and reverts resets, asks "Was there a reset?" when the official figure is dragged
down, and the settings choose each provider's reset type.

**Architecture:** The dashboard model (`lib/dashboard.ts`) learns the provider's reset events and gains a
`segment` (the stretch since the cycle's last keep reset), a `resets` list and `groupColors`; every figure
but the timeline counts the segment, through `summarizeUsage(…, fromMs)` (plan 1) and the new `fromMs` /
`resetsMs` parameters of the cost, timeline and sub-limit code. The browser's restatement
(`lib/ground-truth.ts`), the recent pace and the group-machine chart read the segment from the model. The
UI adds a reset line to the meter, reset markers to the charts, `components/reset-panel.tsx` (the panel
and the "Was there a reset?" question) over `/api/resets` (plan 1), and a reset-type select on the
settings page.

**Tech Stack:** Next.js 16 App Router, React 19 client components, next-intl (en/hu/de), Tailwind v4,
TypeScript, Vitest (node + jsdom projects), Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-22-usage-reset-design.md` (sections "The current cycle on the
dashboard", "Setting — the reset type", "Recording — `/api/resets`"). Plan 1:
`docs/superpowers/plans/2026-10-22-usage-reset-core.md` (done; its interfaces are listed per task below).

## Global Constraints

- Worktree `/Users/snktibor/Documents/Projects/usageratio-usage-reset`, branch `feat/usage-reset`; never
  commit on `main`; do not push or open a PR in this plan.
- Conventional Commits. **No AI attribution in any commit message**: no `Co-Authored-By` naming an AI, no
  "Generated with …" line, nothing saying the commit was AI-assisted.
- Pure logic in `lib/`, tests in `tests/` (`tests/*.test.ts` node, `tests/components/**/*.test.tsx`
  jsdom, `tests/integration/**/*.test.ts`); no chart library; no new dependencies.
- UI text only through `messages/*.json`, en/hu/de in parity, every key used by literal or
  template-literal `t(…)` calls (`tests/messages.test.ts`). The files round-trip exactly through
  `JSON.stringify(…, null, 2) + "\n"`, so keys are added with the node snippet given in each task.
- The macOS app and the `GET /api/status` payload shape are not changed; `/api/status` follows the
  segment only because it is built from the same model.
- Thresholds: "Was there a reset?" shows when the field is edited **below 10%** and **at least 5 points**
  (`RESET_DROP_POINTS`) under the figure it held when the edit began; never on a closed cycle.
- R is a whole minute (`MINUTE_MS`); recording reaches back to the current cycle's start only (the server
  enforces it, `409 outside_cycle`).
- A typed official figure (own and sub-limits) is tagged with the **current segment's start**.
- `npm run check` (`biome ci` + `tsc --noEmit` + Vitest) passes at the end of every task. Run one test
  file with `npx vitest run <file>`. The code in this plan is not Biome-formatted line by line: run
  `npm run format` before `npm run check` and commit what it changes.

## Deviations from the spec (found while planning)

1. **A closed cycle counts whole in this plan.** The detail view of a past cycle (`?cycle=`) keeps today's
   whole-cycle figures and no reset list; adding its segments up is plan 3.
2. **Two extra timeline samples per keep reset**, at R − 1 ms and at R. The finished segment's lines end
   exactly on its total and drop vertically to 0 at R, and its measured tokens are exact for scaling.
3. **A finished segment without a before-figure** is scaled at the current segment's rate and drawn under
   a page-coloured veil (the spec's "measured-only (faint)": a single series cannot be partly faint).
4. **"Was there a reset?" shows only once the field's save has settled.** While the debounced
   `PUT /api/official-usage` is under way the question waits, so the reset's `afterRaw` (stored at R) is
   never overwritten by that save, which carries the old segment's tag.
5. **Row actions:** a manual reset offers Edit and Delete; a detected one (`source: "report"`) offers Edit
   and **Wrong – revert** instead of Delete (the spec's "or"). A detected keep reset's time is an upper
   bound, so it must stay editable.
6. **The timeline charts every group of the whole cycle**, so a group that used tokens only before a
   reset keeps its line; its colour comes from the new `DashboardModel.groupColors`, as it is not among
   the segment's `groups`.

## File structure

| File | Responsibility |
| --- | --- |
| `lib/aggregate.ts` | `summarizeCost(…, fromMs)`: a segment's cost |
| `lib/timeline.ts` | `withResetSamples`, lines restarting at each keep reset, a model's cost since the segment start |
| `lib/sub-limits.ts` | `measureSubLimits(…, resetsMs)`: sub-limits count the segment |
| `lib/dashboard.ts` | `segment`, `resets`, `groupColors`, `DashboardReset`, `DaySpan`; previous cycle from `providerCycle`; `resetMode` |
| `app/[locale]/(dashboard)/page.tsx`, `lib/status.ts` | pass the resets into the model |
| `lib/ground-truth.ts` | the restatement and pace over the segment; `timelineRates` |
| `lib/recent-pace.ts`, `lib/group-machines.ts` | segment window; per-segment rates |
| `components/cycle-ruler.tsx`, `components/quota-meter.tsx` | the meter over the segment; the reset line |
| `components/cycle-chart.tsx`, `components/usage-chart.tsx`, `components/model-chart.tsx` | reset markers, veils, per-segment scaling, whole-cycle group colours |
| `lib/cycle.ts` | `wallClockInput` / `fromWallClockInput` for the `datetime-local` field |
| `components/reset-requests.ts` (new) | `sendReset`: the browser's calls to `/api/resets` |
| `components/reset-panel.tsx` (new) | `ResetPanel` (record/edit/delete/revert) and `ResetPrompt` ("Was there a reset?") |
| `components/use-reset-prompt.ts` (new) | when the question stands |
| `lib/resets.ts`, `lib/official-report.ts` | `RESET_DROP_POINTS` moves to `lib/resets.ts`; `promptsReset` |
| `components/ground-truth-input.tsx`, `components/dashboard-view.tsx`, `components/use-official-entry.ts` | wiring; the segment tag |
| `components/settings/sections/reset-section.tsx` | the reset-type select; the `"reset"` marker |
| `messages/{en,hu,de}.json` | the new text |
| `docs/configuration.md`, `docs/api.md` | "Usage resets", the select, alerts per segment, the segment tag |

---

### Task 1: Lines that restart at a reset (timeline, cost, sub-limits)

**Files:**
- Modify: `lib/aggregate.ts` (`summarizeCost`)
- Modify: `lib/timeline.ts` (`totalTimeline`, `groupTimelines`, `machineTimelines`, `modelCostTotal`, `buildTimeline`, docs of `CycleTimeline` / `ModelTimeline`)
- Modify: `lib/sub-limits.ts` (`measureSubLimits`, doc of `SubLimitModel`)
- Test: `tests/aggregate.test.ts`, `tests/timeline.test.ts`, `tests/sub-limits.test.ts`

**Interfaces:**
- Consumes (plan 1): `summarizeUsage(events, window, mode, fromMs = window.startMs)` in `lib/aggregate.ts`
  counts each series' usage up to the window's end less its usage up to `fromMs`.
- Produces:
  - `summarizeCost(events: UsageEvent[], window: TimeWindow, fromMs: number = window.startMs): CostSummary`
  - `withResetSamples(times: number[], resetsMs: number[]): number[]` (exported from `lib/timeline.ts`)
  - `totalTimeline(events, times, window, mode, resetsMs: number[] = []): number[]`
  - `buildTimeline(events, groupIds, window, nowMs, mode, modelEvents = events, resetsMs: number[] = []): CycleTimeline`
    — `resetsMs` are the cycle's keep resets up to now, ascending; `times` then holds R − 1 and R for each.
  - `measureSubLimits(subLimits, reports, window, times, mode, providerLimit, resetsMs: number[] = []): SubLimitModel[]`

- [ ] **Step 1: Write the failing tests**

Append to `tests/aggregate.test.ts` (it already imports `summarizeCost`, `UsageEvent`, and has `ev()` and
`WINDOW = { startMs: 1000, endMs: 2000 }`):

```ts
describe("summarizeCost — from a moment", () => {
  it("counts only what accrued from fromMs on, by machine and group", () => {
    const events: UsageEvent[] = [
      { ...ev("mac", "Personal", 10, 1100), costUsd: 2 },
      { ...ev("mac", "Personal", 20, 1600), costUsd: 5 },
      // No cost figure since fromMs: left out, as a machine that never sent one is.
      { ...ev("win", "Work", 5, 1200), costUsd: 1 },
    ];
    expect(summarizeCost(events, WINDOW, 1500)).toEqual({
      total: 3,
      byGroup: { Personal: 3 },
      byMachine: { mac: 3 },
      hasCost: true,
    });
  });
});
```

Append to `tests/timeline.test.ts`; change its import of `@/lib/timeline` to
`import { buildTimeline, sampleTimes, withResetSamples } from "@/lib/timeline";`:

```ts
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
      { ...report("mac", "Personal", 100, 1, { "claude-opus-4-1": 100 }), costUsd: 1, modelCosts: { "claude-opus-4-1": 1 } },
      report("mac", "Personal", 30, 2, { "claude-sonnet-4-5": 30 }),
      { ...report("mac", "Personal", 60, 4, { "claude-opus-4-1": 60 }), costUsd: 1.5, modelCosts: { "claude-opus-4-1": 1.5 } },
    ];
    const timeline = buildTimeline(priced, ["Personal"], WEEK, NOW, "delta", priced, [RESET]);
    expect(timeline.models.map((model) => [model.modelId, model.tokens])).toEqual([
      ["claude-opus-4-1", 60],
      ["claude-sonnet-4-5", 0],
    ]);
    // Cost is a running total: 1.5 at the end, 1 before the reset.
    expect(timeline.models[0]!.cost).toBeCloseTo(0.5);
  });
});
```

In `tests/sub-limits.test.ts`, change the import of `@/lib/timeline` to
`import { sampleTimes, withResetSamples } from "@/lib/timeline";` and append inside
`describe("measureSubLimits", …)` (it has `window`, `times`, `report()`, `FABLE`, `CYCLE_END`):

```ts
  it("measures the current segment after a keep reset, its line restarting from 0", () => {
    const reset = CYCLE_START + 15 * HOUR;
    const events = [
      report("mac", "Home", 10, { "claude-fable-5-1": 100 }),
      report("mac", "Home", 20, { "claude-fable-5-1": 250 }),
      report("win", "Work", 30, { "claude-fable-5-1": 40 }),
    ];
    const segmentTimes = withResetSamples(times, [reset]);
    const [fable] = measureSubLimits(
      [FABLE],
      splitBySubLimits(events, [FABLE]).bySubLimit,
      window,
      segmentTimes,
      "snapshot",
      1_000_000,
      [reset],
    );
    // Running totals: the Mac's 250 less the 100 it had counted before the reset, and the PC's 40.
    expect(fable!.total).toBe(190);
    expect(fable!.values[segmentTimes.indexOf(reset - 1)]).toBe(100);
    expect(fable!.values[segmentTimes.indexOf(reset)]).toBe(0);
    expect(fable!.values.at(-1)).toBe(190);
    expect(fable!.quota).toMatchObject({ limit: 200_000, usedFraction: 190 / 200_000 });
    expect(fable!.quota!.pace.dailyShare).toBeCloseTo((24 * HOUR) / (CYCLE_END - reset));
  });

  it("knows nothing of a sub-limit whose models reported only before the reset", () => {
    const reset = CYCLE_START + 15 * HOUR;
    const events = [report("mac", "Home", 10, { "claude-fable-5-1": 100 })];
    const [fable] = measureSubLimits(
      [FABLE],
      splitBySubLimits(events, [FABLE]).bySubLimit,
      window,
      withResetSamples(times, [reset]),
      "snapshot",
      null,
      [reset],
    );
    expect(fable).toMatchObject({ total: 0, hasSplit: false, models: [] });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/aggregate.test.ts tests/timeline.test.ts tests/sub-limits.test.ts`
Expected: FAIL — `withResetSamples` is not exported; `summarizeCost` ignores its third argument (total 5).

- [ ] **Step 3: `summarizeCost` from a moment**

In `lib/aggregate.ts`, replace `summarizeCost` (its doc comment too) with:

```ts
/**
 * The window's cost, by machine and by group, and in total; only over the
 * machines that reported a cost figure at all in the window (a machine that
 * sent none is simply left out, rather than shown at $0). Mirrors
 * `summarizeUsage`, minus the token-mode/share/report bookkeeping cost has no
 * use for, `fromMs` included: only what accrued from then on counts, one
 * segment of a cycle (lib/resets.ts).
 */
export function summarizeCost(events: UsageEvent[], window: TimeWindow, fromMs: number = window.startMs): CostSummary {
  let total = 0;
  const byGroup: Record<string, number> = {};
  const byMachine: Record<string, number> = {};
  let hasCost = false;

  for (const series of groupIntoSeries(events)) {
    const inWindow = series.filter((e) => e.ts >= fromMs && e.ts < window.endMs);
    if (!inWindow.some((e) => e.costUsd !== undefined)) continue;
    hasCost = true;
    const [before, until] = costOfSeriesUntil(series, window.startMs, [fromMs, window.endMs]);
    const cost = until! - before!;
    const { machineId, groupId } = series[0]!;
    byMachine[machineId] = (byMachine[machineId] ?? 0) + cost;
    byGroup[groupId] = (byGroup[groupId] ?? 0) + cost;
    total += cost;
  }

  return { total, byGroup, byMachine, hasCost };
}
```

- [ ] **Step 4: Lines that restart at a reset**

In `lib/timeline.ts`:

Change the doc of `ModelTimeline.tokens` to `/** Its tokens in the current segment (the cycle, without keep resets), over all groups. */`,
of `ModelTimeline.cost` to `/** Its API-list-price cost estimate in the current segment, over all groups; undefined without a cost split naming it. */`,
and the doc of `CycleTimeline` fields:

```ts
export interface CycleTimeline {
  /**
   * Sample times, epoch ms: the cycle's start, then every full step, and last
   * the moment of the dashboard; around each keep reset, R − 1 and R as well
   * (`withResetSamples`).
   */
  times: number[];
  /** Cumulative tokens since the segment each sample falls in began: every line restarts from 0 at a keep reset. */
  groups: GroupSeries[];
  /** The machines of those groups with usage this cycle, each within its group; in no particular order. */
  machines: MachineSeries[];
  /** Only models with usage this cycle, the heaviest in the current segment first. */
  models: ModelTimeline[];
}
```

Add after `sampleEnds`:

```ts
/**
 * `times` with two samples for each keep reset inside them: the moment before
 * it, where a finished segment's lines end on its total, and the reset itself,
 * where they start again from 0. A reset at or before the first sample, or
 * after the last, adds none.
 */
export function withResetSamples(times: number[], resetsMs: number[]): number[] {
  const first = times[0];
  const last = times[times.length - 1];
  if (first === undefined || last === undefined) return times;
  const extra = resetsMs.filter((atMs) => atMs > first && atMs <= last).flatMap((atMs) => [atMs - 1, atMs]);
  return extra.length === 0 ? times : [...new Set([...times, ...extra])].sort((a, b) => a - b);
}

/**
 * One series' usage at each sample (`endsMs`: see `sampleEnds`), counted from
 * the last of `resetsMs` (ascending) at or before the sample: the same
 * difference `summarizeUsage` takes with `fromMs` (lib/aggregate.ts), so the
 * last sample ends on the current segment's figures.
 */
function seriesValues(
  series: UsageEvent[],
  times: number[],
  endsMs: number[],
  startMs: number,
  resetsMs: number[],
  mode: TokenMode,
): number[] {
  const usages = usageOfSeriesUntil(series, startMs, endsMs, mode);
  if (resetsMs.length === 0) return usages;
  const bases = usageOfSeriesUntil(series, startMs, resetsMs, mode);
  return usages.map((usage, index) => {
    const passed = resetsMs.filter((atMs) => atMs <= times[index]!).length;
    return passed === 0 ? usage : usage - bases[passed - 1]!;
  });
}
```

Replace `totalTimeline`, `groupTimelines` and `machineTimelines` with:

```ts
/** All of `events` together, cumulated at each of `times` exactly as the groups are. */
export function totalTimeline(
  events: UsageEvent[],
  times: number[],
  window: { startMs: number; endMs: number },
  mode: TokenMode,
  resetsMs: number[] = [],
): number[] {
  const endsMs = sampleEnds(times, window);
  const values = times.map(() => 0);
  for (const series of groupIntoSeries(events)) {
    seriesValues(series, times, endsMs, window.startMs, resetsMs, mode).forEach((usage, index) => {
      values[index]! += usage;
    });
  }
  return values;
}

/** Every group's cumulative usage at each of `times`; see `sampleEnds` and `seriesValues`. */
function groupTimelines(
  events: UsageEvent[],
  groupIds: string[],
  times: number[],
  window: { startMs: number; endMs: number },
  mode: TokenMode,
  resetsMs: number[],
): GroupSeries[] {
  const endsMs = sampleEnds(times, window);
  const byGroup = new Map(groupIds.map((groupId) => [groupId, times.map(() => 0)]));

  for (const series of groupIntoSeries(events)) {
    const values = byGroup.get(series[0]!.groupId);
    if (!values) continue;
    seriesValues(series, times, endsMs, window.startMs, resetsMs, mode).forEach((usage, index) => {
      values[index]! += usage;
    });
  }
  return groupIds.map((groupId) => ({ groupId, values: byGroup.get(groupId)! }));
}

/**
 * Every machine's cumulative usage at each of `times`, within each of `groupIds`
 * (a merged machine's carry-over counted into its line). A machine without
 * usage this cycle has no line: its line would lie on the axis. One that used
 * tokens only before a keep reset keeps its line.
 */
function machineTimelines(
  events: UsageEvent[],
  groupIds: string[],
  times: number[],
  window: { startMs: number; endMs: number },
  mode: TokenMode,
  resetsMs: number[],
): MachineSeries[] {
  const endsMs = sampleEnds(times, window);
  const byMachine = new Map<string, MachineSeries>();

  for (const series of groupIntoSeries(events)) {
    const { groupId, machineId } = series[0]!;
    if (!groupIds.includes(groupId)) continue;
    const key = JSON.stringify([groupId, machineId]);
    const machine = byMachine.get(key) ?? { machineId, groupId, values: times.map(() => 0) };
    byMachine.set(key, machine);
    seriesValues(series, times, endsMs, window.startMs, resetsMs, mode).forEach((usage, index) => {
      machine.values[index]! += usage;
    });
  }
  return [...byMachine.values()].filter((machine) => machine.values.some((value) => value > 0));
}
```

Replace `modelCostTotal` with (doc and body):

```ts
/**
 * A model's cost ($) since `fromMs` (the current segment's start), summed over
 * every machine that named it in a split; undefined when nothing did (no
 * client sent a cost, or none tied this particular model's cost down). Cost
 * is always cycle-to-date snapshot semantics (lib/aggregate.ts
 * `costOfSeriesUntil`), independent of the provider's own token mode.
 */
function modelCostTotal(
  events: UsageEvent[],
  key: string,
  window: { startMs: number; endMs: number },
  fromMs: number,
): number | undefined {
  let total: number | undefined;
  for (const series of groupIntoSeries(events)) {
    const costSeries = series.flatMap((event) => {
      if (!event.modelCosts) return [];
      let cost: number | undefined;
      for (const [modelId, amount] of Object.entries(event.modelCosts)) {
        if (modelKey(modelId) === key) cost = (cost ?? 0) + amount;
      }
      return cost === undefined ? [] : [{ ...event, costUsd: cost }];
    });
    if (costSeries.length === 0) continue;
    const [before, until] = costOfSeriesUntil(costSeries, window.startMs, [fromMs, window.endMs]);
    total = (total ?? 0) + until! - before!;
  }
  return total;
}
```

Replace `buildTimeline` (doc and body) with:

```ts
/**
 * `events` may reach back before the cycle (counter mode's baseline);
 * `groupIds` are the groups to chart, in the order to chart them. The models
 * come from `modelEvents`: the provider's reports as sent, while `events` may
 * have a separate sub-limit's tokens taken out (lib/sub-limits.ts).
 * `resetsMs` are the cycle's keep resets up to now, ascending (lib/resets.ts):
 * every line restarts from 0 at each, and a model's tokens and cost are the
 * current segment's.
 */
export function buildTimeline(
  events: UsageEvent[],
  groupIds: string[],
  window: { startMs: number; endMs: number },
  nowMs: number,
  mode: TokenMode,
  modelEvents: UsageEvent[] = events,
  resetsMs: number[] = [],
): CycleTimeline {
  const times = withResetSamples(sampleTimes(window.startMs, window.endMs, nowMs), resetsMs);
  const last = times.length - 1;
  const segmentStartMs = resetsMs.at(-1) ?? window.startMs;

  const keys = new Set<string>();
  for (const event of modelEvents) {
    for (const modelId of Object.keys(event.models ?? {})) keys.add(modelKey(modelId));
  }

  const models = [...keys]
    .map((key) => {
      const groups = groupTimelines(reportsOfModel(modelEvents, key), groupIds, times, window, mode, resetsMs);
      const tokens = groups.reduce((sum, group) => sum + group.values[last]!, 0);
      const cost = modelCostTotal(modelEvents, key, window, segmentStartMs);
      return { modelId: key, label: modelLabel(key), tokens, groups, ...(cost !== undefined && { cost }) };
    })
    // A model used only before a reset has none of the segment's tokens, but still a line to draw.
    .filter((model) => model.groups.some((group) => group.values.some((value) => value > 0)))
    .sort((a, b) => b.tokens - a.tokens || a.modelId.localeCompare(b.modelId));

  return {
    times,
    groups: groupTimelines(events, groupIds, times, window, mode, resetsMs),
    machines: machineTimelines(events, groupIds, times, window, mode, resetsMs),
    models,
  };
}
```

- [ ] **Step 5: Sub-limits count the segment**

In `lib/sub-limits.ts`, change the docs of `SubLimitModel.total` to
`/** Tokens its models measured in the current segment (the cycle, without keep resets). */`, of `values` to
`/** Its cumulative tokens at each sample of the dashboard's timeline, restarting at each keep reset; the last one is `total`. */`,
of `hasSplit` to `/** Whether any report of the current segment came with a split by model: without one nothing is known of it. */`,
of `models` to `/** The current segment's models that belong to it, by label, the heaviest first. */`, and replace
`measureSubLimits` (doc and body) with:

```ts
/**
 * `reports` as split by `splitBySubLimits`; `times` are the samples of the
 * dashboard's timeline; `providerLimit` is the provider's token budget, null
 * while the token limits are off; `resetsMs` the cycle's keep resets up to
 * now, ascending: a sub-limit counts the current segment, as the provider does.
 */
export function measureSubLimits(
  subLimits: SubLimit[],
  reports: SplitReports["bySubLimit"],
  window: TimeWindow & { nowMs: number },
  times: number[],
  mode: TokenMode,
  providerLimit: number | null,
  resetsMs: number[] = [],
): SubLimitModel[] {
  const fromMs = resetsMs.at(-1) ?? window.startMs;
  return subLimits.map((sub) => {
    const events = reports.get(sub.id) ?? [];
    const inSegment = events.filter((event) => event.ts >= fromMs && event.ts < window.endMs);
    const total = summarizeUsage(events, window, mode, fromMs).total;

    // Only orders the labels: each model's largest reading is near enough to its share, in every token mode.
    const tokensByModel = new Map<string, number>();
    for (const event of inSegment) {
      for (const [modelId, tokens] of Object.entries(event.models ?? {})) {
        const key = modelKey(modelId);
        tokensByModel.set(key, Math.max(tokensByModel.get(key) ?? 0, tokens));
      }
    }
    const models = [...tokensByModel]
      .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
      .map(([key]) => modelLabel(key));

    const shareCap = sub.mode === "share" ? sub.sharePercent / 100 : null;
    const limit = providerLimit === null ? null : shareCap === null ? sub.limit : shareCap * providerLimit;
    return {
      id: sub.id,
      name: sub.name,
      mode: sub.mode,
      shareCap,
      total,
      values: totalTimeline(events, times, window, mode, resetsMs),
      hasSplit: inSegment.length > 0,
      models,
      quota: limit === null ? null : assessQuota(total, limit, { ...window, startMs: fromMs }),
    };
  });
}
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/aggregate.test.ts tests/timeline.test.ts tests/sub-limits.test.ts tests/dashboard.test.ts`
Expected: PASS (the dashboard tests show nothing changed without resets).

- [ ] **Step 7: Full check and commit**

Run: `npm run check` — Expected: PASS.

```bash
git add lib/aggregate.ts lib/timeline.ts lib/sub-limits.ts tests/aggregate.test.ts tests/timeline.test.ts tests/sub-limits.test.ts
git commit -m "feat(resets): restart the timeline, cost and sub-limits at a keep reset"
```

### Task 2: The dashboard model's segment

**Files:**
- Modify: `lib/dashboard.ts`
- Modify: `app/[locale]/(dashboard)/page.tsx:136` (the `store`), `lib/status.ts:219` (the store literal)
- Modify: `components/dashboard-view.tsx:59-79` (the tag of a typed figure), `components/use-official-entry.ts` (doc)
- Modify: `docs/api.md` (`PUT /api/official-usage`, the `cycleStartMs` sentence)
- Test: `tests/dashboard.test.ts`, `tests/integration/status.test.ts`, `tests/components/dashboard-view.test.tsx`

**Interfaces:**
- Consumes (plan 1, `lib/resets.ts`): `ResetEvent { id, atMs, kind: "keep" | "restart", cycleStartMs, before: number | null, beforeAtMs, source: "manual" | "report", recordedAtMs, previousOverride? }`,
  `ProviderResets { v: 1, events, autoOffCycleStartMs }`, `ResetSource`, `keepResetsOf(cycle: TimeWindow, events)` (keep events recorded in that cycle, strictly inside it, sorted),
  `restartStarting(events, startMs)`, `resetEventsOf(all: Record<string, ProviderResets>, providerId)`.
  `lib/provider-cycles.ts` `providerCycle(now, config, providerId, resets: ResetEvent[]): { cycle: Cycle; previous: Cycle }` (a cycle a restart began comes after `[S, R)`).
  `lib/settings.ts` `resetModeOf(config: Pick<AppConfig, "resetModes">, providerId): ResetMode`. `loadIndexes().resets: Record<string, ProviderResets>`.
  Task 1: `summarizeCost(…, fromMs)`, `buildTimeline(…, modelEvents, resetsMs)`, `measureSubLimits(…, resetsMs)`.
- Produces (`lib/dashboard.ts`):
  - `export interface DaySpan { startFraction: number; endFraction: number; weekday: number; monthDay: number }` — `DashboardModel["cycle"]["segments"]` is `DaySpan[]`.
  - `export interface DashboardReset { id: string; atMs: number; kind: ResetMode; before: number | null; source: ResetSource; tokens: number | null }`
  - `DashboardModel.segment: { startMs: number; endMs: number; elapsedFraction: number; days: DaySpan[] }`
  - `DashboardModel.resets: DashboardReset[]` (the restart the cycle began with, then its keep resets up to now; `[]` for a closed cycle)
  - `DashboardModel.groupColors: Record<string, string>` (every charted group)
  - `StoreSnapshot.resets?: ResetEvent[]`, `ProviderStoreSnapshot.resets?: Record<string, ProviderResets>`
  - `ProviderDashboardModel.resetMode: ResetMode`

- [ ] **Step 1: Write the failing model tests**

In `tests/dashboard.test.ts` add `import type { ResetEvent } from "@/lib/resets";` and append:

```ts
function keepReset(hoursIntoCycle: number, before: number | null, overrides: Partial<ResetEvent> = {}): ResetEvent {
  const atMs = CYCLE_START + hoursIntoCycle * HOUR;
  return {
    id: `r${hoursIntoCycle}`,
    atMs,
    kind: "keep",
    cycleStartMs: CYCLE_START,
    before,
    beforeAtMs: null,
    source: "manual",
    recordedAtMs: atMs,
    ...overrides,
  };
}

describe("buildDashboard — a keep reset", () => {
  // Work's 30k on Monday 10:00 and Home's 20k on Monday 20:00; the reset on Tuesday 14:00 (38 h in); then 12k of Work's.
  const events = [report("win", "Work", 30_000, 10), report("mac", "Home", 20_000, 20), report("win", "Work", 12_000, 40)];
  const model = buildDashboard(NOW, config, snapshot({ events, resets: [keepReset(38, 80)] }));

  it("counts the segment since the reset only", () => {
    expect(model.total).toBe(12_000);
    expect(model.groups.map((group) => [group.groupId, group.tokens])).toEqual([["Work", 12_000]]);
    expect(model.machines.map((machine) => [machine.machineId, machine.tokens])).toEqual([["win", 12_000]]);
    expect(model.quota!.usedFraction).toBeCloseTo(12_000 / 500_000);
  });

  it("judges the pace over the segment: the quota's window starts at the reset", () => {
    expect(model.segment).toMatchObject({ startMs: CYCLE_START + 38 * HOUR, endMs: CYCLE_START + 168 * HOUR });
    expect(model.segment.elapsedFraction).toBeCloseTo(22 / 130);
    expect(model.cycle.elapsedFraction).toBeCloseTo(60 / 168);
    expect(model.quota!.pace.dailyShare).toBeCloseTo(24 / 130);
  });

  it("lays the segment's days out for the ruler: Tuesday from 14:00, then whole days", () => {
    expect(model.segment.days).toHaveLength(6);
    expect(model.segment.days[0]).toMatchObject({ startFraction: 0, weekday: 2 });
    expect(model.segment.days[0]!.endFraction).toBeCloseTo(10 / 130);
    expect(model.segment.days.at(-1)!.endFraction).toBeCloseTo(1);
  });

  it("lists the reset with the tokens of the segment it ended", () => {
    expect(model.resets).toEqual([
      { id: "r38", atMs: CYCLE_START + 38 * HOUR, kind: "keep", before: 80, source: "manual", tokens: 50_000 },
    ]);
  });

  it("charts the whole cycle, every line restarting from 0 at the reset, every group in its colour", () => {
    const { times, groups } = model.timeline;
    const home = groups.find((group) => group.groupId === "Home")!;
    const work = groups.find((group) => group.groupId === "Work")!;
    const before = times.indexOf(CYCLE_START + 38 * HOUR - 1);
    const at = times.indexOf(CYCLE_START + 38 * HOUR);
    expect([home.values[before], work.values[before]]).toEqual([20_000, 30_000]);
    expect([home.values[at], work.values[at]]).toEqual([0, 0]);
    expect(work.values.at(-1)).toBe(12_000);
    expect(Object.keys(model.groupColors).sort()).toEqual(["Home", "Work"]);
  });

  it("estimates the segment's cost only", () => {
    const priced = buildDashboard(
      NOW,
      { ...config, costEstimate: true },
      snapshot({
        events: [
          { ...report("win", "Work", 30_000, 10), costUsd: 3 },
          { ...report("win", "Work", 12_000, 40), costUsd: 4 },
        ],
        resets: [keepReset(38, 80)],
      }),
    );
    expect(priced.cost?.total).toBeCloseTo(1);
  });

  it("leaves out a reset of another cycle, and one still ahead", () => {
    const other = buildDashboard(
      NOW,
      config,
      snapshot({ events, resets: [keepReset(38, 80, { cycleStartMs: CYCLE_START - 168 * HOUR }), keepReset(70, 50)] }),
    );
    expect(other.total).toBe(62_000);
    expect(other.resets).toEqual([]);
    expect(other.segment).toMatchObject({ startMs: CYCLE_START, elapsedFraction: other.cycle.elapsedFraction });
  });

  it("counts a closed cycle whole", () => {
    const closed = buildDashboard(
      new Date(CYCLE_START + 200 * HOUR),
      config,
      snapshot({ events, resets: [keepReset(38, 80)] }),
      [],
      {
        cycle: { start: new Date(CYCLE_START), end: new Date(CYCLE_START + 168 * HOUR) },
        previous: { start: new Date(CYCLE_START - 168 * HOUR), end: new Date(CYCLE_START) },
      },
    );
    expect(closed.total).toBe(62_000);
    expect(closed.resets).toEqual([]);
    expect(closed.segment.startMs).toBe(CYCLE_START);
  });
});

describe("buildProviderDashboards — a restart", () => {
  it("compares with the cycle the restart cut short, and lists the restart", () => {
    // Codex reset on Tuesday 14:00: its own reset moved there, and a fresh cycle started.
    const R = CYCLE_START + 38 * HOUR;
    const restart: ResetEvent = {
      id: "codex",
      atMs: R,
      kind: "restart",
      cycleStartMs: CYCLE_START,
      before: 62,
      beforeAtMs: R - HOUR,
      source: "report",
      recordedAtMs: R,
      previousOverride: null,
    };
    const [openai] = buildProviderDashboards(
      NOW,
      {
        ...config,
        resetOverrides: { openai: { weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" as const } },
      },
      ["openai"],
      {
        // 5k the Sunday before (outside [S, R), inside the week before R), 30k on Monday, 12k since the reset.
        eventsByProvider: {
          openai: [report("win", "Work", 5_000, -5), report("win", "Work", 30_000, 10), report("win", "Work", 12_000, 40)],
        },
        groups: [],
        machines: [],
        resets: { openai: { v: 1, events: [restart], autoOffCycleStartMs: null } },
      },
    );
    expect(openai!.resetMode).toBe("restart");
    expect(openai!.dashboard.cycle.startMs).toBe(R);
    expect(openai!.dashboard.total).toBe(12_000);
    expect(openai!.dashboard.previousTotal).toBe(30_000);
    expect(openai!.dashboard.resets).toEqual([
      { id: "codex", atMs: R, kind: "restart", before: 62, source: "report", tokens: null },
    ]);
  });
});
```

Run: `npx vitest run tests/dashboard.test.ts`
Expected: FAIL — `resets` is not a `StoreSnapshot` field (type error at runtime is ignored by Vitest, so the
assertions fail: `model.total` is 62 000, `model.segment` is undefined).

- [ ] **Step 2: The model**

In `lib/dashboard.ts`:

Imports become:

```ts
import { summarizeCost, summarizeUsage, type TimeWindow, type UsageEvent } from "@/lib/aggregate";
import type { AppConfig, BudgetPeriod, ResetMode, TokenMode } from "@/lib/config";
import { type Cycle, getCycle, getDaySegments, getPreviousCycle } from "@/lib/cycle";
import { type OfficialEntryView, officialUsageField } from "@/lib/official-usage";
import { providerCycle } from "@/lib/provider-cycles";
import { providerLabel } from "@/lib/providers";
import { assessQuota, type QuotaAssessment } from "@/lib/quota";
import {
  keepResetsOf,
  type ProviderResets,
  type ResetEvent,
  type ResetSource,
  resetEventsOf,
  restartStarting,
} from "@/lib/resets";
import { estimateResources, type ResourceEstimate } from "@/lib/resources";
import {
  configForProvider,
  countsForProvider,
  type KnownGroup,
  NEUTRAL_COLOR,
  resetModeOf,
  resolveGroupColors,
  subLimitsOf,
  visibleProviderIds,
} from "@/lib/settings";
```

`StoreSnapshot` gains, after `machines`:

```ts
  /** The provider's reset events (lib/resets.ts); none: its cycle has no segments. */
  resets?: ResetEvent[];
```

Add before `DashboardModel`:

```ts
/** One day of a stretch of time, as fractions of it: what the rulers under the meter and the charts lay out. */
export interface DaySpan {
  startFraction: number;
  endFraction: number;
  weekday: number;
  monthDay: number;
}

/** A reset of the cycle on screen (lib/resets.ts): the restart it began with, or one of its keep resets. */
export interface DashboardReset {
  id: string;
  /** R: a whole minute. */
  atMs: number;
  kind: ResetMode;
  /** 0–100, the official figure right before it; null while unknown. A restart's belongs to the previous cycle. */
  before: number | null;
  source: ResetSource;
  /** Keep: the tokens the machines measured in the segment it ended; null for a restart. */
  tokens: number | null;
}
```

In `DashboardModel`: change the doc of `total` to
`/** Tokens the machines measured in the current segment (`segment`); a separate sub-limit's are not among them. */`,
change `cycle.segments`' type to `DaySpan[]` with the doc `/** The cycle's days: the chart's ruler. */`, change the
`groups[].share` doc to `/** Fraction of the segment's usage. */`, and add after `cycle`:

```ts
  /**
   * The current segment (lib/resets.ts): the stretch since the cycle's last
   * keep reset; the whole cycle while it has none, and for a closed cycle.
   * Every figure but the timeline counts it alone (`total`, `quota`, the
   * groups and machines, the sub-limits, `cost`), and the meter's ruler
   * covers it. It always ends with the cycle.
   */
  segment: { startMs: number; endMs: number; elapsedFraction: number; days: DaySpan[] };
  /** The cycle's resets up to now, oldest first: the restart it began with, then its keep resets; none for a closed cycle. */
  resets: DashboardReset[];
  /** groupId → colour, for every group on the timeline: one that used tokens only before a keep reset is charted, but not among `groups`. */
  groupColors: Record<string, string>;
```

`ProviderDashboardModel` gains, after `label`:

```ts
  /** How the provider resets a user's usage early (lib/settings.ts `resetModeOf`): what a reset recorded on the dashboard is. */
  resetMode: ResetMode;
```

`ProviderStoreSnapshot` gains:

```ts
  /** Every provider's resets, as `loadIndexes` read them (lib/usage-store.ts). */
  resets?: Record<string, ProviderResets>;
```

Replace the doc of `CycleWindow` with:

```ts
/**
 * The cycle on screen, with the cycle before it (the footer's comparison,
 * counter mode's baseline), taken as given rather than worked out from the
 * reset settings: a past one opened from the previous cycles, or the
 * current one with a previous cycle that knows of a restart
 * (lib/provider-cycles.ts `providerCycle`).
 */
```

Add after `healthOf`:

```ts
/** How far `nowMs` is into `span`, 0–1. */
function fractionOf(nowMs: number, span: TimeWindow): number {
  return Math.min(1, Math.max(0, (nowMs - span.startMs) / (span.endMs - span.startMs)));
}

/** The days of `span`, as fractions of it. */
function daySpans(span: Cycle, timeZone: string): DaySpan[] {
  const startMs = span.start.getTime();
  const lengthMs = span.end.getTime() - startMs;
  return getDaySegments(span, timeZone).map((day) => ({
    startFraction: (day.start.getTime() - startMs) / lengthMs,
    endFraction: (day.end.getTime() - startMs) / lengthMs,
    weekday: day.weekday,
    monthDay: day.monthDay,
  }));
}

function dashboardReset(event: ResetEvent, tokens: number | null): DashboardReset {
  return { id: event.id, atMs: event.atMs, kind: event.kind, before: event.before, source: event.source, tokens };
}
```

Replace `buildDashboard` (keep its doc comment; append to it: "The provider's keep resets (`snapshot.resets`)
split an open cycle into segments: see `DashboardModel.segment`.") with:

```ts
export function buildDashboard(
  now: Date,
  config: AppConfig,
  snapshot: StoreSnapshot,
  subLimits: SubLimit[] = [],
  window?: CycleWindow,
): DashboardModel {
  const nowMs = now.getTime();
  const cycle = window?.cycle ?? getCycle(now, config.reset);
  const previousCycle = window?.previous ?? getPreviousCycle(cycle, config.reset);
  const startMs = cycle.start.getTime();
  const endMs = cycle.end.getTime();
  const closed = endMs <= nowMs;
  const cycleWindow = { startMs, endMs };

  // A closed cycle counts whole: adding its segments up is the past-cycle views' job.
  const resetEvents = closed ? [] : (snapshot.resets ?? []);
  const keepResets = keepResetsOf(cycleWindow, resetEvents).filter((reset) => reset.atMs <= nowMs);
  const restart = restartStarting(resetEvents, startMs);
  const resetsMs = keepResets.map((reset) => reset.atMs);
  const segmentStartMs = resetsMs.at(-1) ?? startMs;

  const split = splitBySubLimits(snapshot.events, subLimits);
  const current = summarizeUsage(split.main, cycleWindow, config.tokenMode, segmentStartMs);
  const previous = summarizeUsage(
    split.main,
    { startMs: previousCycle.start.getTime(), endMs: startMs },
    config.tokenMode,
  );
  // The timeline charts the whole cycle: a group that used tokens only before a reset keeps its line.
  const whole = keepResets.length === 0 ? current : summarizeUsage(split.main, cycleWindow, config.tokenMode);
  const chartedIds = [...new Set([...current.groups, ...whole.groups].map((group) => group.groupId))];

  const limit = config.useTokenLimits ? config.limit : null;
  const limitShareOf = (tokens: number) => (limit === null ? null : tokens / limit);
  const colorOf = resolveGroupColors(snapshot.groups, chartedIds);
```

…then keep the `machines` and `silent` code exactly as it is, and continue with:

```ts
  const timeline = buildTimeline(
    split.main,
    chartedIds,
    cycleWindow,
    nowMs,
    config.tokenMode,
    snapshot.events,
    resetsMs,
  );

  // The clients price every report; the page shows it only with the settings' cost estimate on.
  const costSummary = config.costEstimate ? summarizeCost(split.main, cycleWindow, segmentStartMs) : null;
```

…keep the `cost` block as it is, and replace the returned object with:

```ts
  return {
    generatedAt: nowMs,
    closed,
    tokenMode: config.tokenMode,
    timeZone: config.reset.timeZone,
    period: config.reset.period,
    showRemaining: config.showRemaining,
    total: current.total,
    quota: limit === null ? null : assessQuota(current.total, limit, { startMs: segmentStartMs, endMs, nowMs }),
    previousTotal: previous.total,
    cycle: {
      startMs,
      endMs,
      elapsedFraction: fractionOf(nowMs, cycleWindow),
      segments: daySpans(cycle, config.reset.timeZone),
    },
    segment: {
      startMs: segmentStartMs,
      endMs,
      elapsedFraction: fractionOf(nowMs, { startMs: segmentStartMs, endMs }),
      days: daySpans({ start: new Date(segmentStartMs), end: cycle.end }, config.reset.timeZone),
    },
    resets: [
      ...(restart ? [dashboardReset(restart, null)] : []),
      ...keepResets.map((reset, index) =>
        dashboardReset(
          reset,
          summarizeUsage(split.main, { startMs, endMs: reset.atMs }, config.tokenMode, resetsMs[index - 1] ?? startMs)
            .total,
        ),
      ),
    ],
    groups: current.groups.map((g) => ({
      groupId: g.groupId,
      tokens: g.tokens,
      share: g.share,
      limitShare: limitShareOf(g.tokens),
      machines: g.machines,
      color: colorOf.get(g.groupId) ?? NEUTRAL_COLOR,
    })),
    groupColors: Object.fromEntries(chartedIds.map((groupId) => [groupId, colorOf.get(groupId) ?? NEUTRAL_COLOR])),
    // Each model's cost is left out with the rest, so the model chart names none either.
    timeline: config.costEstimate
      ? timeline
      : { ...timeline, models: timeline.models.map(({ cost: _cost, ...model }) => model) },
    ...(cost && { cost }),
    subLimits: measureSubLimits(
      subLimits,
      split.bySubLimit,
      { startMs, endMs, nowMs },
      timeline.times,
      config.tokenMode,
      limit,
      resetsMs,
    ),
    machines,
  };
}
```

(The old `lengthMs` constant is gone: `fractionOf` and `daySpans` replace its two uses.)

Replace the body of `buildProviderDashboards`' `map` callback with:

```ts
  return visibleProviderIds(config, providerIds).map((providerId) => {
    const counts = (groupId: string) => countsForProvider(config.excludedProviders, groupId, providerId);
    const subLimits = subLimitsOf(config, providerId);
    const resets = resetEventsOf(store.resets ?? {}, providerId);
    return {
      id: providerId,
      label: providerLabel(providerId),
      resetMode: resetModeOf(config, providerId),
      dashboard: buildDashboard(
        now,
        configForProvider(config, providerId),
        {
          events: (store.eventsByProvider[providerId] ?? []).filter((event) => counts(event.groupId)),
          // All of them: a group's colour must not depend on which provider is selected.
          groups: store.groups,
          machines: store.machines.filter((machine) => machine.providerId === providerId && counts(machine.groupId)),
          resets,
        },
        subLimits,
        // The current cycle's previous one is the cycle a restart cut short, when one began it.
        window ?? providerCycle(now, config, providerId, resets),
      ),
      officialEntry: officialUsage.get(officialUsageField(providerId, null)) ?? null,
      subLimitEntries: Object.fromEntries(
        subLimits.flatMap((sub) => {
          const entry = officialUsage.get(officialUsageField(providerId, sub.id));
          return entry ? [[sub.id, entry]] : [];
        }),
      ),
    };
  });
```

Run: `npx vitest run tests/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 3: The readers pass the resets in**

In `app/[locale]/(dashboard)/page.tsx`, the store (line 136) becomes:

```ts
  const store = { eventsByProvider, groups, machines: indexes.machines, resets: indexes.resets };
```

In `lib/status.ts` (`loadStatus`), the store argument becomes:

```ts
    { eventsByProvider, groups, machines: indexes.machines, resets: indexes.resets },
```

Append to `describe("GET /api/status after a keep reset", …)` in `tests/integration/status.test.ts`:

```ts
  it("counts the tokens since the reset only", async () => {
    // Running totals (snapshot mode): 3000 an hour before the reset, 5000 now, so 2000 since the reset.
    const before = new Date(R - 3_600_000);
    const stored = await ingestReport(
      { machineId: "mac", groupId: "Personal", providers: { claude: 3000 }, timestamp: before.toISOString() },
      before,
    );
    if (!stored.ok) throw new Error(JSON.stringify(stored));
    expect((await claudeOf())?.tokens).toBe(2000);
  });
```

Run: `npx vitest run tests/integration/status.test.ts`
Expected: PASS (it fails with 5000 without the `lib/status.ts` change).

- [ ] **Step 4: A typed figure is tagged with the segment**

In `components/dashboard-view.tsx`, replace the two hook calls' second argument `model.cycle.startMs`
(lines 61 and 76) with `model.segment.startMs`, and put this comment above `useOfficialEntry`:

```ts
  // A figure belongs to the segment it was typed in (lib/resets.ts): it clears itself at a reset. A closed
  // cycle's segment is the whole cycle, whose start keys its archived summary.
```

In `components/use-official-entry.ts`, add to the doc of `useOfficialEntry` (before the `closedAtMs`
paragraph):

```ts
 * `cycleStartMs` is what the figure is tagged with: the start of the current
 * segment (the cycle's, without a usage reset; lib/resets.ts), or a finished
 * cycle's own start.
 *
```

In `docs/api.md`, in `## PUT /api/official-usage`, replace
"`cycleStartMs` is the field's own cycle, from the dashboard it was typed on." with:

```markdown
`cycleStartMs` is the start of the field's own stretch of the cycle, from the dashboard it was typed on:
the cycle's start, or the latest usage reset's moment after one ([`/api/resets`](#postputdelete-apiresets)).
```

Append to `tests/components/dashboard-view.test.tsx` (add `act` to its `@testing-library/react` import and
`afterEach` to its `vitest` import):

```ts
describe("DashboardView — the official figure's tag", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("tags a typed figure with the start of the current segment", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, enteredAt: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date("2026-09-23T12:00:00Z");
    const store = { eventsByProvider: {}, groups: [], machines: [] };
    const cycleStartMs = buildProviderDashboards(now, getConfig({}), ["claude"], store)[0]!.dashboard.cycle.startMs;
    // Half way between the cycle's start and now, on a whole minute: whatever the default reset is.
    const R = cycleStartMs + Math.floor((now.getTime() - cycleStartMs) / 2 / 60_000) * 60_000;
    const [claude] = buildProviderDashboards(now, getConfig({}), ["claude"], {
      ...store,
      resets: {
        claude: {
          v: 1,
          events: [
            {
              id: "k",
              atMs: R,
              kind: "keep",
              cycleStartMs,
              before: 80,
              beforeAtMs: null,
              source: "manual",
              recordedAtMs: R,
            },
          ],
          autoOffCycleStartMs: null,
        },
      },
    });

    renderWithIntl(
      <DashboardView providers={[claude!]} historyByProvider={{}} historyContext={historyContext} pastCycle={false} />,
    );
    fireEvent.change(screen.getByLabelText("Current official consumption"), { target: { value: "12" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/official-usage");
    expect(JSON.parse(init.body as string)).toMatchObject({ providerId: "claude", raw: "12", cycleStartMs: R });
  });
});
```

Run: `npx vitest run tests/components/dashboard-view.test.tsx`
Expected: PASS (`cycleStartMs` would be the cycle's start without Step 4).

- [ ] **Step 5: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add lib/dashboard.ts "app/[locale]/(dashboard)/page.tsx" lib/status.ts components/dashboard-view.tsx components/use-official-entry.ts docs/api.md tests/dashboard.test.ts tests/integration/status.test.ts tests/components/dashboard-view.test.tsx
git commit -m "feat(resets): count the dashboard's current segment and tag typed figures with it"
```

### Task 3: The restatement and the pace over the segment

**Files:**
- Modify: `lib/ground-truth.ts` (`readingTime`, `applyGroundTruth`, `applySubLimitReading`, new `timelineRates`, module doc)
- Modify: `lib/recent-pace.ts` (`windowBins`, `recentPace`, module doc)
- Modify: `lib/group-machines.ts` (`groupMachineChart`)
- Test: `tests/ground-truth.test.ts`, `tests/recent-pace.test.ts`, `tests/group-machines.test.ts`

**Interfaces:**
- Consumes (Task 2): `DashboardModel.segment { startMs, endMs, elapsedFraction, days }`, `DashboardModel.resets: DashboardReset[]`
  (`tokens`: a keep reset's ended segment's measured tokens), `DashboardModel.timeline.times` (R − 1 and R sampled), `StoreSnapshot.resets`.
- Produces: `timelineRates(model: DashboardModel, view: DashboardView): number[] | null` in `lib/ground-truth.ts` —
  one rate per `model.timeline.times` sample: what one measured token is as a fraction of the budget.

- [ ] **Step 1: Write the failing tests**

In `tests/ground-truth.test.ts` change the import to
`import { applyGroundTruth, parseOfficialPercent, timelineRates } from "@/lib/ground-truth";`, add
`import type { ResetEvent } from "@/lib/resets";`, and append:

```ts
describe("applyGroundTruth — after a keep reset", () => {
  // Tuesday 14:00, 38 h into the cycle; 50k measured before it (Work 30k, Home 20k), 12k of Work's since.
  const R = CYCLE_START + 38 * HOUR;
  const keep = (before: number | null): ResetEvent => ({
    id: "k",
    atMs: R,
    kind: "keep",
    cycleStartMs: CYCLE_START,
    before,
    beforeAtMs: null,
    source: "manual",
    recordedAtMs: R,
  });
  const events = [report("win-1", "Work", 30_000, 10), report("mac", "Home", 20_000, 20), report("win-1", "Work", 12_000, 40)];
  const withReset = (before: number | null, limits = true) =>
    buildDashboard(NOW, { ...config, useTokenLimits: limits }, { events, groups: [], machines: [], resets: [keep(before)] });

  it("judges the pace from the reset, never from before it", () => {
    const model = withReset(80);
    const view = applyGroundTruth(model, { percent: 6, atMs: CYCLE_START + 20 * HOUR });
    expect(view.asOfMs).toBe(R);
    expect(view.quota!.pace.dailyShare).toBeCloseTo(24 / 130);
  });

  it("rates each finished segment at its own before-figure under an official reading", () => {
    const model = withReset(80);
    const rates = timelineRates(model, applyGroundTruth(model, { percent: 6, atMs: null }))!;
    const { times } = model.timeline;
    expect(rates).toHaveLength(times.length);
    expect(rates[times.indexOf(R - 1)]).toBeCloseTo(0.8 / 50_000);
    expect(rates[times.indexOf(R)]).toBeCloseTo(0.06 / 12_000);
    expect(rates.at(-1)).toBeCloseTo(0.06 / 12_000);
  });

  it("rates every sample at the token limit's rate without an official reading", () => {
    const model = withReset(80);
    const rates = timelineRates(model, applyGroundTruth(model, null))!;
    for (const rate of rates) expect(rate).toBeCloseTo(1 / 500_000);
  });

  it("rates a finished segment with no known before-figure at the current rate", () => {
    const model = withReset(null);
    const rates = timelineRates(model, applyGroundTruth(model, { percent: 6, atMs: null }))!;
    expect(rates[model.timeline.times.indexOf(R - 1)]).toBeCloseTo(0.06 / 12_000);
  });

  it("has no rates while nothing tells how much of the budget is gone", () => {
    const model = withReset(80, false);
    expect(timelineRates(model, applyGroundTruth(model, null))).toBeNull();
  });
});
```

In `tests/recent-pace.test.ts` add `import type { ResetEvent } from "@/lib/resets";` and append:

```ts
describe("recentPace — after a keep reset", () => {
  it("never looks back past the reset, and compares with the segment's own average", () => {
    const reset: ResetEvent = {
      id: "k",
      atMs: at(55),
      kind: "keep",
      cycleStartMs: CYCLE_START,
      before: 40,
      beforeAtMs: null,
      source: "manual",
      recordedAtMs: at(55),
    };
    const model = buildDashboard(new Date(at(60)), config, { events: BURST, groups: [], machines: [], resets: [reset] });
    const recent = recentPace(model, applyGroundTruth(model, null));
    // Since the reset: 5k at 55, 56, 57 and 58, then 40k at 59 and 60 — 100k in 5 hours.
    expect(recent).not.toBeNull();
    expect(recent!.sinceMs).toBe(at(58));
    // 40k an hour since 58:00 against the segment's 20k an hour.
    expect(recent!.ratio).toBeCloseTo(2);
  });
});
```

In `tests/group-machines.test.ts` add `import type { ResetEvent } from "@/lib/resets";` and append:

```ts
describe("groupMachineChart — after a keep reset", () => {
  it("scales a machine's stretch before the reset by that reset's before-figure", () => {
    const R = CYCLE_START + 38 * HOUR;
    const reset: ResetEvent = {
      id: "k",
      atMs: R,
      kind: "keep",
      cycleStartMs: CYCLE_START,
      before: 80,
      beforeAtMs: null,
      source: "manual",
      recordedAtMs: R,
    };
    const withReset = buildDashboard(NOW, config, {
      events: [report("win-1", "Work", 30_000, 10), report("mac", "Home", 20_000, 20), report("win-1", "Work", 12_000, 40)],
      groups: [],
      machines: [],
      resets: [reset],
    });
    const view = applyGroundTruth(withReset, { percent: 6, atMs: null });
    const { series } = groupMachineChart(withReset, view, groupOf(view.groups, "Work"));
    const values = series.find((row) => row.machine.machineId === "win-1")!.values;
    // 30k of the 50k measured before the reset, at its 80%; then 12k of 12k at 6%.
    expect(values[withReset.timeline.times.indexOf(R - 1)]).toBeCloseTo(0.48);
    expect(values.at(-1)).toBeCloseTo(0.06);
  });
});
```

Run: `npx vitest run tests/ground-truth.test.ts tests/recent-pace.test.ts tests/group-machines.test.ts`
Expected: FAIL — `timelineRates` is not exported; `asOfMs` is the reading's own time; the recent pace starts at 54:00.

- [ ] **Step 2: The restatement over the segment, and the timeline's rates**

In `lib/ground-truth.ts`, add to the module doc comment (before "Runs in the browser"):

```ts
 * Everything counts the current segment (lib/dashboard.ts `segment`): after a
 * keep reset, the official percentage is the one since that reset.
 *
```

Replace `readingTime` with:

```ts
/** A reading taken hours ago says how fast the budget went until then, not until now; never before its segment began. */
function readingTime(model: DashboardModel, reading: OfficialReading): number {
  return Math.min(model.generatedAt, Math.max(model.segment.startMs, reading.atMs ?? model.generatedAt));
}
```

In `applyGroundTruth`, the calibrated quota becomes:

```ts
    quota: assessQuota(officialTotal, limit, {
      startMs: model.segment.startMs,
      endMs: model.segment.endMs,
      nowMs: asOfMs,
    }),
```

In `applySubLimitReading`, `assess` becomes:

```ts
  const assess = (fraction: number, nowMs: number) =>
    assessQuota(fraction, 1, { startMs: model.segment.startMs, endMs: model.segment.endMs, nowMs });
```

Add after `applyGroundTruth`:

```ts
/**
 * What one measured token on the timeline (lib/timeline.ts) is as a fraction
 * of the budget, at each of its samples. The current segment's tokens go at
 * the headline figure over its measured tokens (1/limit without a reading).
 * Under an official reading, a finished segment's go at its own before-figure
 * over the tokens measured in it (lib/resets.ts); one whose figure is unknown
 * takes the current rate. Null while nothing tells how much of the budget is
 * gone: no token limit and no reading.
 */
export function timelineRates(model: DashboardModel, view: DashboardView): number[] | null {
  const { quota } = view;
  if (!quota) return null;
  // Right after a reset nothing is measured yet: the segment's samples are all 0, the limit's rate is as good as any.
  const current = model.total > 0 ? quota.usedFraction / model.total : view.inTokens ? 1 / quota.limit : 0;
  const keeps = model.resets.filter((reset) => reset.kind === "keep");
  return model.timeline.times.map((ms) => {
    // The reset that ends the segment this sample falls in; none in the current segment.
    const ending = keeps.find((reset) => reset.atMs > ms);
    if (!ending || !view.calibrated || ending.before === null || !ending.tokens) return current;
    return ending.before / 100 / ending.tokens;
  });
}
```

- [ ] **Step 3: The recent pace stays inside the segment**

In `lib/recent-pace.ts`, change the module doc's first sentence to
"The pace of the last few hours, next to the current segment's average (lib/quota.ts; the cycle's, without a
usage reset):", and replace `windowBins` with:

```ts
/**
 * The timeline's tokens between its hourly samples, from 8 hours before
 * `untilMs` (not before the segment) up to `untilMs`. Nothing came in after
 * the newest report, so the timeline's last value is the total at `untilMs`.
 * The hourly grid is the cycle's; a segment begun off it starts with its own
 * first sample, the reset (lib/timeline.ts `withResetSamples`).
 */
function windowBins(model: DashboardModel, untilMs: number): Bin[] {
  const { times, groups } = model.timeline;
  const gridStartMs = model.cycle.startMs;
  const segmentStartMs = model.segment.startMs;
  const fromMs = Math.max(segmentStartMs, untilMs - RECENT_WINDOW_MS);
  const totalAt = (index: number) => groups.reduce((sum, group) => sum + group.values[index]!, 0);

  // The last sample is the dashboard's own moment: on the hourly grid only by chance.
  const points: { ms: number; tokens: number }[] = [];
  times.forEach((ms, index) => {
    const onGrid = (ms - gridStartMs) % HOUR === 0 || ms === segmentStartMs;
    if (ms >= fromMs && ms < untilMs && onGrid) points.push({ ms, tokens: totalAt(index) });
  });
  points.push({ ms: untilMs, tokens: totalAt(times.length - 1) });

  const bins = points.slice(1).map((point, index) => ({
    startMs: points[index]!.ms,
    endMs: point.ms,
    tokens: point.tokens - points[index]!.tokens,
  }));
  const tail = bins.at(-1);
  if (tail && bins.length > 1 && tail.endMs - tail.startMs < MIN_TAIL_MS) {
    bins.pop();
    const previous = bins.pop()!;
    bins.push({ startMs: previous.startMs, endMs: tail.endMs, tokens: previous.tokens + tail.tokens });
  }
  return bins;
}
```

In `recentPace`, `const elapsedMs = view.asOfMs - model.cycle.startMs;` becomes
`const elapsedMs = view.asOfMs - model.segment.startMs;`.

- [ ] **Step 4: The group-machine chart scales each segment on its own**

In `lib/group-machines.ts`, change the import to
`import { type DashboardView, timelineRates } from "@/lib/ground-truth";`, and in `groupMachineChart`
replace the `fractionPerToken` line and the returned object with:

```ts
  // Per measured token at each sample: a finished segment may go at its own before-figure (lib/ground-truth.ts).
  const rates = timelineRates(model, view);
  return {
    basis: rates === null ? "tokens" : view.calibrated ? "official" : "measured",
    series: machines.map((machine, index) => {
      const measured = model.timeline.machines.find(
        (series) => series.groupId === group.groupId && series.machineId === machine.machineId,
      );
      return {
        machine,
        color: colors[index]!,
        values: model.timeline.times.map((_, sample) => (measured?.values[sample] ?? 0) * (rates?.[sample] ?? 1)),
      };
    }),
  };
```

and change the function's doc comment's second sentence to "Their measured tokens become a share of the
budget at the rates the usage chart uses (lib/ground-truth.ts `timelineRates`), so the machines of all groups
add up to the headline percentage, and every line ends on its machine's share of the budget."

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/ground-truth.test.ts tests/recent-pace.test.ts tests/group-machines.test.ts tests/sub-limits.test.ts`
Expected: PASS.

- [ ] **Step 6: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add lib/ground-truth.ts lib/recent-pace.ts lib/group-machines.ts tests/ground-truth.test.ts tests/recent-pace.test.ts tests/group-machines.test.ts
git commit -m "feat(resets): restate, pace and chart the official figure by segment"
```

### Task 4: The meter over the segment, and the reset line

**Files:**
- Modify: `components/cycle-ruler.tsx` (whole file)
- Modify: `components/cycle-chart.tsx:482` (the ruler under the chart)
- Modify: `components/quota-meter.tsx`
- Modify: `messages/en.json`, `messages/hu.json`, `messages/de.json` (`Widgets`)
- Test: `tests/components/quota-meter.test.tsx`

**Interfaces:**
- Consumes (Task 2): `DaySpan`, `DashboardModel.segment`, `DashboardModel.cycle.segments: DaySpan[]`, `DashboardModel.resets`.
- Produces: `RulerSpan { elapsedFraction: number; days: DaySpan[] }` and `CycleRuler({ model, span })` in
  `components/cycle-ruler.tsx`; `model.segment` is a `RulerSpan` as it stands.

- [ ] **Step 1: Write the failing tests**

Append to `tests/components/quota-meter.test.tsx` (add `import type { ResetEvent } from "@/lib/resets";`):

```ts
describe("QuotaMeter — after a keep reset", () => {
  // Fixed to Budapest time, independent of DEFAULT_RESET's own (deploy-time) default.
  const config = {
    ...getConfig({}),
    useTokenLimits: true,
    limit: 500_000,
    tokenMode: "delta" as const,
    reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
  };
  const keep = (hoursIntoCycle: number, before: number | null): ResetEvent => {
    const atMs = CYCLE_START + hoursIntoCycle * HOUR;
    return {
      id: `k${hoursIntoCycle}`,
      atMs,
      kind: "keep",
      cycleStartMs: CYCLE_START,
      before,
      beforeAtMs: null,
      source: "manual",
      recordedAtMs: atMs,
    };
  };
  const events = [
    { machineId: "win-1", groupId: "Work", tokens: 300_000, ts: CYCLE_START + 10 * HOUR },
    { machineId: "win-1", groupId: "Work", tokens: 20_000, ts: CYCLE_START + 40 * HOUR },
  ];

  it("states the reset, the figure before it and the week's total under the main figure", () => {
    const model = buildDashboard(NOW, config, snapshot({ events, resets: [keep(38, 80)] }));
    renderWithIntl(<QuotaMeter model={model} view={applyGroundTruth(model, { percent: 20, atMs: null })} />);
    expect(screen.getByText(/^Reset .+ · before it 80% · this week in total 100%$/)).toBeDefined();
  });

  it("shows an unknown figure as a dash and leaves it out of the total", () => {
    const model = buildDashboard(NOW, config, snapshot({ events, resets: [keep(20, null), keep(38, 80)] }));
    renderWithIntl(<QuotaMeter model={model} view={applyGroundTruth(model, { percent: 20, atMs: null })} />);
    expect(
      screen.getByText(/^Reset .+ · before it – · Reset .+ · before it 80% · this week in total 100%$/),
    ).toBeDefined();
  });

  it("lays the meter's ruler and its now marker over the segment", () => {
    const model = buildDashboard(NOW, config, snapshot({ events, resets: [keep(38, 80)] }));
    renderWithIntl(<QuotaMeter model={model} view={applyGroundTruth(model, null)} />);
    // 22 of the segment's 130 hours have passed; the text still tells the cycle's 60 of 168.
    expect(Number.parseFloat(screen.getByText("now").style.left)).toBeCloseTo((22 / 130) * 100);
    expect(screen.getByText(/36% of the cycle has elapsed/)).toBeDefined();
  });

  it("has no reset line without a keep reset", () => {
    const model = buildDashboard(NOW, config, snapshot({ events }));
    renderWithIntl(<QuotaMeter model={model} view={applyGroundTruth(model, null)} />);
    expect(screen.queryByText(/in total/)).toBeNull();
  });
});
```

Run: `npx vitest run tests/components/quota-meter.test.tsx`
Expected: FAIL — no reset line; the now marker sits at the cycle's 35.7%.

- [ ] **Step 2: The ruler takes the stretch it lays out**

Replace `components/cycle-ruler.tsx` with:

```tsx
import { useLocale } from "next-intl";
import type { DashboardModel, DaySpan } from "@/lib/dashboard";
import { formatMonthDay, weekdayShort } from "@/lib/format";

/** What a ruler lays out: the days of a stretch of time, and how far into it now is. */
export interface RulerSpan {
  elapsedFraction: number;
  days: DaySpan[];
}

/**
 * The text under one day of the ruler. A week names every day that has the
 * room. A month does not have it: today, the 1st and every fifth day are
 * named, minus the ones that would run into today's.
 */
function rulerLabel(model: DashboardModel, day: DaySpan, index: number, todayIndex: number, locale: string): string | null {
  const width = day.endFraction - day.startFraction;
  if (model.period === "weekly") return width >= 0.07 ? weekdayShort(day.weekday, locale) : null;

  if (width < 0.02) return null;
  const isLandmark = day.monthDay === 1 || day.monthDay % 5 === 0;
  const named = index === todayIndex || (isLandmark && Math.abs(index - todayIndex) !== 1);
  return named ? formatMonthDay(day.monthDay, locale) : null;
}

/**
 * The days of `span`, left to right across the full width: the current
 * segment under the meter (lib/dashboard.ts `segment`), the whole cycle under
 * the charts.
 */
export function CycleRuler({ model, span }: { model: DashboardModel; span: RulerSpan }) {
  const locale = useLocale();
  const nowFraction = span.elapsedFraction;
  const todayIndex = span.days.findIndex((day) => nowFraction >= day.startFraction && nowFraction < day.endFraction);

  return (
    <div aria-hidden="true" className="relative mt-2 h-7">
      {span.days.map((day, index) => {
        const label = rulerLabel(model, day, index, todayIndex, locale);
        return (
          <div
            key={day.startFraction}
            className="absolute top-0 h-full"
            style={{
              left: `${day.startFraction * 100}%`,
              width: `${(day.endFraction - day.startFraction) * 100}%`,
            }}
          >
            {index > 0 && <span className="absolute left-0 top-0 h-2 w-px bg-rule" />}
            {label && (
              <span
                className={`absolute left-1/2 top-2.5 -translate-x-1/2 whitespace-nowrap text-xs ${index === todayIndex ? "text-ink" : "text-ink-3"}`}
              >
                {label}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

In `components/cycle-chart.tsx`, the ruler under an unzoomed chart (line 482) becomes:

```tsx
      {zoomed ? (
        <ZoomAxis zoomWindow={zoomWindow} width={width} model={model} />
      ) : (
        <CycleRuler model={model} span={{ elapsedFraction: model.cycle.elapsedFraction, days: model.cycle.segments }} />
      )}
```

- [ ] **Step 3: The meter over the segment, and its reset line**

Add the messages (run from the worktree root):

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const add = {
  en: {
    reset_line_item: "Reset {moment} · before it {before}",
    reset_line_total: "this {period, select, monthly {month} other {week}} in total {total}",
  },
  hu: {
    reset_line_item: "Reset: {moment} · előtte {before}",
    reset_line_total: "{period, select, monthly {a hónapban} other {a héten}} összesen {total}",
  },
  de: {
    reset_line_item: "Reset {moment} · davor {before}",
    reset_line_total: "{period, select, monthly {diesen Monat} other {diese Woche}} insgesamt {total}",
  },
};
for (const [locale, keys] of Object.entries(add)) {
  const path = `messages/${locale}.json`;
  const messages = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(messages.Widgets, keys);
  writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`);
}
EOF
```

In `components/quota-meter.tsx`:

No new import is needed (`formatPercent`, `QuotaAssessment`, `DashboardModel` and `formatMoment` are
already there). Add after `recentPaceSentence`:

```tsx
/**
 * Under the main figure, once the cycle has keep resets: when each one was
 * and the figure right before it, then the cycle's total — those figures and
 * the current one added up. An unknown figure is a dash, left out of the
 * total; a restart's belongs to the previous cycle and is not listed here.
 */
function ResetLine({ model, quota }: { model: DashboardModel; quota: QuotaAssessment | null }) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const keeps = model.resets.filter((reset) => reset.kind === "keep");
  if (keeps.length === 0) return null;
  const parts = keeps.map((reset) =>
    t("reset_line_item", {
      moment: formatMoment(reset.atMs, model, locale),
      before: reset.before === null ? "–" : formatPercent(reset.before / 100, locale),
    }),
  );
  if (quota) {
    const total = keeps.reduce((sum, reset) => sum + (reset.before ?? 0) / 100, quota.usedFraction);
    parts.push(t("reset_line_total", { period: model.period, total: formatPercent(total, locale) }));
  }
  return <p className="mt-3 text-sm text-ink-3">{parts.join(" · ")}</p>;
}
```

In `QuotaMeter`:
- change its doc comment's first sentence to "The page's one gauge: usage against the limit, laid over the
  current segment (the whole cycle without a usage reset)."
- `const nowFraction = model.cycle.elapsedFraction;` becomes `const nowFraction = model.segment.elapsedFraction;`
- `const elapsedNote = t("cycle_elapsed", { percent: formatPercent(nowFraction, locale) });` becomes
  `const elapsedNote = t("cycle_elapsed", { percent: formatPercent(model.cycle.elapsedFraction, locale) });`
- right after the closing `</h1>`, add `<ResetLine model={model} quota={quota} />`
- `<CycleRuler model={model} />` becomes `<CycleRuler model={model} span={model.segment} />`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/components/quota-meter.test.tsx tests/components/cycle-chart.test.tsx tests/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add components/cycle-ruler.tsx components/cycle-chart.tsx components/quota-meter.tsx messages/en.json messages/hu.json messages/de.json tests/components/quota-meter.test.tsx
git commit -m "feat(resets): lay the meter over the segment and state the resets under it"
```

### Task 5: The charts mark the resets and scale each segment

**Files:**
- Modify: `components/cycle-chart.tsx` (props, reset markers, veils)
- Modify: `components/usage-chart.tsx` (whole component)
- Modify: `components/model-chart.tsx:26` (group colours)
- Modify: `messages/en.json`, `messages/hu.json`, `messages/de.json` (`Widgets`)
- Test: `tests/components/cycle-chart.test.tsx`, `tests/components/usage-chart.test.tsx` (new)

**Interfaces:**
- Consumes: `DashboardModel.resets`, `DashboardModel.groupColors` (Task 2); `timelineRates(model, view)` (Task 3);
  `TimeSpan` from `lib/chart.ts`.
- Produces: `CycleChart` takes `paleSpans?: TimeSpan[]`; it draws a marker at each keep reset of `model.resets`
  by itself (every chart built on it: usage, models, a group's machines).

- [ ] **Step 1: Write the failing tests**

Append to `tests/components/cycle-chart.test.tsx` (add `import type { TimeSpan } from "@/lib/chart";`):

```tsx
describe("CycleChart — resets", () => {
  // Whatever the default reset is: the cycle's start, and half way from it to now on a whole minute.
  const S = buildDashboard(NOW, getConfig({}), snapshot({})).cycle.startMs;
  const R = S + Math.floor((NOW.getTime() - S) / 2 / 60_000) * 60_000;
  const model = buildDashboard(
    NOW,
    getConfig({}),
    snapshot({
      events: [
        { machineId: "win-1", groupId: "Work", tokens: 1_000, ts: S + HOUR },
        { machineId: "win-1", groupId: "Work", tokens: 500, ts: R + HOUR },
      ],
      resets: [
        { id: "k", atMs: R, kind: "keep", cycleStartMs: S, before: null, beforeAtMs: null, source: "manual", recordedAtMs: R },
      ],
    }),
  );
  const series: ChartSeries[] = [
    { id: "total", label: "Total", color: "#fff", values: model.timeline.times.map(() => 0) },
  ];
  const renderChart = (paleSpans?: TimeSpan[]) =>
    renderWithIntl(
      <CycleChart
        model={model}
        series={series}
        minAxis={1}
        formatTick={(value) => String(value)}
        formatValue={(value) => String(value)}
        label="Usage"
        {...(paleSpans && { paleSpans })}
      />,
    );

  it("marks a keep reset with a labelled line", () => {
    renderChart();
    expect(screen.getByText("reset")).toBeDefined();
    expect(document.querySelectorAll("[data-reset-marker]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(0);
  });

  it("veils the stretches it is given", () => {
    renderChart([{ startMs: S, endMs: R }]);
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(1);
  });
});
```

Create `tests/components/usage-chart.test.tsx`:

```tsx
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageChart } from "@/components/usage-chart";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import { applyGroundTruth } from "@/lib/ground-truth";
import type { ResetEvent } from "@/lib/resets";
import { renderWithIntl } from "../helpers/render";

const HOUR = 3_600_000;
const NOW = new Date("2026-09-23T10:00:00Z");
const config = { ...getConfig({}), useTokenLimits: true, limit: 500_000, tokenMode: "delta" as const };
// Whatever the default reset is: the cycle's start, and half way from it to now on a whole minute.
const S = buildDashboard(NOW, config, { events: [], groups: [], machines: [] }).cycle.startMs;
const R = S + Math.floor((NOW.getTime() - S) / 2 / 60_000) * 60_000;

/** Work's 30k and Home's 20k before the reset, Work's 12k since. */
function modelWith(before: number | null) {
  const reset: ResetEvent = {
    id: "k",
    atMs: R,
    kind: "keep",
    cycleStartMs: S,
    before,
    beforeAtMs: null,
    source: "manual",
    recordedAtMs: R,
  };
  return buildDashboard(NOW, config, {
    events: [
      { machineId: "win-1", groupId: "Work", tokens: 30_000, ts: S + HOUR },
      { machineId: "mac", groupId: "Home", tokens: 20_000, ts: S + 2 * HOUR },
      { machineId: "win-1", groupId: "Work", tokens: 12_000, ts: R + HOUR },
    ],
    groups: [],
    machines: [],
    resets: [reset],
  });
}

describe("UsageChart — after a keep reset", () => {
  it("fades a finished segment that has no figure of its own under an official reading", () => {
    const model = modelWith(null);
    renderWithIntl(<UsageChart model={model} view={applyGroundTruth(model, { percent: 6, atMs: null })} subLimits={[]} />);
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(1);
    expect(screen.getByText(/an estimate at the current rate/)).toBeDefined();
  });

  it("draws every segment plainly when each has its figure, and says the lines restart", () => {
    const model = modelWith(80);
    renderWithIntl(<UsageChart model={model} view={applyGroundTruth(model, { percent: 6, atMs: null })} subLimits={[]} />);
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(0);
    expect(screen.getByText(/every line starts again from 0/)).toBeDefined();
  });

  it("charts the group that used tokens only before the reset", () => {
    const model = modelWith(80);
    renderWithIntl(<UsageChart model={model} view={applyGroundTruth(model, null)} subLimits={[]} />);
    expect(screen.getAllByText("Home").length).toBeGreaterThan(0);
  });
});
```

Run: `npx vitest run tests/components/cycle-chart.test.tsx tests/components/usage-chart.test.tsx`
Expected: FAIL — no marker, no veil, no "every line starts again" sentence.

- [ ] **Step 2: Markers and veils in `CycleChart`**

Add the messages:

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const add = {
  en: {
    chart_reset_marker: "reset",
    chart_desc_resets: " At a reset every line starts again from 0.",
    chart_desc_pale: " A faded stretch is an estimate at the current rate: no official figure from right before its reset is known.",
  },
  hu: {
    chart_reset_marker: "reset",
    chart_desc_resets: " Reset után minden vonal újra 0-ról indul.",
    chart_desc_pale: " A halvány szakasz becslés a mostani arányban: nem ismert a resete előtti hivatalos érték.",
  },
  de: {
    chart_reset_marker: "Reset",
    chart_desc_resets: " Nach einem Reset beginnt jede Linie wieder bei 0.",
    chart_desc_pale: " Ein blasser Abschnitt ist eine Schätzung zum aktuellen Verhältnis: Der offizielle Wert direkt vor seinem Reset ist nicht bekannt.",
  },
};
for (const [locale, keys] of Object.entries(add)) {
  const path = `messages/${locale}.json`;
  const messages = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(messages.Widgets, keys);
  writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`);
}
EOF
```

In `components/cycle-chart.tsx`:

`CycleChartProps` gains, after `label`:

```ts
  /** Stretches drawn faded, under a veil: lines there are only an estimate (components/usage-chart.tsx). */
  paleSpans?: TimeSpan[];
```

Add `paleSpans = []` to the destructured props of `CycleChart`, and extend its doc comment with: "A keep
reset of the cycle (lib/resets.ts) is marked with a labelled vertical line: the lines start again from 0
there (lib/timeline.ts)."

After the `pathOf` definition add:

```ts
  // The cycle's keep resets inside the window: every line restarts from 0 at each.
  const resetMarks = model.resets
    .filter((reset) => reset.kind === "keep" && reset.atMs >= zoomWindow.startMs && reset.atMs <= zoomWindow.endMs)
    .map((reset) => reset.atMs);
```

Inside the clipped group, after the series paths (still inside `<g clipPath=…>`), add:

```tsx
              {paleSpans.map((span) => (
                <rect
                  key={span.startMs}
                  data-pale=""
                  x={xOf(span.startMs)}
                  y={PAD_TOP}
                  width={Math.max(0, xOf(span.endMs) - xOf(span.startMs))}
                  height={Math.max(0, height - PAD_TOP)}
                  fill="var(--color-page)"
                  opacity={0.6}
                />
              ))}
```

Right after the closing `</g>` of the clipped group, add:

```tsx
            {resetMarks.map((atMs) => (
              <line
                key={atMs}
                data-reset-marker=""
                x1={Math.round(xOf(atMs)) + 0.5}
                x2={Math.round(xOf(atMs)) + 0.5}
                y1={PAD_TOP}
                y2={height}
                stroke="var(--color-ink-3)"
                strokeDasharray="2 3"
              />
            ))}
```

After the block that renders the value-axis tick labels (`{size && scale.ticks.map(…)}`), add:

```tsx
        {size &&
          resetMarks.map((atMs) => (
            <span
              key={atMs}
              aria-hidden="true"
              className="absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-sm bg-page px-1 text-xs leading-none text-ink-3"
              style={{ left: xOf(atMs) }}
            >
              {t("chart_reset_marker")}
            </span>
          ))}
```

- [ ] **Step 3: The usage chart scales each segment, and the model chart colours every group**

Replace `UsageChart` in `components/usage-chart.tsx` (its doc comment too; keep `MIN_AXIS_FRACTION` and
`subLimitColor`), and change the `@/lib/ground-truth` import to
`import { type DashboardView, type SubLimitView, subLimitTimeline, timelineRates } from "@/lib/ground-truth";`:

```tsx
/**
 * How the budget went over the cycle: each group's share of it and, dashed,
 * all of them together. The measured tokens become a share of the budget at
 * the rates of lib/ground-truth.ts `timelineRates`: the current segment's at
 * the headline figure over its measured tokens, so the dashed line ends on
 * the headline percentage and the groups split it as their tokens do; a
 * segment a keep reset ended at that reset's own figure, every line starting
 * again from 0 at the reset. Each sub-limit whose figure is known runs beside
 * them in a fainter shade, as the share of its own budget: the same rule,
 * ending on its own figure.
 */
export function UsageChart({
  model,
  view,
  subLimits,
}: {
  model: DashboardModel;
  view: DashboardView;
  subLimits: SubLimitView[];
}) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const rates = timelineRates(model, view);
  const colorOf = new Map(Object.entries(model.groupColors));
  const keeps = model.resets.filter((reset) => reset.kind === "keep");
  // Under an official reading, a finished segment without a figure of its own is only an estimate at the current rate.
  const paleSpans = view.calibrated
    ? keeps.flatMap((reset, index) =>
        reset.before === null ? [{ startMs: keeps[index - 1]?.atMs ?? model.cycle.startMs, endMs: reset.atMs }] : [],
      )
    : [];
  // Right after a reset the segment has nothing measured yet, but the cycle has.
  const measured = model.total > 0 || keeps.some((reset) => (reset.tokens ?? 0) > 0);

  const subLimitSeries: ChartSeries[] = subLimits.flatMap((subView, index) => {
    const values = subLimitTimeline(subView);
    return values
      ? [
          {
            id: `sub:${subView.sub.id}`,
            label: t("sublimit_label", { name: subView.sub.name }),
            color: subLimitColor(index),
            values,
            faint: true,
          },
        ]
      : [];
  });

  let body: React.ReactNode;
  if (!measured) {
    body = <p className="mt-3 max-w-xl text-ink-2">{t("no_measured_usage_chart")}</p>;
  } else if (rates === null) {
    body = (
      <p className="mt-3 max-w-xl text-ink-2">
        {model.closed ? t("chart_closed_no_official") : t("chart_official_explanation")}
      </p>
    );
  } else {
    const groups: ChartSeries[] = model.timeline.groups.map((group) => ({
      id: `group:${group.groupId}`,
      label: group.groupId,
      color: colorOf.get(group.groupId) ?? NEUTRAL_COLOR,
      values: group.values.map((tokens, index) => tokens * rates[index]!),
    }));
    const total: ChartSeries = {
      id: "total",
      label: t("total"),
      color: "var(--color-ink)",
      values: model.timeline.times.map((_, index) => groups.reduce((sum, group) => sum + group.values[index]!, 0)),
      dashed: true,
    };
    // Drawn in reverse: the sub-limits' fainter lines lie beneath the groups'.
    const series = [total, ...groups, ...subLimitSeries];

    body = (
      <>
        <div className="mt-4">
          <ChartLegend series={series} />
        </div>
        <div className="mt-5">
          <CycleChart
            model={model}
            series={series}
            minAxis={MIN_AXIS_FRACTION}
            formatTick={(fraction, scale) => formatPercentTick(fraction, scale.step, locale)}
            formatValue={(val) => formatHeroPercent(val, locale)}
            label={subLimitSeries.length > 0 ? t("chart_aria_with_sublimits") : t("chart_aria_no_sublimits")}
            paleSpans={paleSpans}
          />
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="usage-chart-heading">
      <h2 id="usage-chart-heading" className="text-xl font-medium">
        {t("burn_over_time")}
      </h2>
      {measured && rates !== null && (
        <p className="mt-1 text-sm text-ink-3">
          {view.calibrated ? t("chart_desc_official") : t("chart_desc_measured")}
          {subLimitSeries.length > 0 && t("chart_desc_sublimits")}
          {keeps.length > 0 && t("chart_desc_resets")}
          {paleSpans.length > 0 && t("chart_desc_pale")}
        </p>
      )}
      {body}
    </section>
  );
}
```

In `components/model-chart.tsx`, line 26 becomes:

```ts
  // Every charted group, also one that used tokens only before a reset (lib/dashboard.ts `groupColors`).
  const colorOf = new Map(Object.entries(model.groupColors));
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/components/ tests/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add components/cycle-chart.tsx components/usage-chart.tsx components/model-chart.tsx messages/en.json messages/hu.json messages/de.json tests/components/cycle-chart.test.tsx tests/components/usage-chart.test.tsx
git commit -m "feat(resets): mark resets on the charts and scale each segment by its own figure"
```

### Task 6: The reset panel

**Files:**
- Modify: `lib/cycle.ts` (two exports)
- Create: `components/reset-requests.ts`
- Create: `components/reset-panel.tsx`
- Modify: `components/dashboard-view.tsx` (render the panel)
- Modify: `messages/en.json`, `messages/hu.json`, `messages/de.json` (`Widgets`)
- Modify: `docs/configuration.md` (new "Usage resets" section; the official-percentage paragraph), `docs/api.md` (`/api/resets` links it)
- Test: `tests/cycle.test.ts`, `tests/components/reset-panel.test.tsx` (new)

**Interfaces:**
- Consumes: `/api/resets` (plan 1): `POST { providerId, atMs, before?, afterRaw? }`, `PUT { providerId, id, atMs?, before? }`,
  `DELETE { providerId, id, revert? }`; `200 { ok, events, cycle }`; `401`; `400`/`403` (`demo_read_only` too);
  `404 not_found`; `409 outside_cycle | duplicate_reset | has_later_resets | not_revertable`; `5xx`. Error bodies are
  `{ error: "<code>", … }` (`lib/api.ts` `apiError`). `atMs` must be a whole minute. `beforeFromRaw(raw)` and `MINUTE_MS`
  in `lib/resets.ts`. Task 2: `DashboardModel.resets`, `ProviderDashboardModel.resetMode`. `Entry { raw, enteredAt }`
  from `components/use-official-entry.ts`.
- Produces:
  - `wallClockInput(ms: number, timeZone: string): string` and `fromWallClockInput(value: string, timeZone: string): number | null` in `lib/cycle.ts`
  - `type ResetProblem`, `type ResetResult = { ok: true } | { ok: false; problem: ResetProblem }`,
    `sendReset(method: "POST" | "PUT" | "DELETE", body: Record<string, unknown>): Promise<ResetResult>` in `components/reset-requests.ts`
  - `ResetPanel({ providerId, providerLabel, model, resetMode, entry })` in `components/reset-panel.tsx`
  - Widgets keys `reset_problem_<ResetProblem | "invalid_moment" | "invalid_before">` (Task 7 reuses them)

- [ ] **Step 1: Write the failing tests**

In `tests/cycle.test.ts` add `fromWallClockInput, wallClockInput` to the `@/lib/cycle` import and append:

```ts
describe("the datetime-local field's wall clock", () => {
  it("writes a moment as the field's value in its zone, to the minute", () => {
    expect(wallClockInput(Date.parse("2026-09-22T12:05:30Z"), "Europe/Budapest")).toBe("2026-09-22T14:05");
  });

  it("reads the value back, dropping seconds", () => {
    expect(fromWallClockInput("2026-09-22T14:05", "Europe/Budapest")).toBe(Date.parse("2026-09-22T12:05:00Z"));
    expect(fromWallClockInput("2026-09-22T14:05:59", "Europe/Budapest")).toBe(Date.parse("2026-09-22T12:05:00Z"));
  });

  it("refuses anything else", () => {
    for (const value of ["", "2026-09-22", "2026-13-01T10:00", "2026-09-22T24:00", "22/09/2026 14:05"]) {
      expect(fromWallClockInput(value, "Europe/Budapest")).toBeNull();
    }
  });
});
```

Create `tests/components/reset-panel.test.tsx`:

```tsx
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResetPanel } from "@/components/reset-panel";
import { getConfig } from "@/lib/config";
import { buildDashboard } from "@/lib/dashboard";
import type { ResetEvent } from "@/lib/resets";
import { renderWithIntl } from "../helpers/render";

const refresh = vi.fn();
vi.mock("@/i18n/routing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/i18n/routing")>()),
  useRouter: () => ({ refresh }),
}));

const HOUR = 3_600_000;
// Wednesday 12:00 Budapest time; the weekly cycle started Monday 00:00 (Sunday 22:00 UTC).
const NOW = new Date("2026-09-23T10:00:00Z");
const S = Date.parse("2026-09-20T22:00:00Z");
// Fixed to Budapest time, independent of DEFAULT_RESET's own (deploy-time) default.
const config = { ...getConfig({}), reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" } };

function reset(id: string, hoursIntoCycle: number, overrides: Partial<ResetEvent> = {}): ResetEvent {
  const atMs = S + hoursIntoCycle * HOUR;
  return {
    id,
    atMs,
    kind: "keep",
    cycleStartMs: S,
    before: 80,
    beforeAtMs: null,
    source: "manual",
    recordedAtMs: atMs,
    ...overrides,
  };
}

function answering(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sent(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.map(([path, init]) => ({
    path,
    method: (init as RequestInit).method,
    body: JSON.parse((init as RequestInit).body as string),
  }));
}

/** The official figure 62%, read at 11:00 Budapest time, an hour before now. */
function renderPanel(resets: ResetEvent[] = []) {
  const model = buildDashboard(NOW, config, { events: [], groups: [], machines: [], resets });
  renderWithIntl(
    <ResetPanel
      providerId="claude"
      providerLabel="Claude"
      model={model}
      resetMode="keep"
      entry={{ raw: "62", enteredAt: NOW.getTime() - HOUR }}
    />,
  );
}

describe("ResetPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    refresh.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("records a reset at the moment given, with the stored figure read before it", async () => {
    const fetchMock = answering(200, { ok: true });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "There was a reset…" }));
    expect((screen.getByLabelText(/Used before the reset/) as HTMLInputElement).value).toBe("62");
    // 11:30: the figure was read at 11:00, before it, so it stays.
    fireEvent.change(screen.getByLabelText(/When/), { target: { value: "2026-09-23T11:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sent(fetchMock)).toEqual([
      {
        path: "/api/resets",
        method: "POST",
        body: { providerId: "claude", atMs: Date.parse("2026-09-23T09:30:00Z"), before: 62 },
      },
    ]);
  });

  it("leaves the figure out when it was read after the moment", async () => {
    const fetchMock = answering(200, { ok: true });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "There was a reset…" }));
    fireEvent.change(screen.getByLabelText(/When/), { target: { value: "2026-09-23T10:30" } });
    expect((screen.getByLabelText(/Used before the reset/) as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sent(fetchMock)[0]!.body).toEqual({
      providerId: "claude",
      atMs: Date.parse("2026-09-23T08:30:00Z"),
      before: null,
    });
  });

  it("edits a reset of the list", async () => {
    const fetchMock = answering(200, { ok: true });
    renderPanel([reset("k", 38)]);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect((screen.getByLabelText(/When/) as HTMLInputElement).value).toBe("2026-09-22T14:00");
    fireEvent.change(screen.getByLabelText(/Used before the reset/), { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(sent(fetchMock)).toEqual([
      { path: "/api/resets", method: "PUT", body: { providerId: "claude", id: "k", atMs: S + 38 * HOUR, before: 75 } },
    ]);
  });

  it("deletes a reset recorded by hand, and reverts one the menu bar app detected", async () => {
    const fetchMock = answering(200, { ok: true });
    renderPanel([reset("manual", 20), reset("detected", 38, { source: "report" })]);
    expect(screen.getByText("detected by the menu bar app")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Wrong – revert" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(sent(fetchMock).map((call) => [call.method, call.body])).toEqual([
      ["DELETE", { providerId: "claude", id: "detected", revert: true }],
      ["DELETE", { providerId: "claude", id: "manual" }],
    ]);
  });

  it("says why the server refused", async () => {
    answering(409, { error: "duplicate_reset" });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "There was a reset…" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("There is already a reset at that minute.")).toBeDefined();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("checks the figure before sending it, and names the reset type with a link to the settings", () => {
    const fetchMock = answering(200, { ok: true });
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "There was a reset…" }));
    expect(screen.getByText(/the weekly reset stays/)).toBeDefined();
    expect(screen.getByRole("link", { name: "Change in the settings" }).getAttribute("href")).toContain(
      "/settings#settings-general",
    );
    fireEvent.change(screen.getByLabelText(/Used before the reset/), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/as a number from 0 to 100/)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run tests/cycle.test.ts tests/components/reset-panel.test.tsx`
Expected: FAIL — `wallClockInput` is not exported; `@/components/reset-panel` does not exist.

- [ ] **Step 2: The field's wall clock**

In `lib/cycle.ts`, add after `wallClockOf`:

```ts
const twoDigits = (value: number) => String(value).padStart(2, "0");

/** `ms` as a `datetime-local` field's value: the wall clock of `timeZone`, to the minute ("2026-09-22T14:05"). */
export function wallClockInput(ms: number, timeZone: string): string {
  const { year, month, day, hour, minute } = zonedParts(new Date(ms), timeZone);
  return `${year}-${twoDigits(month)}-${twoDigits(day)}T${twoDigits(hour)}:${twoDigits(minute)}`;
}

/** A `datetime-local` field's value, read as the wall clock of `timeZone`, to the minute; null when it is no such value. */
export function fromWallClockInput(value: string, timeZone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d{1,3})?)?$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number) as [number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return zonedTimeToUtc(year, month, day, hour, minute, timeZone).getTime();
}
```

- [ ] **Step 3: The requests**

Create `components/reset-requests.ts`:

```ts
/**
 * The dashboard's calls to /api/resets (app/api/resets/route.ts), and why one
 * failed: the route's own refusals, or the problems an official figure's save
 * can meet too (components/use-official-entry.ts).
 */

const REFUSALS = ["outside_cycle", "duplicate_reset", "has_later_resets", "not_revertable", "not_found"] as const;

export type ResetProblem = (typeof REFUSALS)[number] | "unauthorized" | "rejected" | "storage" | "network";

export type ResetResult = { ok: true } | { ok: false; problem: ResetProblem };

export async function sendReset(
  method: "POST" | "PUT" | "DELETE",
  body: Record<string, unknown>,
): Promise<ResetResult> {
  let response: Response;
  try {
    response = await fetch("/api/resets", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, problem: "network" };
  }
  if (response.ok) return { ok: true };
  if (response.status === 401) return { ok: false, problem: "unauthorized" };
  if (response.status === 404 || response.status === 409) {
    const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const refusal = REFUSALS.find((code) => code === payload?.error);
    return { ok: false, problem: refusal ?? "rejected" };
  }
  // 400 a payload the route refused, 403 a foreign origin or the demo's read-only mode.
  if (response.status === 400 || response.status === 403) return { ok: false, problem: "rejected" };
  return { ok: false, problem: "storage" };
}
```

- [ ] **Step 4: The panel**

Add the messages:

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const add = {
  en: {
    reset_list_heading: "Resets in this cycle",
    reset_row_keep: "{moment} · before it {before}",
    reset_row_restart: "{moment} · this cycle started with it · before it {before}",
    reset_detected: "detected by the menu bar app",
    reset_edit: "Edit",
    reset_revert: "Wrong – revert",
    reset_add: "There was a reset…",
    reset_when: "When ({timeZone})",
    reset_before: "Used before the reset",
    reset_mode_note:
      "{mode, select, restart {{label} resets this way: the reset becomes the new {period, select, monthly {monthly} other {weekly}} reset, and a new cycle starts.} other {{label} resets this way: the {period, select, monthly {monthly} other {weekly}} reset stays, and the cycle goes on.}} <link>Change in the settings</link>",
    reset_save: "Save",
    reset_cancel: "Cancel",
    reset_problem_outside_cycle: "The moment must fall in the current cycle, and not in the future.",
    reset_problem_duplicate_reset: "There is already a reset at that minute.",
    reset_problem_has_later_resets: "This reset would end the cycle before a later reset of it: edit or delete that one first.",
    reset_problem_not_revertable: "Only a reset the menu bar app detected can be reverted.",
    reset_problem_not_found: "This reset no longer exists. Reload the page.",
    reset_problem_unauthorized: "Your session has expired. Reload the page and sign in again.",
    reset_problem_rejected: "The server rejected this change.",
    reset_problem_storage: "The server could not save this change. Try again.",
    reset_problem_network: "Could not reach the server. Check your connection and try again.",
    reset_problem_invalid_moment: "Give the moment as a date and a time.",
    reset_problem_invalid_before: "Give the share used before the reset as a number from 0 to 100, or leave it empty.",
  },
  hu: {
    reset_list_heading: "Resetek ebben a ciklusban",
    reset_row_keep: "{moment} · előtte {before}",
    reset_row_restart: "{moment} · ezzel indult ez a ciklus · előtte {before}",
    reset_detected: "a menüsáv-app észlelte",
    reset_edit: "Szerkesztés",
    reset_revert: "Téves – visszavonás",
    reset_add: "Volt egy reset…",
    reset_when: "Mikor ({timeZone})",
    reset_before: "Felhasználva a reset előtt",
    reset_mode_note:
      "{mode, select, restart {{label} így resetel: a reset lesz az új {period, select, monthly {havi} other {heti}} reset, és új ciklus indul.} other {{label} így resetel: a {period, select, monthly {havi} other {heti}} reset marad, a ciklus folytatódik.}} <link>Módosítás a beállításokban</link>",
    reset_save: "Mentés",
    reset_cancel: "Mégse",
    reset_problem_outside_cycle: "Az időpontnak a mostani ciklusba kell esnie, és nem lehet a jövőben.",
    reset_problem_duplicate_reset: "Abban a percben már van egy reset.",
    reset_problem_has_later_resets: "Ez a reset a ciklus egy későbbi resete előtt zárná le a ciklust: előbb azt szerkeszd vagy töröld.",
    reset_problem_not_revertable: "Csak a menüsáv-app által észlelt reset vonható vissza.",
    reset_problem_not_found: "Ez a reset már nem létezik. Töltsd újra az oldalt.",
    reset_problem_unauthorized: "A munkameneted lejárt. Töltsd újra az oldalt, és jelentkezz be újra.",
    reset_problem_rejected: "A szerver elutasította ezt a módosítást.",
    reset_problem_storage: "A szerver nem tudta menteni ezt a módosítást. Próbáld újra.",
    reset_problem_network: "Nem sikerült elérni a szervert. Ellenőrizd a kapcsolatot, és próbáld újra.",
    reset_problem_invalid_moment: "Add meg az időpontot dátummal és idővel.",
    reset_problem_invalid_before: "A reset előtti felhasználást 0 és 100 közötti számként add meg, vagy hagyd üresen.",
  },
  de: {
    reset_list_heading: "Resets in diesem Zyklus",
    reset_row_keep: "{moment} · davor {before}",
    reset_row_restart: "{moment} · damit begann dieser Zyklus · davor {before}",
    reset_detected: "von der Menüleisten-App erkannt",
    reset_edit: "Bearbeiten",
    reset_revert: "Falsch – zurücknehmen",
    reset_add: "Es gab einen Reset …",
    reset_when: "Wann ({timeZone})",
    reset_before: "Vor dem Reset verbraucht",
    reset_mode_note:
      "{mode, select, restart {{label} setzt so zurück: Der Reset wird zum neuen {period, select, monthly {monatlichen} other {wöchentlichen}} Reset, und ein neuer Zyklus beginnt.} other {{label} setzt so zurück: Der {period, select, monthly {monatliche} other {wöchentliche}} Reset bleibt, der Zyklus läuft weiter.}} <link>In den Einstellungen ändern</link>",
    reset_save: "Speichern",
    reset_cancel: "Abbrechen",
    reset_problem_outside_cycle: "Der Zeitpunkt muss im aktuellen Zyklus liegen und darf nicht in der Zukunft sein.",
    reset_problem_duplicate_reset: "In dieser Minute gibt es bereits einen Reset.",
    reset_problem_has_later_resets: "Dieser Reset würde den Zyklus vor einem seiner späteren Resets beenden: Bearbeite oder lösche zuerst jenen.",
    reset_problem_not_revertable: "Nur ein von der Menüleisten-App erkannter Reset kann zurückgenommen werden.",
    reset_problem_not_found: "Dieser Reset existiert nicht mehr. Lade die Seite neu.",
    reset_problem_unauthorized: "Deine Sitzung ist abgelaufen. Lade die Seite neu und melde dich erneut an.",
    reset_problem_rejected: "Der Server hat diese Änderung abgelehnt.",
    reset_problem_storage: "Der Server konnte diese Änderung nicht speichern. Versuche es erneut.",
    reset_problem_network: "Der Server konnte nicht erreicht werden. Überprüfe deine Verbindung und versuche es erneut.",
    reset_problem_invalid_moment: "Gib den Zeitpunkt mit Datum und Uhrzeit an.",
    reset_problem_invalid_before: "Gib den Verbrauch vor dem Reset als Zahl von 0 bis 100 an oder lass das Feld leer.",
  },
};
for (const [locale, keys] of Object.entries(add)) {
  const path = `messages/${locale}.json`;
  const messages = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(messages.Widgets, keys);
  writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`);
}
EOF
```

Create `components/reset-panel.tsx`:

```tsx
"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { type ResetProblem, sendReset } from "@/components/reset-requests";
import { StatusLine } from "@/components/status-line";
import { FIELD, PRIMARY_BUTTON, QUIET_BUTTON } from "@/components/ui/classes";
import type { Entry } from "@/components/use-official-entry";
import { Link, useRouter } from "@/i18n/routing";
import type { ResetMode } from "@/lib/config";
import { fromWallClockInput, wallClockInput } from "@/lib/cycle";
import type { DashboardModel, DashboardReset } from "@/lib/dashboard";
import { formatCycleMoment, formatPercent } from "@/lib/format";
import { parseOfficialPercent } from "@/lib/ground-truth";
import { beforeFromRaw, MINUTE_MS } from "@/lib/resets";

/** Why the form was not sent, or the server refused it. */
type FormProblem = ResetProblem | "invalid_moment" | "invalid_before";

/** The open form: a new reset (`id` null), or one of the list's. */
interface ResetForm {
  id: string | null;
  /** The `datetime-local` field, as typed. */
  when: string;
  /** "Used before the reset", as typed. */
  before: string;
  /** False while `before` is still the stored figure: it then follows the moment. */
  beforeTouched: boolean;
}

/** The stored official figure as a before-figure, if it was read before `atMs`; empty otherwise. */
function storedBefore(entry: Entry, atMs: number | null): string {
  if (atMs === null || entry.enteredAt === null || entry.enteredAt > atMs) return "";
  const before = beforeFromRaw(entry.raw);
  return before === null ? "" : String(before);
}

/**
 * The current cycle's usage resets, under the official field (lib/resets.ts,
 * /api/resets): "There was a reset…" records one, each row edits its own and
 * deletes it, or reverts it when the menu bar app detected it. A saved change
 * reloads the page: the segments move, and a restart-type reset starts a new
 * cycle.
 */
export function ResetPanel({
  providerId,
  providerLabel,
  model,
  resetMode,
  entry,
}: {
  providerId: string;
  providerLabel: string;
  model: DashboardModel;
  resetMode: ResetMode;
  /** The official field as it stands: what "used before the reset" starts from. */
  entry: Entry;
}) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const router = useRouter();
  const [form, setForm] = useState<ResetForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const { timeZone } = model;

  const send = async (method: "POST" | "PUT" | "DELETE", body: Record<string, unknown>) => {
    setBusy(true);
    setProblem(null);
    const result = await sendReset(method, body);
    setBusy(false);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setForm(null);
    router.refresh();
  };

  const openNew = () => {
    const atMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    setProblem(null);
    setForm({ id: null, when: wallClockInput(atMs, timeZone), before: storedBefore(entry, atMs), beforeTouched: false });
  };

  const openEdit = (reset: DashboardReset) => {
    setProblem(null);
    setForm({
      id: reset.id,
      when: wallClockInput(reset.atMs, timeZone),
      before: reset.before === null ? "" : String(reset.before),
      beforeTouched: true,
    });
  };

  const changeWhen = (when: string) =>
    setForm(
      (current) =>
        current && {
          ...current,
          when,
          before: current.beforeTouched ? current.before : storedBefore(entry, fromWallClockInput(when, timeZone)),
        },
    );

  const save = () => {
    if (!form) return;
    const atMs = fromWallClockInput(form.when, timeZone);
    if (atMs === null) {
      setProblem("invalid_moment");
      return;
    }
    const parsed = parseOfficialPercent(form.before);
    if (parsed.invalid) {
      setProblem("invalid_before");
      return;
    }
    const before = parsed.percent;
    void (form.id === null
      ? send("POST", { providerId, atMs, before })
      : send("PUT", { providerId, id: form.id, atMs, before }));
  };

  return (
    <div className="mt-6 border-t border-hairline pt-5">
      {model.resets.length > 0 && (
        <>
          <h3 className="text-sm font-medium text-ink-2">{t("reset_list_heading")}</h3>
          <ul className="mb-4 mt-2 space-y-2 text-sm text-ink-2">
            {model.resets.map((reset) => {
              const values = {
                moment: formatCycleMoment(reset.atMs, model.period, timeZone, locale),
                before: reset.before === null ? "–" : formatPercent(reset.before / 100, locale),
              };
              return (
                <li key={reset.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span>{reset.kind === "restart" ? t("reset_row_restart", values) : t("reset_row_keep", values)}</span>
                  {reset.source === "report" && <span className="text-ink-3">{t("reset_detected")}</span>}
                  <span className="ml-auto flex shrink-0 gap-2">
                    <button type="button" disabled={busy} onClick={() => openEdit(reset)} className={QUIET_BUTTON}>
                      {t("reset_edit")}
                    </button>
                    {reset.source === "report" ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void send("DELETE", { providerId, id: reset.id, revert: true })}
                        className={QUIET_BUTTON}
                      >
                        {t("reset_revert")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void send("DELETE", { providerId, id: reset.id })}
                        className={QUIET_BUTTON}
                      >
                        {t("delete")}
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {form === null ? (
        <button type="button" onClick={openNew} className={`text-sm ${QUIET_BUTTON}`}>
          {t("reset_add")}
        </button>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
          className="space-y-4"
        >
          <div className="flex flex-wrap gap-x-5 gap-y-4">
            <label className="block">
              <span className="text-sm text-ink-3">{t("reset_when", { timeZone })}</span>
              <input
                type="datetime-local"
                step={60}
                required
                min={wallClockInput(model.cycle.startMs + MINUTE_MS, timeZone)}
                max={wallClockInput(Date.now(), timeZone)}
                value={form.when}
                onChange={(event) => changeWhen(event.target.value)}
                className={`mt-1.5 block tabular-nums ${FIELD}`}
              />
            </label>
            <label className="block">
              <span className="text-sm text-ink-3">{t("reset_before")}</span>
              <span className="relative mt-1.5 block w-28">
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={7}
                  placeholder="–"
                  value={form.before}
                  onChange={(event) => setForm({ ...form, before: event.target.value, beforeTouched: true })}
                  className={`block w-28 pr-8 tabular-nums ${FIELD}`}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-3"
                >
                  %
                </span>
              </span>
            </label>
          </div>
          <p className="max-w-2xl text-sm text-ink-3">
            {t.rich("reset_mode_note", {
              label: providerLabel,
              mode: resetMode,
              period: model.period,
              link: (chunks) => (
                <Link
                  href="/settings#settings-general"
                  className="text-ink-2 underline decoration-rule underline-offset-4 hover:decoration-ink-3"
                >
                  {chunks}
                </Link>
              ),
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={`text-sm ${PRIMARY_BUTTON}`}>
              {t("reset_save")}
            </button>
            <button type="button" disabled={busy} onClick={() => setForm(null)} className={`text-sm ${QUIET_BUTTON}`}>
              {t("reset_cancel")}
            </button>
          </div>
        </form>
      )}

      {problem && (
        <div className="mt-3">
          <StatusLine tone="problem">{t(`reset_problem_${problem}`)}</StatusLine>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: On the dashboard**

In `components/dashboard-view.tsx`, add `import { ResetPanel } from "@/components/reset-panel";` and render
the panel inside `GroundTruthInput`, after `SubLimitMeters`:

```tsx
            <SubLimitMeters model={model} subLimits={subLimits} onChange={setSubEntry} providerLabel={selected.label} />
            {/* Resets are recorded in the current cycle only. */}
            {!model.closed && (
              <ResetPanel
                providerId={selected.id}
                providerLabel={selected.label}
                model={model}
                resetMode={selected.resetMode}
                entry={entry}
              />
            )}
```

- [ ] **Step 6: Documentation**

In `docs/configuration.md`, in "### Reset and time zone", replace the sentence "The value is stored
server-side (not per browser), tagged to the cycle it was entered in, and clears itself automatically once
that cycle ends." with:

```markdown
The value is stored server-side (not per browser), tagged to the stretch of the cycle it was entered in —
the cycle, or the part of it since its latest [usage reset](#usage-resets) — and clears itself
automatically once that ends.
```

Add a section right before `## Environment variables`:

```markdown
### Usage resets

Some providers occasionally reset a user's usage before the cycle ends. Under the official-percentage
field, **There was a reset…** records one: when it happened (the reset time zone's wall clock, from the
cycle's start up to now), and the percentage used right before it — prefilled from the stored official
figure when that was read before the moment, left empty when unknown. What it does depends on the
provider's reset type ([Reset and time zone](#reset-and-time-zone)):

- **The weekly reset stays** (Claude's way): the reset splits the cycle into segments. The meter, the
  pace, the groups, the machines, the sub-limits and the cost estimate count the current segment only,
  and the meter's day ruler covers it. A line under the main figure lists each reset with the figure
  before it, and the cycle's total: those figures and the current one added up (an unknown one is a dash,
  left out). The usage chart still shows the whole cycle, with a marker at each reset, where every line
  starts again from 0. Under an official figure, each finished segment is scaled by its own before-figure;
  one without it is an estimate at the current rate, drawn faded.
- **The reset becomes the new weekly reset** (Codex's way): the cycle ends at the reset and a fresh one
  starts there; the provider's own reset moves to that moment. The page shows the new cycle, and the one
  cut short moves to the previous cycles.

The list under the button holds this cycle's resets, each editable and deletable. The menu bar app's
readings also record resets on their own ([`POST /api/official-usage/report`](api.md#post-apiofficial-usagereport));
such a row is marked *detected by the menu bar app*, and offers **Wrong – revert** instead of delete:
that puts the figure from before it back, and stops detection for the rest of the cycle. Only the
current cycle's resets can be recorded or changed.
```

In `docs/api.md`, in `## POST/PUT/DELETE /api/resets`, after the sentence ending "(see `lib/resets.ts` for
the reset types). 1 KB body.", add: `What the dashboard shows of them: [configuration.md](configuration.md#usage-resets).`

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/cycle.test.ts tests/components/ tests/messages.test.ts`
Expected: PASS.

- [ ] **Step 8: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add lib/cycle.ts components/reset-requests.ts components/reset-panel.tsx components/dashboard-view.tsx messages/en.json messages/hu.json messages/de.json docs/configuration.md docs/api.md tests/cycle.test.ts tests/components/reset-panel.test.tsx
git commit -m "feat(resets): record, edit, delete and revert resets on the dashboard"
```

### Task 7: "Was there a reset?"

**Files:**
- Modify: `lib/resets.ts` (`RESET_DROP_POINTS` moves here; `RESET_PROMPT_BELOW`, `promptsReset`)
- Modify: `lib/official-report.ts` (imports `RESET_DROP_POINTS`), `tests/official-report.test.ts` (its import)
- Create: `components/use-reset-prompt.ts`
- Modify: `components/reset-panel.tsx` (adds `ResetPrompt`)
- Modify: `components/ground-truth-input.tsx` (`belowField` prop)
- Modify: `components/dashboard-view.tsx` (wiring)
- Modify: `messages/en.json`, `messages/hu.json`, `messages/de.json` (`Widgets`), `docs/configuration.md`
- Test: `tests/resets.test.ts`, `tests/components/reset-panel.test.tsx`, `tests/components/dashboard-view.test.tsx`

**Interfaces:**
- Consumes: `sendReset`, `ResetProblem`, the `reset_problem_*` keys (Task 6); `POST /api/resets` with `afterRaw`
  (plan 1: stored as the provider's figure at `atMs`, tagged with the new segment or cycle); `EntryStatus.status`
  (`"idle" | "saving" | "saved" | "failed"`) from `useOfficialEntry`.
- Produces:
  - `RESET_DROP_POINTS = 5`, `RESET_PROMPT_BELOW = 10`, `promptsReset(before: number | null, after: number | null): boolean` in `lib/resets.ts`
  - `useResetPrompt(percent: number | null, saving: boolean): { from: number | null; beginEdit: () => void; dismiss: () => void }`
  - `ResetPrompt({ providerId, providerLabel, before, afterRaw, onDone })` in `components/reset-panel.tsx`
  - `GroundTruthInput` prop `belowField?: React.ReactNode`

- [ ] **Step 1: Write the failing tests**

In `tests/resets.test.ts` add `promptsReset` to the `@/lib/resets` import and append:

```ts
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
```

In `tests/components/reset-panel.test.tsx` change the import to
`import { ResetPanel, ResetPrompt } from "@/components/reset-panel";` and append:

```tsx
describe("ResetPrompt", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-23T10:00:42Z"));
    refresh.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const renderPrompt = (onDone = vi.fn()) => {
    renderWithIntl(<ResetPrompt providerId="claude" providerLabel="Claude" before={62} afterRaw="8" onDone={onDone} />);
    return onDone;
  };

  it("records a reset now, with the figure from before the edit and the new one", async () => {
    const fetchMock = answering(200, { ok: true });
    const onDone = renderPrompt();
    expect(screen.getByText(/stood at 62% before this change/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Yes, record a reset" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(sent(fetchMock)).toEqual([
      {
        path: "/api/resets",
        method: "POST",
        body: { providerId: "claude", atMs: Date.parse("2026-09-23T10:00:00Z"), before: 62, afterRaw: "8" },
      },
    ]);
    expect(refresh).toHaveBeenCalled();
  });

  it("leaves the edit a plain correction on No", () => {
    const fetchMock = answering(200, { ok: true });
    const onDone = renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "No, just a correction" }));
    expect(onDone).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says why the server refused", async () => {
    answering(409, { error: "duplicate_reset" });
    const onDone = renderPrompt();
    fireEvent.click(screen.getByRole("button", { name: "Yes, record a reset" }));
    expect(await screen.findByText("There is already a reset at that minute.")).toBeDefined();
    expect(onDone).not.toHaveBeenCalled();
  });
});
```

Append to `tests/components/dashboard-view.test.tsx` (add `waitFor` to its `@testing-library/react` import and
`import { officialUsageField } from "@/lib/official-usage";`):

```tsx
describe("DashboardView — 'Was there a reset?'", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks once a figure typed below 10% has been saved, and not for one at 10% or above", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, enteredAt: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const now = new Date("2026-09-23T12:00:00Z");
    const [claude] = buildProviderDashboards(
      now,
      getConfig({}),
      ["claude"],
      { eventsByProvider: {}, groups: [], machines: [] },
      new Map([[officialUsageField("claude", null), { raw: "62", enteredAt: now.getTime() - 3_600_000 }]]),
    );
    renderWithIntl(
      <DashboardView providers={[claude!]} historyByProvider={{}} historyContext={historyContext} pastCycle={false} />,
    );
    const field = screen.getByLabelText("Current official consumption");
    const question = () => screen.queryByRole("button", { name: "Yes, record a reset" });

    fireEvent.change(field, { target: { value: "8" } });
    // Not while the figure is being saved (the save goes out 600 ms after the last change).
    expect(question()).toBeNull();
    expect(await screen.findByRole("button", { name: "Yes, record a reset" }, { timeout: 2_000 })).toBeDefined();
    expect(screen.getByText(/stood at 62% before this change/)).toBeDefined();

    fireEvent.change(field, { target: { value: "12" } });
    expect(question()).toBeNull();
    // Its save goes out too: nothing is left pending for the next test.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(question()).toBeNull();
  });
});
```

Run: `npx vitest run tests/resets.test.ts tests/components/reset-panel.test.tsx tests/components/dashboard-view.test.tsx`
Expected: FAIL — `promptsReset` and `ResetPrompt` are not exported; no question appears.

- [ ] **Step 2: The threshold**

In `lib/resets.ts`, add after `MINUTE_MS`:

```ts
/**
 * A keep reset is detected from a reading at least this many points under the
 * stored one (lib/official-report.ts); the dashboard asks "Was there a reset?"
 * from the same drop.
 */
export const RESET_DROP_POINTS = 5;
/** The dashboard asks only once the official field is edited below this percentage. */
export const RESET_PROMPT_BELOW = 10;
```

and at the end of the "Small helpers" section:

```ts
/**
 * Whether an edit of the official field from `before` to `after` (0–100; null:
 * empty) asks "Was there a reset?": the new figure is under
 * `RESET_PROMPT_BELOW` and at least `RESET_DROP_POINTS` below the old one.
 * Dragging the figure down never records a reset by itself.
 */
export function promptsReset(before: number | null, after: number | null): boolean {
  return before !== null && after !== null && after < RESET_PROMPT_BELOW && before - after >= RESET_DROP_POINTS;
}
```

In `lib/official-report.ts`, delete `export const RESET_DROP_POINTS = 5;` and add `RESET_DROP_POINTS` to its
`@/lib/resets` import. In `tests/official-report.test.ts`, import `RESET_DROP_POINTS` from `@/lib/resets`
instead of `@/lib/official-report`.

- [ ] **Step 3: When the question stands**

Create `components/use-reset-prompt.ts`:

```ts
"use client";

import { useCallback, useEffect, useState } from "react";
import { promptsReset } from "@/lib/resets";

/**
 * "Was there a reset?" (lib/resets.ts `promptsReset`): the figure the official
 * field held when an edit of it began, kept while the edit is being saved and
 * while the question it raises stands. `from` is that figure once the
 * question stands, else null. The question waits for the save to settle: a
 * reset recorded while the save was still on its way would be overwritten by
 * it, since the save carries the old segment's tag. `beginEdit` is called
 * before each change (it keeps the first figure), `dismiss` once answered.
 */
export function useResetPrompt(
  percent: number | null,
  saving: boolean,
): { from: number | null; beginEdit: () => void; dismiss: () => void } {
  const [edit, setEdit] = useState<{ from: number | null } | null>(null);
  const asks = edit !== null && promptsReset(edit.from, percent);

  useEffect(() => {
    // An edit that raises no question ends with its save.
    if (edit !== null && !saving && !asks) setEdit(null);
  }, [edit, saving, asks]);

  const beginEdit = useCallback(() => setEdit((current) => current ?? { from: percent }), [percent]);
  const dismiss = useCallback(() => setEdit(null), []);
  return { from: asks && !saving ? (edit?.from ?? null) : null, beginEdit, dismiss };
}
```

- [ ] **Step 4: The question**

Add the messages:

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const add = {
  en: {
    reset_prompt_question: "Did {label} reset your usage? The figure stood at {before} before this change.",
    reset_prompt_yes: "Yes, record a reset",
    reset_prompt_no: "No, just a correction",
  },
  hu: {
    reset_prompt_question: "{label}: reset történt? A módosítás előtt {before} állt itt.",
    reset_prompt_yes: "Igen, reset rögzítése",
    reset_prompt_no: "Nem, csak javítás",
  },
  de: {
    reset_prompt_question: "Hat {label} deinen Verbrauch zurückgesetzt? Vor dieser Änderung stand hier {before}.",
    reset_prompt_yes: "Ja, Reset erfassen",
    reset_prompt_no: "Nein, nur eine Korrektur",
  },
};
for (const [locale, keys] of Object.entries(add)) {
  const path = `messages/${locale}.json`;
  const messages = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(messages.Widgets, keys);
  writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`);
}
EOF
```

Append to `components/reset-panel.tsx`:

```tsx
/**
 * "Was there a reset?", under the official field once an edit took the figure
 * low (components/use-reset-prompt.ts). Yes records a reset now: `before` is
 * the figure from before the edit, `afterRaw` the new one, stored as the
 * figure since the reset. No leaves the edit a plain correction.
 */
export function ResetPrompt({
  providerId,
  providerLabel,
  before,
  afterRaw,
  onDone,
}: {
  providerId: string;
  providerLabel: string;
  /** 0–100: the figure the field held when the edit began. */
  before: number;
  /** The field's text now. */
  afterRaw: string;
  /** Answered, or the reset recorded: the question goes. */
  onDone: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ResetProblem | null>(null);

  const confirm = async () => {
    setBusy(true);
    setProblem(null);
    const atMs = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
    const result = await sendReset("POST", { providerId, atMs, before, afterRaw: afterRaw.trim() });
    setBusy(false);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    onDone();
    router.refresh();
  };

  return (
    <div className="mt-4 rounded-md border border-ink-3 px-4 py-3">
      <p className="text-sm text-ink-2">
        {t("reset_prompt_question", { label: providerLabel, before: formatPercent(before / 100, locale) })}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void confirm()} className={`text-sm ${PRIMARY_BUTTON}`}>
          {t("reset_prompt_yes")}
        </button>
        <button type="button" disabled={busy} onClick={onDone} className={`text-sm ${QUIET_BUTTON}`}>
          {t("reset_prompt_no")}
        </button>
      </div>
      {problem && (
        <div className="mt-2">
          <StatusLine tone="problem">{t(`reset_problem_${problem}`)}</StatusLine>
        </div>
      )}
    </div>
  );
}
```

In `components/ground-truth-input.tsx`, `GroundTruthInputProps` gains, after `children`:

```ts
  /** Right under the field's hint: the "Was there a reset?" question (components/reset-panel.tsx), when it stands. */
  belowField?: React.ReactNode;
```

and `{props.belowField}` is rendered right before `{props.children}` (after the failed-save status line).

In `components/dashboard-view.tsx`: import `ResetPrompt` next to `ResetPanel` and
`import { useResetPrompt } from "@/components/use-reset-prompt";`; after
`const { percent, invalid } = parseOfficialPercent(entry.raw);` add:

```tsx
  // "Was there a reset?": asked once an edit takes the figure low and its save has settled.
  const resetPrompt = useResetPrompt(percent, entryStatus.status === "saving");
  const { beginEdit } = resetPrompt;
  const changeEntry = useCallback(
    (raw: string) => {
      beginEdit();
      setEntry(raw);
    },
    [beginEdit, setEntry],
  );
```

and on `GroundTruthInput` replace `onChange={setEntry}` with `onChange={changeEntry}` and add:

```tsx
            belowField={
              !model.closed &&
              resetPrompt.from !== null && (
                <ResetPrompt
                  providerId={selected.id}
                  providerLabel={selected.label}
                  before={resetPrompt.from}
                  afterRaw={entry.raw}
                  onDone={resetPrompt.dismiss}
                />
              )
            }
```

- [ ] **Step 5: Documentation**

In `docs/configuration.md`, append to the "### Usage resets" section:

```markdown
Dragging or typing the official figure down never records a reset by itself. When an edit takes it below
10%, at least 5 points under where it stood, a **Was there a reset?** question appears under the field once
the new figure is saved: **Yes** records a reset now, with the earlier figure as the one before it and the
new one as the figure since; **No** leaves the edit a plain correction. It never appears on a finished
cycle's correction.
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/resets.test.ts tests/official-report.test.ts tests/components/ tests/messages.test.ts`
Expected: PASS.

- [ ] **Step 7: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add lib/resets.ts lib/official-report.ts components/use-reset-prompt.ts components/reset-panel.tsx components/ground-truth-input.tsx components/dashboard-view.tsx messages/en.json messages/hu.json messages/de.json docs/configuration.md tests/resets.test.ts tests/official-report.test.ts tests/components/reset-panel.test.tsx tests/components/dashboard-view.test.tsx
git commit -m "feat(resets): ask whether there was a reset when the official figure is dragged down"
```

### Task 8: The reset type on the settings page

**Files:**
- Modify: `components/settings/sections/reset-section.tsx` (per-provider rows)
- Modify: `messages/en.json`, `messages/hu.json`, `messages/de.json` (`Settings`)
- Modify: `docs/configuration.md` ("Reset and time zone", "Alerts")
- Test: `tests/components/reset-section.test.tsx`

**Interfaces:**
- Consumes (plan 1): `Draft.resetModes: Record<string, ResetMode>` (only the stored entries; saved with the panel),
  `DraftOwnReset.source?: "report" | "reset"`, `resetModeOf(config: Pick<AppConfig, "resetModes">, providerId)`
  (the stored mode, else `claude`/`anthropic` keep, `openai` restart, anything else keep). The section's
  `onPatch(changes: Partial<Draft>)`.
- Produces: nothing new for other tasks.

- [ ] **Step 1: Write the failing tests**

In `tests/components/reset-section.test.tsx`, give `draftWith` a second parameter and the field:

```tsx
function draftWith(overrides: Draft["resetOverrides"], resetModes: Draft["resetModes"] = {}): Draft {
```

with `resetModes,` added to the returned object right after `resetOverrides: overrides,`, and change
`renderSection` to pass it on:

```tsx
function renderSection(overrides: Draft["resetOverrides"], resetModes: Draft["resetModes"] = {}) {
  const handlers = { onPatch: vi.fn(), onOwnReset: vi.fn(), onPatchOwnReset: vi.fn() };
  renderWithIntl(<ResetSection titleId="s" draft={draftWith(overrides, resetModes)} {...handlers} />);
  return handlers;
}
```

Append:

```tsx
describe("ResetSection — the reset type", () => {
  const typeOf = (label: string) => (screen.getByLabelText(`${label}: after a reset`) as HTMLSelectElement).value;

  it("shows each provider's reset type, its default while none is stored", () => {
    renderSection({});
    expect(typeOf("Claude")).toBe("keep");
    expect(typeOf("OpenAI")).toBe("restart");
  });

  it("shows a stored type over the default", () => {
    renderSection({}, { claude: "restart" });
    expect(typeOf("Claude")).toBe("restart");
  });

  it("saves a changed type with the rest of the panel", () => {
    const handlers = renderSection({}, { openai: "keep" });
    fireEvent.change(screen.getByLabelText("Claude: after a reset"), { target: { value: "restart" } });
    expect(handlers.onPatch).toHaveBeenCalledWith({ resetModes: { openai: "keep", claude: "restart" } });
  });

  it("marks an own reset a recorded reset set", () => {
    renderSection({ openai: { weekday: 2, monthDay: 22, time: "14:00", source: "reset" } });
    expect(screen.queryByText("Set by a recorded reset")).not.toBeNull();
  });
});
```

Run: `npx vitest run tests/components/reset-section.test.tsx`
Expected: FAIL — no "after a reset" select; no "Set by a recorded reset" note.

- [ ] **Step 2: The select and the marker**

Add the messages:

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const add = {
  en: {
    reset_mode_after: "After a reset",
    reset_mode_label: "{label}: after a reset",
    reset_mode_keep: "the {period, select, monthly {monthly} other {weekly}} reset stays",
    reset_mode_restart: "the reset becomes the new {period, select, monthly {monthly} other {weekly}} reset",
    reset_set_by_reset: "Set by a recorded reset",
  },
  hu: {
    reset_mode_after: "Reset után",
    reset_mode_label: "{label}: reset után",
    reset_mode_keep: "a {period, select, monthly {havi} other {heti}} reset marad",
    reset_mode_restart: "a reset lesz az új {period, select, monthly {havi} other {heti}} reset",
    reset_set_by_reset: "Egy rögzített reset állította be",
  },
  de: {
    reset_mode_after: "Nach einem Reset",
    reset_mode_label: "{label}: nach einem Reset",
    reset_mode_keep: "der {period, select, monthly {monatliche} other {wöchentliche}} Reset bleibt",
    reset_mode_restart: "der Reset wird zum neuen {period, select, monthly {monatlichen} other {wöchentlichen}} Reset",
    reset_set_by_reset: "Von einem erfassten Reset gesetzt",
  },
};
for (const [locale, keys] of Object.entries(add)) {
  const path = `messages/${locale}.json`;
  const messages = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(messages.Settings, keys);
  writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`);
}
EOF
```

In `components/settings/sections/reset-section.tsx`, add `import { resetModeOf } from "@/lib/settings";` and
`import type { ResetMode } from "@/lib/config";`. In the per-provider row:

Replace the report-only marker

```tsx
                    {own.source === "report" && (
                      <span className="basis-full text-sm text-ink-3 sm:pl-40">
                        <span aria-hidden="true">↳ </span>
                        {t("reset_set_by_report")}
                      </span>
                    )}
```

with

```tsx
                    {own.source && (
                      <span className="basis-full text-sm text-ink-3 sm:pl-40">
                        <span aria-hidden="true">↳ </span>
                        {own.source === "reset" ? t("reset_set_by_reset") : t("reset_set_by_report")}
                      </span>
                    )}
```

and add, as the row's last child (after the `own ? … : …` block, still inside the row's `<div>`):

```tsx
                <label className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1 text-sm sm:pl-40">
                  <span className="text-ink-3">{t("reset_mode_after")}</span>
                  <select
                    aria-label={t("reset_mode_label", { label: provider.label })}
                    value={resetModeOf(draft, provider.id)}
                    onChange={(event) =>
                      onPatch({ resetModes: { ...draft.resetModes, [provider.id]: event.target.value as ResetMode } })
                    }
                    className={`max-w-full ${FIELD}`}
                  >
                    <option value="keep">{t("reset_mode_keep", { period: draft.period })}</option>
                    <option value="restart">{t("reset_mode_restart", { period: draft.period })}</option>
                  </select>
                </label>
```

- [ ] **Step 3: Documentation**

In `docs/configuration.md`, append to "### Reset and time zone" (after the time-zone paragraph, before the
**Official percentage** paragraph):

```markdown
**After a reset**: per provider, how it resets a user's usage early — *the weekly reset stays* (Claude: the
usage drops, but the cycle still ends when it would have) or *the reset becomes the new weekly reset* (Codex:
a fresh cycle starts at the reset). The defaults: `claude` and `anthropic` keep, `openai` restarts, anything
else keeps; see [Usage resets](#usage-resets). A provider's own reset moved by a recorded reset is marked
*Set by a recorded reset*, the way one the menu bar app moved is; editing it drops the mark.
```

In "### Alerts", replace "Each threshold fires at most once per provider per cycle." with:

```markdown
Each threshold fires at most once per provider per cycle — or per stretch of it: once a
[usage reset](#usage-resets) has been recorded, the thresholds can fire again for the usage since.
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/components/reset-section.test.tsx tests/settings-draft.test.ts tests/messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add components/settings/sections/reset-section.tsx messages/en.json messages/hu.json messages/de.json docs/configuration.md tests/components/reset-section.test.tsx
git commit -m "feat(resets): choose each provider's reset type on the settings page"
```

### Task 9: Full verification

**Files:** none changed, unless a check finds something (fix it in its own commit, named for what it fixes).

- [ ] **Step 1: The whole suite**

Run: `npm run check` — Expected: PASS (Biome, `tsc --noEmit`, every Vitest project).

- [ ] **Step 2: Build and end-to-end**

Run: `npm run build && npm run e2e` — Expected: PASS (the screenshot specs stay skipped, as before).

- [ ] **Step 3: By hand, on a scratch copy**

Never against the main checkout's `.env.local` (it points at the production store). In the worktree (it has no
`.env.local`), run `npm run build` and start `USAGE_STORE=memory DASHBOARD_PIN=… USAGE_API_TOKEN=… npx next start -p <free port>`
(not 3000: the user's own dev server may hold it), sign in with the PIN, send a few usage reports for `claude` and
`openai` through `POST /api/usage` with the token, and in a browser (headless Playwright Chromium is fine):

1. Claude: type an official figure (say 62), record a reset with **There was a reset…** an hour ago; the meter
   shows the segment, the line under it reads "Reset … · before it 62% · this week in total …", the chart has a
   marker and its lines restart from 0, the list has the reset. Edit its time, then delete it.
2. Codex (`openai`): record a reset; the page shows a new cycle starting at it, the old one in the previous
   cycles; delete it and the old cycle comes back.
3. Drag Claude's slider from above 15% down to 5%: once the figure is saved, **Was there a reset?** appears;
   **No** removes it; drag again and **Yes** records a reset at the current minute with the old figure.
4. Settings: switch Claude's "After a reset" to the restart type and save; the panel's note follows it.

Note anything that looks wrong in the ledger and fix it before finishing.

# Recent Pace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Next to the cycle's average pace, state the pace of the last hours (from the change point found in the last 8 hours) and when the budget runs out at that pace, on the dashboard and in the macOS menu bar app.

**Architecture:** One pure function, `recentPace(model, view)` in `lib/recent-pace.ts`, reads the dashboard model's hourly timeline. The dashboard's `QuotaMeter` and `lib/status.ts` both call it; `/api/status` carries it as `pace.recent`, which the Swift app decodes and shows as one fact line.

**Tech Stack:** TypeScript (Next.js 16, React 19, next-intl, Vitest), Swift (SwiftUI, Swift Testing).

**Spec:** `docs/superpowers/specs/2026-10-09-recent-pace-design.md`

## Global Constraints

- Window 8 hours; change factor 1.5×; no figure when the window ends more than 2 hours before the dashboard's moment; at least 1 hour of data.
- Never changes the status (good / warning / critical) or its colour.
- No new storage, no new dependency.
- UI text only through `messages/*.json` (en, hu, de in parity, every key used) and the Swift `Strings` (en, hu, de).
- `/api/status` stays `v: 1`; `pace.recent` is always present in the payload (an object or `null`).
- Conventional Commits; no AI attribution in commit messages.

## Addition to the spec

`RecentPace` also carries `untilMs` (API: `until`), the window's end, so both UIs can say "over the last N hours" when no change point was found.

---

### Task 1: `lib/recent-pace.ts`

**Files:**
- Create: `lib/recent-pace.ts`
- Test: `tests/recent-pace.test.ts`

**Interfaces:**
- Consumes: `DashboardModel` (`lib/dashboard.ts`: `closed`, `total`, `generatedAt`, `cycle.startMs/endMs`, `timeline.times`, `timeline.groups[].values`, `machines[].lastSeenAt`), `DashboardView` (`lib/ground-truth.ts`: `quota`, `asOfMs`).
- Produces: `export interface RecentPace { sinceMs: number; untilMs: number; changed: boolean; ratio: number; runOutAt: number | null }`, `export function recentPace(model: DashboardModel, view: DashboardView): RecentPace | null`.

The window: the timeline's hourly samples (`(t - cycle start) % HOUR === 0`) from `max(cycle start, until - 8 h)` up to (not including) `until` = the newest report, then `until` itself with the timeline's last value (nothing came in after the newest report). Bins between consecutive points; a trailing bin shorter than 30 minutes joins the one before it (a report a few seconds past the hour carries that hour's tokens). Change point: the split with the least duration-weighted squared error of the bins' rates around each run's own rate; a change when the two runs' rates are ≥ 1.5× apart (0 against > 0 always).

- [ ] **Step 1: Write the failing tests** — `tests/recent-pace.test.ts`, fixtures in Budapest time like `tests/ground-truth.test.ts`: limit 1,000,000, delta mode, `NOW` = Wednesday 2026-09-23T10:00Z (60 h into the cycle that started 2026-09-20T22:00Z, 108 h before its end). An event at hour `h` carries the hour `(h-1, h]`; 200,000 tokens at hour 10 set the average.
  - burst: 6 × 5,000 then 2 × 40,000 → `changed`, `sinceMs` = NOW − 2 h, `untilMs` = NOW, `ratio` ≈ 40,000 / (310,000 / 60) = 7.742, `runOutAt` = NOW + 690,000 / 40,000 h = NOW + 17.25 h;
  - slowdown: 6 × 30,000 then 2 × 0 → `changed`, `sinceMs` = NOW − 2 h, `ratio` 0, `runOutAt` null;
  - steady: 8 × 10,000 → not `changed`, `sinceMs` = NOW − 8 h, `ratio` = 10,000 / (280,000 / 60), `runOutAt` = NOW + 72 h;
  - noise within 1.5× (10k, 12k, 10k, 12k, 10k, 12k, 14k, 12k) → not `changed`;
  - lasts: 8 × 1,000 → `runOutAt` null;
  - a cycle 3 hours old: the window starts at the cycle's start; 30 minutes old: null;
  - stale: newest report 3 h before NOW → null; 2 h → a figure ending there;
  - tail: NOW = hour 60 + 20 min, last report at hour 60 + 4 s with 40,000 after 5,000/h → `sinceMs` = hour 59;
  - official reading 62% with token limits → `ratio` unchanged, `runOutAt` = NOW + 380,000 / 80,000 h = NOW + 4.75 h; without token limits, reading 31% → `runOutAt` = NOW + 17.25 h;
  - null: no quota (limits off, no reading), nothing used, at the limit, `closed`.
- [ ] **Step 2: Run** `npx vitest run tests/recent-pace.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement** `lib/recent-pace.ts`:

```ts
import type { DashboardModel } from "@/lib/dashboard";
import type { DashboardView } from "@/lib/ground-truth";

const HOUR = 3_600_000;
export const RECENT_WINDOW_MS = 8 * HOUR;
const CHANGE_FACTOR = 1.5;
const STALE_AFTER_MS = 2 * HOUR;
const MIN_TAIL_MS = 30 * 60_000;

export interface RecentPace { sinceMs: number; untilMs: number; changed: boolean; ratio: number; runOutAt: number | null }
interface Bin { startMs: number; endMs: number; tokens: number }

function windowBins(model: DashboardModel, untilMs: number): Bin[] {
  const { times, groups } = model.timeline;
  const startMs = model.cycle.startMs;
  const fromMs = Math.max(startMs, untilMs - RECENT_WINDOW_MS);
  const totalAt = (index: number) => groups.reduce((sum, group) => sum + group.values[index]!, 0);
  const points: { ms: number; tokens: number }[] = [];
  times.forEach((ms, index) => {
    if (ms >= fromMs && ms < untilMs && (ms - startMs) % HOUR === 0) points.push({ ms, tokens: totalAt(index) });
  });
  points.push({ ms: untilMs, tokens: totalAt(times.length - 1) });
  const bins = points.slice(1).map((point, index) => ({
    startMs: points[index]!.ms, endMs: point.ms, tokens: point.tokens - points[index]!.tokens,
  }));
  const tail = bins.at(-1);
  if (tail && bins.length > 1 && tail.endMs - tail.startMs < MIN_TAIL_MS) {
    bins.pop();
    const previous = bins.pop()!;
    bins.push({ startMs: previous.startMs, endMs: tail.endMs, tokens: previous.tokens + tail.tokens });
  }
  return bins;
}

function rateOf(bins: Bin[]): number {
  const length = bins.reduce((sum, bin) => sum + bin.endMs - bin.startMs, 0);
  return bins.reduce((sum, bin) => sum + bin.tokens, 0) / length;
}

function misfit(bins: Bin[], rate: number): number {
  return bins.reduce((sum, bin) => {
    const length = bin.endMs - bin.startMs;
    return sum + length * (bin.tokens / length - rate) ** 2;
  }, 0);
}

function changePoint(bins: Bin[]): number | null {
  let best: { index: number; error: number } | null = null;
  for (let index = 1; index < bins.length; index++) {
    const before = bins.slice(0, index);
    const after = bins.slice(index);
    const error = misfit(before, rateOf(before)) + misfit(after, rateOf(after));
    if (best === null || error < best.error) best = { index, error };
  }
  if (best === null) return null;
  const earlier = rateOf(bins.slice(0, best.index));
  const later = rateOf(bins.slice(best.index));
  return Math.max(earlier, later) > 0 && Math.max(earlier, later) >= CHANGE_FACTOR * Math.min(earlier, later)
    ? best.index : null;
}

export function recentPace(model: DashboardModel, view: DashboardView): RecentPace | null {
  const { quota } = view;
  if (model.closed || !quota || quota.total <= 0 || quota.total >= quota.limit || model.total <= 0) return null;
  const untilMs = Math.min(model.generatedAt, Math.max(0, ...model.machines.map((machine) => machine.lastSeenAt)));
  if (model.generatedAt - untilMs > STALE_AFTER_MS) return null;
  const bins = windowBins(model, untilMs);
  if (bins.length === 0 || untilMs - bins[0]!.startMs < HOUR) return null;
  const elapsedMs = view.asOfMs - model.cycle.startMs;
  if (elapsedMs <= 0) return null;

  const index = changePoint(bins);
  const current = index === null ? bins : bins.slice(index);
  // The timeline counts measured tokens; the budget figure may be an official reading's.
  const rate = rateOf(current) * (quota.total / model.total);
  const runOutMs = rate > 0 ? view.asOfMs + quota.remaining / rate : null;
  return {
    sinceMs: current[0]!.startMs,
    untilMs,
    changed: index !== null,
    ratio: rate / (quota.total / elapsedMs),
    runOutAt: runOutMs !== null && runOutMs < model.cycle.endMs ? Math.round(runOutMs) : null,
  };
}
```

- [ ] **Step 4: Run** `npx vitest run tests/recent-pace.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat: find the pace of the last hours next to the cycle's average`

### Task 2: Dashboard sentence

**Files:**
- Modify: `lib/format.ts` (add `formatRecentMoment`), `components/quota-meter.tsx`, `messages/{en,hu,de}.json` (`Widgets`)
- Test: `tests/format.test.ts`, `tests/components/quota-meter.test.tsx`

**Interfaces:**
- Consumes: `recentPace`, `RecentPace` (Task 1); `formatClock`, `formatWeekdayTime`, `formatDuration`, `formatFactor`, `formatCycleMoment`.
- Produces: `formatRecentMoment(ms: number, nowMs: number, timeZone: string, locale: string): string` — "14:05" on the same calendar day in `timeZone`, else "Tuesday 22:00".

- [ ] **Step 1: Failing tests.** `formatRecentMoment`: same day → clock only; the day before → weekday and time. `QuotaMeter` with the Task 1 burst data: the paragraph contains `Current pace (since <time>, 7.74× the average): runs out in about 17 hours 15 minutes, around`; steady data: `Current pace (over the last 8 hours, `; a slowdown: `Current pace: nothing used since`.
- [ ] **Step 2: Run** `npx vitest run tests/format.test.ts tests/components/quota-meter.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**

`lib/format.ts`:

```ts
/** "14:05" on the same day as `nowMs`, else "kedd 22:00": where a recent stretch began. */
export function formatRecentMoment(ms: number, nowMs: number, timeZone: string, locale: string): string {
  const day = (value: number) => new Intl.DateTimeFormat("en-CA", { timeZone }).format(value);
  return day(ms) === day(nowMs) ? formatClock(ms, timeZone, locale) : formatWeekdayTime(ms, timeZone, locale);
}
```

`components/quota-meter.tsx`, next to `paceSentence`:

```tsx
function recentPaceSentence(model: DashboardModel, recent: RecentPace, t: Translator<"Widgets">, locale: string): string {
  const window = recent.changed
    ? t("recent_pace_since", { time: formatRecentMoment(recent.sinceMs, model.generatedAt, model.timeZone, locale) })
    : t("recent_pace_last_hours", { hours: Math.round((recent.untilMs - recent.sinceMs) / HOUR) });
  if (recent.ratio === 0) return t("recent_pace_idle", { window });
  const ratio = formatFactor(recent.ratio, locale);
  if (recent.runOutAt === null) return t("recent_pace_lasts", { window, ratio });
  return t("recent_pace_runs_out", {
    window,
    ratio,
    duration: formatDuration(recent.runOutAt - model.generatedAt, locale),
    moment: formatMoment(recent.runOutAt, model, locale),
  });
}
```

In `QuotaMeter`: `const recent = closed ? null : recentPace(model, view);` and in the open-cycle branch after `{paceSentence(...)}`: `{recent && <> {recentPaceSentence(model, recent, t, locale)}</>}`.

Messages (`Widgets`, after `run_out_estimation`):

| key | en | hu | de |
|---|---|---|---|
| `recent_pace_runs_out` | `Current pace ({window}, {ratio} the average): runs out in about {duration}, around {moment}.` | `Mostani tempó ({window}, {ratio} az átlaghoz képest): kb. {duration} múlva fogy el, {moment} körül.` | `Aktuelles Tempo ({window}, {ratio} des Durchschnitts): aufgebraucht in etwa {duration}, gegen {moment}.` |
| `recent_pace_lasts` | `Current pace ({window}, {ratio} the average): lasts until the reset.` | `Mostani tempó ({window}, {ratio} az átlaghoz képest): kitart a resetig.` | `Aktuelles Tempo ({window}, {ratio} des Durchschnitts): reicht bis zum Reset.` |
| `recent_pace_idle` | `Current pace: nothing used {window}.` | `Mostani tempó: {window} nincs fogyás.` | `Aktuelles Tempo: {window} nichts verbraucht.` |
| `recent_pace_since` | `since {time}` | `{time} óta` | `seit {time}` |
| `recent_pace_last_hours` | `over the last {hours, plural, one {hour} other {# hours}}` | `az elmúlt {hours} órában` | `in den letzten {hours, plural, one {Stunde} other {# Stunden}}` |

- [ ] **Step 4: Run** `npx vitest run tests/format.test.ts tests/components/quota-meter.test.tsx tests/messages.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat: say on the dashboard how long the budget lasts at the current pace`

### Task 3: `/api/status` `pace.recent`

**Files:**
- Modify: `lib/status.ts`, `clients/tests/fixtures/status-v1.json`, `docs/api.md`, `docs/superpowers/specs/2026-10-09-recent-pace-design.md` (the `until` addition)
- Test: `tests/integration/status.test.ts`

**Interfaces:**
- Consumes: `recentPace`, `RecentPace` (Task 1).
- Produces: `StatusProvider["pace"]["recent"]: { since: string; until: string; changed: boolean; ratio: number; runOutAt: string | null } | null` (ratio rounded to two decimals).

- [ ] **Step 1: Failing test** in `tests/integration/status.test.ts`: fake `Date` at 2026-09-23T12:00:00Z (the default cycle started Monday 2026-09-21T00:00Z, 60 h before), limit 10,000, one report of 2,500 → `pace.recent` equals `{ since: "2026-09-23T11:00:00.000Z", until: "2026-09-23T12:00:00.000Z", changed: true, ratio: 60, runOutAt: "2026-09-23T15:00:00.000Z" }`, and its keys match the fixture's `pace.recent`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/status.test.ts` → FAIL.
- [ ] **Step 3: Implement.** `paceOf(quota, recent)`:

```ts
function paceOf(quota: QuotaAssessment, recent: RecentPace | null): StatusProvider["pace"] {
  const { projectedTotal, runOutAt } = quota.pace;
  return {
    projectedPercent: projectedTotal === null ? null : percentOf(projectedTotal / quota.limit),
    runOutAt: runOutAt === null ? null : iso(runOutAt),
    recent: recent && {
      since: iso(recent.sinceMs),
      until: iso(recent.untilMs),
      changed: recent.changed,
      ratio: Math.round(recent.ratio * 100) / 100,
      runOutAt: recent.runOutAt === null ? null : iso(recent.runOutAt),
    },
  };
}
```

and `pace: view.quota ? paceOf(view.quota, recentPace(model, view)) : null`. Fixture: Claude's `pace` gains `"recent": { "since": "2026-10-07T07:00:00.000Z", "until": "2026-10-07T09:00:00.000Z", "changed": true, "ratio": 2.4, "runOutAt": "2026-10-07T18:00:00.000Z" }`. `docs/api.md`: the example and the `pace` bullet describe `recent`.
- [ ] **Step 4: Run** `npx vitest run tests/integration/status.test.ts` → PASS.
- [ ] **Step 5: Commit** `feat: send the recent pace to the menu bar app`

### Task 4: macOS card line

**Files:**
- Modify: `clients/macos/Sources/UsageRatioCore/StatusPayload.swift`, `Display.swift`, `Strings.swift`, `clients/macos/Sources/UsageRatioBar/PopoverView.swift`
- Test: `clients/macos/Tests/UsageRatioCoreTests/StatusPayloadTests.swift`, `DisplayTests.swift`

**Interfaces:**
- Consumes: the `pace.recent` JSON of Task 3.
- Produces: `StatusPayload.RecentPace { since: Date; until: Date; changed: Bool; ratio: Double; runOutAt: Date? }`, `Pace.recent: RecentPace?`, `Display.recentPaceText(_ provider:, now:, strings:) -> String?`, `Strings.recentSince/recentLastHours/recentRunsOut/recentLasts/recentIdle`.

- [ ] **Step 1: Failing tests.** The fixture decodes `claude.pace?.recent?.ratio == 2.4`; a payload without `recent` decodes with `recent == nil`. `recentPaceText`: nil without a percent or a `recent`; runs out → `"Current pace (since <jmm>, 2.4×): runs out in <duration>, <time>"`; lasts → `"…: lasts until the reset"`; idle → `"Current pace: nothing used since <time>"`; not changed → `"(in the last 8 h, "`.
- [ ] **Step 2: Run** `clients/macos/scripts/test.sh` → FAIL (compile errors).
- [ ] **Step 3: Implement.** `Pace` gets `public let recent: RecentPace?` and an explicit `public init(projectedPercent:runOutAt:recent: RecentPace? = nil)` (the synthesized decoder reads a missing key as nil). `Display.recentPaceText`: window from `strings.recentSince(moment)` or `strings.recentLastHours(hours)`; ratio formatted with `fractionLength(0...1)` + "×"; duration with a `DateComponentsFormatter` (`.abbreviated`, day/hour/minute, two units, the strings' locale); a moment is "jmm" on the same day as `now`, else `shortDate`. Strings:

| | en | hu | de |
|---|---|---|---|
| `recentSince` | `since \(t)` | `\(t) óta` | `seit \(t)` |
| `recentLastHours` | `in the last \(h) h` | `az elmúlt \(h) órában` | `in den letzten \(h) Std.` |
| `recentRunsOut` | `Current pace (\(w), \(r)): runs out in \(d), \(t)` | `Mostani tempó (\(w), \(r)): elfogy \(d) múlva, \(t)` | `Aktuelles Tempo (\(w), \(r)): aufgebraucht in \(d), \(t)` |
| `recentLasts` | `Current pace (\(w), \(r)): lasts until the reset` | `Mostani tempó (\(w), \(r)): kitart a resetig` | `Aktuelles Tempo (\(w), \(r)): reicht bis zum Reset` |
| `recentIdle` | `Current pace: nothing used \(w)` | `Mostani tempó: \(w) nincs fogyás` | `Aktuelles Tempo: \(w) nichts verbraucht` |

`PopoverView.facts`, right after the run-out label: `Label(text, systemImage: "bolt.fill")`, orange when `provider.pace?.recent?.runOutAt != nil`, else secondary, `.fixedSize(horizontal: false, vertical: true)`.
- [ ] **Step 4: Run** `clients/macos/scripts/test.sh` → PASS.
- [ ] **Step 5: Commit** `feat(macos): show the current pace on the menu bar card`

### Task 5: Verify

- [ ] `npm run check` (Biome, tsc, Vitest) green.
- [ ] Demo server (`DEMO_MODE=1`, a free port): the dashboard shows the sentence; `/api/status` carries `pace.recent`.
- [ ] Offscreen snapshot of the card with a `recent` line (scratch copy, as in earlier card work).

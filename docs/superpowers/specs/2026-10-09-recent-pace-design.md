# Recent pace — design

Date: 2026-10-09 · Status: approved in chat

## Goal

Today the pace is one figure: the cycle's average so far (`lib/quota.ts`: `total / elapsed`), and the
"runs out at …" sentence projects that average to the reset. A burst of heavy use shows up only
slowly, diluted by the whole cycle. The new figure looks at the last 8 hours, finds where the pace
changed, and says how long the budget lasts if the pace since then keeps up: "Current pace (since
14:00, 2.4× the average): runs out in about 9 hours, Thursday 23:10."

## Decisions (from the chat)

- Shown on the dashboard **and** in the macOS menu bar app (through `/api/status`).
- Shown **always** when there is a figure, not only when the pace sped up: also "lasts until the
  reset" and "nothing used since …".
- It never changes the status (good / warning / critical) or its colour: the cycle average still
  decides those.
- No new storage. The source is the hourly timeline the dashboard model already has.

## The figure — `lib/recent-pace.ts`

A pure function, `recentPace(model: DashboardModel, view: DashboardView): RecentPace | null`, used by
the server (`lib/status.ts`) and by the dashboard component, so the browser's recalculation after an
official reading is typed in (`components/ground-truth-input.tsx` → `applyGroundTruth`) moves it too.

```ts
interface RecentPace {
  /** Epoch ms: where the current pace began (the change point, or the window's start). */
  sinceMs: number;
  /** True when a change point was found; false when the whole window is one pace. */
  changed: boolean;
  /** The current pace over the cycle's average pace; 0 when nothing was used since `sinceMs`. */
  ratio: number;
  /** When the budget runs out at the current pace; null when it lasts until the reset (or the pace is 0). */
  runOutAt: number | null;
}
```

### Null — no line at all

- the cycle is closed (`model.closed`), or there is no `view.quota` (no token limit and no official
  reading), or nothing was used this cycle (`view.quota.total === 0`), or the budget is already gone
  (`total >= limit`);
- fewer than one whole hour of data in the window (below);
- the window ends more than 2 hours before `model.generatedAt`: every machine has gone silent, and a
  pace from hours ago would read as the current one.

### The window

- **End:** the last hourly sample of `model.timeline.times` at or before the provider's newest
  report (the largest `lastSeenAt` of `model.machines`). The hour that is still being reported
  never reads as idle time. The final sample of `times` ("now") is never an end: it is not on the
  hourly grid.
- **Start:** 8 hours before the end, but not before the cycle's start.
- **Bins:** the increments between consecutive hourly samples in the window, summed over
  `model.timeline.groups` (the same tokens as `model.total`, a separate sub-limit's left out).
  At most 8 bins, at least 1.

### The change point

With two or more bins, every split into an earlier and a later run (the later run at least one bin)
is scored by the squared error of fitting each run with its own mean. The split with the smallest
error wins. It counts as a change when the two means differ by a factor of 1.5 or more (a run with
mean 0 against one above 0 always counts). Then `sinceMs` is the later run's first sample and
`changed` is true. Otherwise the whole window is the current pace: `sinceMs` is the window's start,
`changed` is false. With one bin there is nothing to split: the whole window, `changed` false.

### Rate, ratio, run-out

- **Units:** the timeline counts measured tokens; the budget figure may be an official reading.
  Measured tokens are converted with `view.quota.total / model.total`: 1 when not calibrated,
  `view.scale` with the token limits on, the official fraction per measured token without them.
- **Current rate** = converted tokens from `sinceMs` to the window's end, divided by that duration.
- **Average rate** = `view.quota.total / (view.asOfMs - cycle start)`. `ratio` = current / average.
- **Run-out** = `view.asOfMs + view.quota.remaining / current rate`. It is null when the rate is 0 or
  when that moment is at or after the cycle's end.

## Dashboard — `components/quota-meter.tsx`

A second sentence right after the existing pace sentence, in the same paragraph, from the `Widgets`
namespace in all three locales (`messages/{en,hu,de}.json`, kept in parity):

- runs out: "Current pace (since 14:00, 2.4× the average): runs out in about 9 hours, around Thursday
  23:10."
- lasts: "Current pace (since 14:00, 0.4× the average): lasts until the reset."
- idle: "Current pace: nothing used since 18:00."
- with `changed` false the parenthesis reads "over the last 8 hours" (the window's real length when
  the cycle is younger than 8 hours) instead of "since 14:00".

"Since" is the time of day when it is the same day as the dashboard's moment, else weekday and time
(the dashboard's time zone). The duration uses `formatDuration`, the moment `formatCycleMoment`, the
ratio `formatFactor`.

## `/api/status`

`StatusProvider.pace` gains `recent`, added to v1 (an older app ignores it):

```ts
recent: {
  since: string;          // ISO 8601
  changed: boolean;
  ratio: number;          // rounded to two decimals
  runOutAt: string | null;
} | null;
```

`docs/api.md` documents the field.

## macOS app

- `StatusPayload.Pace` decodes `recent` with `decodeIfPresent` (an older server leaves it out).
- `Display.recentPaceText` builds the line; `Strings` gets its texts in en/hu/de.
- `PopoverView.facts` shows it right below the run-out line with the `bolt.fill` icon: orange when
  `runOutAt` is set, secondary otherwise. Example: "Current pace (since 14:00, 2.4×): runs out in ~9 h,
  23:10".

## Known limit

Machines report hourly, so a burst shows up after the next report, up to about an hour late. The
menu bar app's five-minute official Claude reading would be fresher, but it would need a stored
history of readings; out of scope.

## Testing

- `tests/recent-pace.test.ts`: null cases; window clamped to the cycle start; the change point (a
  2-hour burst after 6 quiet hours, a slowdown, steady use with no change, noise below 1.5×); idle;
  lasts vs runs out; official calibration with and without token limits; the 2-hour silence cut-off.
- `tests/status.test.ts` (or the existing status test): the `recent` field's shape and rounding.
- `tests/messages.test.ts` keeps the locales in parity and every key used.
- Swift: payload decoding with and without `recent`; `Display.recentPaceText` for the three cases.
- Hands-on: the demo server (`npm run dev:demo`) shows the sentence on the dashboard; the menu bar
  card is checked with an offscreen snapshot.

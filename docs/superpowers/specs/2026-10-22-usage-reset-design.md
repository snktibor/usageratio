# Usage reset — design

Date: 2026-10-22 · Status: approved in chat, awaiting review of this document

## Goal

Some providers occasionally reset a user's weekly usage, and they do it in two different ways:

- **Claude** clears the week's usage but keeps the week's own reset moment: the percentage drops to
  near 0 and the week still ends when it would have.
- **Codex (ChatGPT, provider id `openai`)** clears the usage and makes the reset moment the new
  weekly reset: a fresh 7-day window starts right then.

Today the dashboard cannot represent either. After a Claude reset, the official percentage (now
small) is split over the whole week's measured tokens, so every group and machine share is wrong.
After a Codex reset, the menu bar app's report moves the provider's reset moment
(`resetOverrides`, `source: "report"`). The cycle before it is then worked out backwards from the
new moment (`R − 7 days → R`), so the archive and the past-cycle list get wrong boundaries.

This feature records resets. It can be set up per provider which way the provider resets. It shows
the current, post-reset percentage while keeping the pre-reset usage visible, and it restates the
tokens per stretch of the week. In past cycles it adds a week's percentages together, so a week can
reach 200%.

## Decisions (from the chat)

- **Codex-type resets end the cycle.** The old cycle closes at the reset with its own final
  percentage and is marked "ended by a reset". A full 7-day cycle starts at the reset, and later
  cycles follow its weekday and time. Only Claude-type resets add percentages up, because they split
  one week into stretches.
- **Recording:** by hand on the dashboard, back to the start of the current cycle at the earliest,
  editable and deletable. The server also detects resets **automatically** from the menu bar app's
  readings (thresholds below). A wrongly detected reset can be **reverted**.
- **Dragging the dashboard's own percentage down never records a reset by itself.** Below 10%, and
  at least 5 points under the figure saved before the edit, a "Was there a reset?" button appears.
  Yes records one.
- **Current cycle after a Claude-type reset:** everything (meter, pace, groups, machines) shows the
  stretch since the reset. A line under the meter states the pre-reset usage and the week's total.
  The chart shows the whole week, restarting from 0 at each reset.
- **Past cycles:** the stretches' percentages are added up (up to 200% and beyond). The groups'
  quota shares are worked out per stretch.
- **Architecture:** reset events in a store of their own (`usage:resets`), with a stretch
  ("segment") layer over the existing cycles. The per-provider reset type is a setting.

## Terms

- **R:** the moment of a reset, a whole minute.
- **Segment:** a stretch of a cycle between its start, its Claude-type resets, and its end:
  `[S, R1)`, `[R1, R2)`, …, `[Rn, E)`. A cycle without resets is one segment. The **current
  segment** is the last one of the current cycle.
- **before:** the provider's official percentage just before a reset, which is the final figure of
  the segment (or cycle) the reset closed.

## Setting — the reset type

`UsageSettings.resetModes: Record<providerId, "keep" | "restart">`, in the settings document
(`usage:settings`), parsed leniently like `resetOverrides`. A document without it resolves to the
defaults. `lib/settings.ts` `resetModeOf(config, providerId)` returns the stored mode, else the
default: `claude` and `anthropic` → `keep`, `openai` → `restart`, anything else → `keep`.
`AppConfig.resetModes` carries it.

On the settings page, the reset section's per-provider rows get a select for each provider: "After
a reset: the weekly reset stays / the reset becomes the new weekly reset". It is saved with the rest
of the panel.

`ResetOverride.source` gains `"reset"` next to `"report"`: set by a Codex-type reset. The panel shows
a note for it the way it does for `"report"`, and drops it on edit.

## Storage — `usage:resets`

`usage:resets` HASH, providerId → JSON:

```ts
interface ProviderResets {
  v: 1;
  events: ResetEvent[]; // sorted by atMs
  /** Automatic detection is off for the cycle that starts here (set by a revert); null: on. */
  autoOffCycleStartMs: number | null;
}

interface ResetEvent {
  id: string; // random, for edits and deletes
  atMs: number; // R
  kind: "keep" | "restart"; // the provider's mode when it was recorded
  /** S: the start of the cycle it happened in (for a restart: the cycle it cut short). */
  cycleStartMs: number;
  /** 0–100, the share used right before it; null while unknown. */
  before: number | null;
  /** When `before` was read; null when typed in the reset form. */
  beforeAtMs: number | null;
  source: "manual" | "report";
  recordedAtMs: number;
  /** Restart only: the provider's own reset before it; null: it used the shared one. */
  previousOverride?: ResetOverride | null;
}
```

Pure parsing, validation and the segment arithmetic live in `lib/resets.ts`. The Redis side
(`loadResets` as part of `loadIndexes`, `saveResets`) lives in `lib/usage-store.ts`, and
`lib/redis-keys.ts` documents the key. Writes are a read-modify-write of one provider's field. Two
writers can collide (a report detecting a reset while someone edits one by hand), and the last one
wins. That is the same accepted risk as `saveResetOverride`.

**Pruning** (housekeeping, `lib/housekeeping.ts`): a `keep` event is dropped once `atMs` is older
than the provider's previous cycle start. By then its cycle is archived and the archived summary
carries what it needs. A `restart` event is kept longer, until `atMs` is older than the raw-report
retention (`RETENTION_DAYS`, 70 days): the past-cycle detail view re-reads raw reports, and it needs
the restart to drop the stale-basis snapshot reports of the cycle the restart began for as long as
those reports exist. `autoOffCycleStartMs` is cleared once that cycle is over. Housekeeping writes
the pruned copy of a fresh read, so a reset recorded during the run is not lost.

## Cycles and segments

### Claude-type (`keep`)

The cycle stays as the reset settings make it. Its `keep` events (`cycleStartMs === S`) split it into
segments. `lib/resets.ts` `segmentsOf(cycle, events)` returns them.

### Codex-type (`restart`)

Recording a restart at R in the cycle `[S, E)` does the following:

- It sets the provider's own reset (`resetOverrides[providerId]`) to R's weekday, month day, hour and
  minute in the reset time zone, with `source: "reset"`, and remembers the previous own reset in
  `previousOverride`.
- `lib/provider-cycles.ts` `providerCycle` takes the provider's reset events. When the current
  cycle starts exactly at a restart event's `atMs`, `previous` is `[event.cycleStartMs, R)` instead
  of the cycle worked out backwards. Everything that already uses `providerCycle().previous` (the
  archive, the footer's comparison, counter mode's baseline, `earliestStartMs`) then reads the right
  window.
- `providerCycleOptions` (`lib/cycle-options.ts`) offers `[S, R)` as the cycle before the current
  one, and works out older ones under the old schedule (`previousOverride`, or the shared reset).
  Archived cycles keep winning over worked-out ones, as today.

### The counting basis of snapshot reports

In snapshot mode (the default) a machine reports its running total since the cycle start it asked
the server for (`GET /api/usage`). Reports made between R and the moment the server learns of the
reset still count from S. Once R starts a new cycle, those reports would inflate it for good,
because snapshot mode takes the largest report of the cycle. The same happens to every machine
that reported in between, so a reset recorded a day late would put the whole previous week's tokens
into the new cycle.

To fix this, every stored event member gets the counting basis the server gave its client: `"s"`,
the provider's cycle start at ingest (`lib/ingest.ts`; reports and their checkpoints alike).
`UsageEvent.basisMs` carries it when read. In a cycle that starts at a restart reset, snapshot-mode
events of that provider stamped with another basis are ignored (`lib/resets.ts`
`dropStaleBasis`). Every reader that sums up such a cycle (the dashboard, `/api/status`, the
archive, the alerts, the export) loads the provider's resets to know this. Members stored before this change have no stamp and are read as today. Delta and
counter modes are unaffected. Machines re-send their hourly checkpoints with every report, so their
next report after the reset fills the gap. For a provider without hourly splits the gap is filled
per day.

The stamp is set by the server, not the client, so no client update is needed. A report computed
just before a reset and stored just after it gets the new basis. That race lasts seconds, and the
result is at worst the status quo.

### The official figure's tag

`usage:official` entries are tagged with the **segment** start instead of the cycle start (for a
cycle without resets these are the same, so stored entries need no migration). Every reader that
asks "is this entry current" compares against the current segment's start:
`currentOfficialEntries`, the report decision, `checkOfficialUsageAlerts` and housekeeping. The
dashboard sends the segment's start with a typed figure.

**Retag rule:** whenever a cycle's resets change (recorded, edited, deleted, detected), the server
retags the provider's stored entries, its own and its sub-limits', to the segment their
`enteredAt` falls in. An entry that ends up in an earlier segment is no longer current. Its value is
the natural `before` of the reset that closed that segment. The "Was there a reset?" path writes a
fresh entry at R instead (see below).

Stored entries also keep the report's `resetsAtMs` when they come from
`POST /api/official-usage/report`. Automatic detection relies on it. A typed figure overwrites the
entry without one.

## Recording — `/api/resets`

All three methods need the dashboard session and the same origin. All three are refused in demo
mode (`demo_read_only`). Validation lives in `lib/resets.ts`, and the routes stay thin.

- **`POST /api/resets`** `{ providerId, atMs, before?, afterRaw? }`
  - `atMs` must be a whole minute after the current cycle's start and no later than now
    (409 `outside_cycle`), and not the minute of an existing reset (409 `duplicate_reset`).
  - A `keep` reset may fall anywhere in that range, even between earlier ones. A `restart` must
    come after the cycle's last `keep` reset (409 `has_later_resets`), because it ends the
    cycle.
  - The kind is the provider's current mode.
  - `before`: 0–100 or null. When absent, the server takes the stored entry if it was read before
    `atMs`.
  - `afterRaw` (from the "Was there a reset?" button): the figure to store for the new segment or
    cycle, entered at `atMs`.
  - A restart moves the provider's reset as described above.
- **`PUT /api/resets`** `{ providerId, id, atMs?, before? }`
  - Edits a reset of the current cycle: a `keep` event of the current cycle, or the `restart`
    event the current cycle started with.
  - A restart's new `atMs` must stay after its `cycleStartMs` and before the cycle's first `keep`
    reset, and the cycle it starts must still be the current one: moved back by a cycle's length it
    would end by now (409 `outside_cycle`). Editing it moves the provider's reset again.
- **`DELETE /api/resets`** `{ providerId, id, revert? }`
  - A `keep` reset's segments merge.
  - A `restart` puts `previousOverride` back, but only if the provider's own reset is still the one
    the restart set. Otherwise someone changed it on the panel since, and it is left alone. A
    restart with `keep` resets after it is refused (409 `has_later_resets`).
  - `revert: true` is only for `source: "report"`. On top of the delete, it writes `before` back as
    the current figure (`enteredAt: beforeAtMs`, retagged by the rule above) and sets
    `autoOffCycleStartMs` to the restored cycle's start.

Every successful call retags the official entries and answers
`200 { ok, events, cycle: { startMs, endMs } }`, so the page can refresh. The page then reloads
(`router.refresh()`), as it does for other saves.

## Automatic detection — `POST /api/official-usage/report`

`lib/official-report.ts` `decideOfficialReport` gets the provider's mode, its reset events and
`autoOffCycleStartMs`. Detection only compares two report readings: a stored entry with a
`resetsAtMs`, which is current (tagged with the current segment start), and the new report, which
must be newer than it. Typed figures never trigger it. Detection is off for the cycle in
`autoOffCycleStartMs`. The checks run in this order:

1. **Restart (mode `restart`):** the stored reading's `resetsAtMs` matched the current cycle end
   (±15 min), the new one is more than 15 min later, and `R = resetsAtMs − 7 days`, rounded to the
   minute, falls after the cycle start and no later than the reading.
   → A restart at R, with `before` the stored percentage (and its time) and `source: "report"`. The
   reading is stored for the new cycle.
2. **Otherwise the existing alignment:** a cycle end more than 15 min away from `resetsAtMs` moves
   the provider's reset to the window's, without a reset event (as today). While detection is off
   for the cycle, a reading whose window ends elsewhere is neither stored nor used to move anything:
   `200 { saved: false, cycleChanged: false }`, so the menu bar app shows no error.
3. **Keep (mode `keep`), in an aligned cycle:** the same `resetsAtMs` as the stored reading
   (±15 min), and the new percentage at least **5 points** lower.
   → A keep reset at the reading's `observedAtMs` rounded down to the minute. This is an upper bound:
   the reset happened between the two readings, and the time can be corrected by hand. `before` is
   the stored percentage and its time, and the source is `"report"`. The reading is stored for the
   new segment. No detection when that minute is not after the current segment's start.

The response gains `detectedReset: { id, kind, atMs } | null` for a detected reset. Its existing
`reset` field (`{ weekday, hour, minute } | null`, the provider's moved reset, which the menu bar
app decodes) stays as it is. The app ignores unknown fields and needs no change.

Known limits: two Claude accounts with the same reset moment reporting alternately would look like
resets, and the revert covers that. A deleted (not reverted) real Codex reset is re-aligned without
an event by the next reading, as today.

## The current cycle on the dashboard

**Model** (`lib/dashboard.ts`, `buildProviderDashboards`): each provider's model gets its segments
and resets: `resets: { id, atMs, kind, before, source }[]` (this cycle's `keep` events and the
`restart` the cycle began with) and `segment: { startMs, endMs }`.

- Totals, groups, machines, the token-limit quota and the cost estimate count the current segment
  only. This is the per-series difference of the cumulative usage from the cycle start, which is
  right in every token mode (snapshot reports are running totals since S).
- The pace and the "runs out" projection use the window `[segment start, cycle end)`.
- The recent pace (`lib/recent-pace.ts`) never looks back past the segment start.
- The meter's ruler (`CycleRuler`) covers the segment as well, so the fill and the time marker
  compare the same window. The full week stays visible on the chart.
- The timeline keeps the whole cycle.
- The official reading restates the segment's groups and machines (`applyGroundTruth`, unchanged
  in shape).
- Sub-limits follow the segment the same way. Their pre-reset figures are not kept.

**Meter line** (`QuotaMeter`): under the main figure, when the cycle has `keep` resets:
"Reset Wed 14:00 · before it 80% · this week in total 100%". Several resets list each reset's time
and before figure, and the total adds up every `keep` reset's `before` and the current figure. An
unknown `before` is shown as "–" and left out of the total. A restart's `before` belongs to the
previous cycle and is never part of this total. A cycle that began with a restart says so in the
reset list only.

**Chart** (`UsageChart`, `CycleChart`): the whole cycle with a vertical marker at each reset. Every
line restarts from 0 at a reset. With an official reading, each finished segment is scaled by its
`before` (its measured tokens over that segment) and the current one by the current figure. A
finished segment without a `before` is drawn measured-only (faint).

**Recording UI** (`components/reset-panel.tsx`, next to the official field; current cycle only):

- A "There was a reset…" button opens an inline form:
  - when: `datetime-local` in the reset time zone, defaulting to now, limited to the cycle start
    and now;
  - "used before the reset" (%): prefilled from the stored figure if it was read before that
    moment;
  - the provider's reset type shown as plain text, with a link to the setting.
- Under it, this cycle's resets: time, before %, "detected by the menu bar app" for
  `source: "report"`, and per row **Edit** and **Delete**, or **"Wrong – revert"** for a detected
  one.
- After a Codex-type reset, the page shows the new cycle and the old one moves to the past cycles.

**"Was there a reset?"** (`GroundTruthInput`): when the current cycle's own field is edited down
below 10%, at least 5 points under the figure it held when the edit began, a button appears under
it. Yes posts `{ atMs: now, before: the figure before the edit, afterRaw: the new figure }`.
Ignoring it leaves a plain correction. It never shows on a closed cycle's correction field.

**Menu bar card** (`GET /api/status`): built from the same model, so its percentage, pace and tokens
follow the segment without a new field. `cycle` stays the provider's cycle. The Swift app is not
changed.

**Alerts** (`lib/alerts.ts`): the guard key's `cycleStartMs` becomes the segment start, so the
thresholds can fire again after a reset. `checkIngestAlerts` measures the segment (with resets
loaded). `checkOfficialUsageAlerts` checks the update against the segment start.

## Past cycles

**Archived summary** (`lib/history.ts` `CycleSummary`, still `v: 1`, new optional fields):

```ts
segments?: { start: number; end: number; official: number | null; total: number; groups: Record<string, number> }[];
endedByReset?: true;
```

- `segments` is present only when the cycle had `keep` resets. A finished segment's `official` is
  its reset's `before`. The last segment's is the figure tagged with its start
  (`officialPercentForCycle` with the segment start).
- `official` is the sum of the segments' known figures, so it can exceed 100. It is null only when
  none is known.
- `total`, `groups` and the rest stay whole-cycle.
- A cycle cut short by a restart gets `endedByReset: true` and `official` from the restart's
  `before`, falling back to the figure tagged with S.
- The archive (`lib/archive.ts`) reads the provider's reset events, which the pruning rule keeps
  until this point, and drops stale-basis events for a cycle that began at a restart.

**History list and chart** (`components/cycle-history.tsx`):

- The final figure reads "100% (80% + 20%)" when there are segments.
- A cut cycle carries an "ended by a reset" label.
- The chart's axis already grows past 100% (`niceScale`).
- `groupSharesOf` / `finalUsageOf` split per segment: each segment's figure by that segment's group
  tokens, added up. A segment without a figure contributes nothing.

**Detail view** of a closed cycle that still has raw reports:

- The main figure is the sum.
- Groups and machines get the per-segment restatement added up: each one's share of each
  segment, times that segment's figure.
- The chart has the reset markers.
- The dashboard model of a closed cycle carries the per-segment group and machine tokens for this.

**Correction:** a closed cycle with segments gets one field per segment.
`PUT /api/official-usage/archived` takes an optional `segmentStartMs`, rewrites that segment's
figure and recomputes `official`. Without segments it behaves as today.

## Demo data

`lib/demo/dataset.ts` gets one Claude keep reset in the current week (with `before` and a
post-reset figure), so the demo dashboard and the e2e test show the meter line, the chart markers
and the reset list.

## Testing

- **Vitest (pure):**
  - `segmentsOf`, the segment usage difference in all three token modes, `dropStaleBasis`;
  - `providerCycle` and `providerCycleOptions` with a restart;
  - the retag rule;
  - recording validation (bounds, kinds, edits, deletes, reverts, `has_later_resets`);
  - every detection branch of `decideOfficialReport` (thresholds, ±15 min, detection off,
    alignment unchanged);
  - `summarizeCycle` with segments, `groupSharesOf` and `finalUsageOf` above 100%;
  - settings parsing of `resetModes`, the alert guard per segment, housekeeping pruning.
- **Routes:** `/api/resets` (auth, origin, demo refusal, payload errors), the report route with a
  detected reset, the archived correction with `segmentStartMs`.
- **Components:** the meter line, the reset panel, the "Was there a reset?" button's threshold.
- **i18n:** en/hu/de keys in parity (`tests/messages.test.ts`).
- **e2e:** the demo dashboard shows the reset line and list.
- **By hand, before calling it done:** record, edit, delete and revert a reset on a scratch copy
  (see the local UI verification notes), and drag the figure down to see the button.

## Out of scope (suggestions for later)

- Recording a reset into an already finished cycle. Recording goes back to the current cycle's
  start only.
- Showing the reset on the macOS menu bar card.
- Keeping sub-limits' pre-reset figures.

## Plans

1. **Core:** `lib/resets.ts`, storage and pruning, `resetModes`, the cycle and segment arithmetic,
   the basis stamp, `/api/resets`, automatic detection, alerts, archiving with segments.
2. **Current cycle UI:** the model's segment, the meter line, the chart markers, the reset panel,
   "Was there a reset?", the settings select, en/hu/de.
3. **Past cycles:** the history list and chart, the detail view, the per-segment correction, demo
   data, e2e.

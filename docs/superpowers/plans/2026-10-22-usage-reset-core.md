# Usage reset — core (plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record provider usage resets on the server — the per-provider reset type, the `usage:resets`
store, the segment and cycle arithmetic, the counting-basis stamp, `/api/resets`, automatic detection
from the menu bar app's readings, segment-aware alerts, and archiving with segments.

**Architecture:** Pure logic in `lib/resets.ts` (model, segments, basis) and `lib/reset-recording.ts`
(request parsing and the record/edit/delete rules); the Redis side in `lib/usage-store.ts` and
`lib/reset-store.ts`; thin routes. Existing readers (dashboard page, status, export, alerts, archive,
housekeeping) load the resets with `loadIndexes()` and pass them on. The dashboard's segment view
(meter, chart, reset panel) is plan 2; the past-cycle UI is plan 3.

**Tech Stack:** Next.js 16 App Router (route handlers), TypeScript, Upstash Redis REST client
(in-memory store in tests), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-usage-reset-design.md`

## Global Constraints

- Branch `feat/usage-reset`; never commit on `main`; do not push or open a PR in this plan.
- Conventional Commits. **No AI attribution in any commit message**: no `Co-Authored-By` naming an AI,
  no "Generated with …" line, nothing saying the commit was AI-assisted.
- Pure logic in `lib/`, tests in `tests/`, `app/api/**/route.ts` stays thin and uses `lib/api.ts`.
- No new dependencies. No UI text in this plan (plan 2 adds the `messages/*.json` keys).
- Default reset modes: `claude` and `anthropic` → `"keep"`, `openai` → `"restart"`, anything else → `"keep"`.
- Thresholds: window match tolerance `RESET_TOLERANCE_MS` = 15 min (existing); keep detection needs a drop of
  at least **5 points** (`RESET_DROP_POINTS`); a restart's R is `resetsAtMs − 7 days`, rounded to the minute;
  a keep reset's R is the reading's `observedAtMs` rounded down to the minute.
- R is always a whole minute; recording reaches back to the current cycle's start only.
- The macOS app is not changed: `POST /api/official-usage/report` keeps its `reset: {weekday, hour, minute} | null`
  field as is (the Swift client decodes it as "moved to"). The detected reset goes in a **new** field,
  `detectedReset: { id, kind, atMs } | null`. (The spec named it `reset`; that name is taken.)
- `npm run check` (Biome + `tsc --noEmit` + Vitest) passes at the end of every task.
- Run single test files with `npx vitest run <file>`.

## Deviations from the spec (found while planning)

1. The report response field is `detectedReset`, not `reset` (see above).
2. Editing or deleting a restart deletes the archived summary of the cycle it cut short
   (`usage:history:{provider}` member scored at that cycle's start). The next dashboard read or housekeeping
   run archives it again with the right end and figure. Without this, a deleted restart would leave a
   summary overlapping the restored current cycle, and the real cycle would never be archived.
3. Until plan 2, the dashboard still sends the cycle start (not the segment start) with a typed figure.
   Nothing in plan 1's UI records a keep reset, so this only matters on the branch between the plans.

## File structure

| File | Responsibility |
| --- | --- |
| `lib/config.ts` | `ResetMode` type, `ResetOverride.source` gains `"reset"`, `AppConfig.resetModes` |
| `lib/settings.ts` | `resetModes` in the settings document, `resetModeOf`, `ownResetOf`, `withResetOverride`, `readStoredResetOverride` |
| `components/settings/draft.ts` | carries `resetModes` through a panel save (the select comes in plan 2) |
| `lib/resets.ts` (new) | the reset model: parse/serialize, segments, `cycleBefore`, restart override, `dropStaleBasis`, pruning |
| `lib/reset-recording.ts` (new) | `/api/resets` body parsing, `recordReset` / `editReset` / `deleteReset`, `beforeFromStored`, the retag rule |
| `lib/reset-store.ts` (new) | applies one change to Redis; records a detected reset |
| `lib/provider-cycles.ts` | `providerCycle(…, resets)`, `currentSegmentStartMs`, `officialTagAt` |
| `lib/cycle-options.ts` | a restart's cut-short cycle in the cycle list |
| `lib/aggregate.ts` | `summarizeUsage(…, fromMs)`: a segment's usage |
| `lib/usage-store.ts` | `usage:resets` load/save, the `"s"` basis stamp, `loadEvents(…, resets)`, small writers |
| `lib/redis-keys.ts` | `KEYS.resets`, key docs |
| `lib/official-usage.ts` | stored entries keep a report's `resetsAtMs` |
| `lib/official-report.ts` | automatic detection in `decideOfficialReport` |
| `lib/alerts.ts` | the guard key and measurement follow the segment |
| `lib/history.ts`, `lib/archive.ts` | `CycleSummary.segments` / `endedByReset`, archiving with resets |
| `lib/housekeeping.ts` | prunes resets, official step by segment |
| `app/api/resets/route.ts` (new) | POST/PUT/DELETE |
| `app/api/official-usage/report/route.ts` | detection wiring, `detectedReset` |
| `app/[locale]/(dashboard)/page.tsx`, `lib/status.ts`, `app/api/export/route.ts` | pass resets to the readers |
| `lib/api.ts` | four new error codes |
| `docs/api.md`, `docs/data-model.md` | documentation |

---

### Task 1: The reset-mode setting

**Files:**
- Modify: `lib/config.ts` (`ResetOverride`, `AppConfig`, `getConfig`)
- Modify: `lib/settings.ts`
- Modify: `components/settings/draft.ts`
- Modify: `app/api/settings/route.ts` (doc comment only)
- Modify: `docs/data-model.md` (the settings document)
- Test: `tests/settings.test.ts`, `tests/settings-draft.test.ts`

**Interfaces:**
- Produces: `type ResetMode = "keep" | "restart"` (lib/config.ts); `ResetOverride.source?: "report" | "reset"`;
  `AppConfig.resetModes: Record<string, ResetMode>`; `UsageSettings.resetModes`;
  `resetModeOf(config: Pick<AppConfig, "resetModes">, providerId: string): ResetMode`;
  `ownResetOf(config: AppConfig, providerId: string): ResetOverride | null`;
  `withResetOverride(config: AppConfig, providerId: string, override: ResetOverride | null): AppConfig`;
  `readStoredResetOverride(value: unknown): ResetOverride | null`.

- [ ] **Step 1: Write the failing tests**

In `tests/settings.test.ts`, extend the imports from `@/lib/settings` with `ownResetOf`, `resetModeOf`,
`resolveConfig` (if not already imported) and `withResetOverride`, then append:

```ts
describe("reset modes", () => {
  it("defaults Claude to keep and Codex (openai) to restart, anything else to keep", () => {
    expect(resetModeOf(config, "claude")).toBe("keep");
    expect(resetModeOf(config, "anthropic")).toBe("keep");
    expect(resetModeOf(config, "openai")).toBe("restart");
    expect(resetModeOf(config, "deepseek")).toBe("keep");
  });

  it("reads stored modes leniently: a stored mode wins, a bad entry is dropped on its own", () => {
    const resolved = resolveConfig(
      config,
      JSON.stringify({ resetModes: { Claude: "restart", openai: "sideways", "!!": "keep" } }),
    );
    expect(resolved.resetModes).toEqual({ claude: "restart" });
    expect(resetModeOf(resolved, "claude")).toBe("restart");
    expect(resetModeOf(resolved, "openai")).toBe("restart");
  });
});

describe("withResetOverride / ownResetOf", () => {
  it("sets, replaces and removes one provider's own reset", () => {
    const own = { weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" as const };
    const set = withResetOverride(config, "openai", own);
    expect(ownResetOf(set, "openai")).toEqual(own);
    expect(ownResetOf(withResetOverride(set, "openai", null), "openai")).toBeNull();
    expect(ownResetOf(config, "openai")).toBeNull();
  });
});
```

Inside `describe("parseSettingsUpdate", …)`: add `resetModes: {},` to the `valid` object (after
`resetOverrides`), and add these tests:

```ts
  it("requires resetModes, normalizes its ids and checks every mode", () => {
    const { resetModes: _, ...missing } = valid;
    expect(parseSettingsUpdate(missing)).toMatchObject({ ok: false });
    const ok = parseSettingsUpdate({ ...valid, resetModes: { Claude: "restart" } });
    if (!ok.ok) throw new Error(ok.errors.join("; "));
    expect(ok.update.settings.resetModes).toEqual({ claude: "restart" });
    const bad = parseSettingsUpdate({ ...valid, resetModes: { claude: "sideways" } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toContain('resetModes.claude must be "keep" or "restart"');
  });

  it("accepts a restart's source marker on an override", () => {
    const result = parseSettingsUpdate({
      ...valid,
      resetOverrides: { openai: { weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" } },
    });
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.update.settings.resetOverrides.openai?.source).toBe("reset");
  });
```

In the existing test "accepts a report's source marker on an override, and nothing else there", change the
expected message to `'resetOverrides.claude.source must be "report" or "reset", or absent'`.

In `tests/settings-draft.test.ts`, append inside `describe("toRequest", …)`:

```ts
  it("keeps the stored reset modes through a save", () => {
    const withModes = buildSettingsView({ ...config, resetModes: { claude: "restart" } }, [], ["claude", "deepseek"]);
    const result = toRequest(draftFrom(withModes));
    if (!("request" in result)) throw new Error(result.problem.code);
    expect(result.request.resetModes).toEqual({ claude: "restart" });
    expect(parseSettingsUpdate(result.request).ok).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/settings.test.ts tests/settings-draft.test.ts`
Expected: FAIL — `resetModeOf`, `ownResetOf`, `withResetOverride` are not exported; `resetModes` is undefined.

- [ ] **Step 3: Implement `lib/config.ts`**

Above `export interface ResetOverride`, add:

```ts
/**
 * How a provider resets a user's usage early (lib/resets.ts): "keep" keeps the
 * week's own end (Claude), "restart" makes the reset the new weekly reset (Codex).
 */
export type ResetMode = "keep" | "restart";
```

Replace the `source` field of `ResetOverride` with:

```ts
  /**
   * Who set it, when not the panel: "report", an official report aligning the
   * cycle to the provider's window (lib/official-report.ts); "reset", a
   * restart-type reset (lib/resets.ts). The panel drops it on edit.
   */
  source?: "report" | "reset";
```

In `AppConfig`, after `resetOverrides`, add:

```ts
  /** providerId → how it resets early; a provider without an entry gets its default (lib/settings.ts `resetModeOf`). */
  resetModes: Record<string, ResetMode>;
```

In `getConfig`'s returned object, after `resetOverrides: {},`, add `resetModes: {},`.

- [ ] **Step 4: Implement `lib/settings.ts`**

Add `type ResetMode,` to the `@/lib/config` import. In `UsageSettings`, after `resetOverrides`, add:

```ts
  /**
   * providerId → how it resets a user's usage early (lib/resets.ts). A provider
   * without an entry gets its default: `resetModeOf`.
   */
  resetModes: Record<string, ResetMode>;
```

In `readResetOverride`, replace the `source` check and assignment:

```ts
    // The stored reader (no `errors`) ignores a bad marker; the PUT parser reports it.
    if (entry.source !== undefined && entry.source !== "report" && entry.source !== "reset" && errors) {
      problems.push(`${field}.source must be "report" or "reset", or absent`);
    }
```

```ts
  if (source === "report" || source === "reset") override.source = source;
```

After `parseResetOverrides`, add:

```ts
/** One stored override, leniently (a reset event's `previousOverride`, lib/resets.ts); null when it does not hold up. */
export function readStoredResetOverride(value: unknown): ResetOverride | null {
  return readResetOverride(value, "resetOverride");
}

const RESET_MODES: readonly ResetMode[] = ["keep", "restart"];

function isResetMode(value: unknown): value is ResetMode {
  return (RESET_MODES as readonly unknown[]).includes(value);
}

/** What a provider without a stored mode gets: Claude keeps its week, Codex (openai) starts a new one. */
const DEFAULT_RESET_MODES: Readonly<Record<string, ResetMode>> = {
  claude: "keep",
  anthropic: "keep",
  openai: "restart",
};

/** How `providerId` resets early: the stored mode, else its default, else "keep". */
export function resetModeOf(config: Pick<AppConfig, "resetModes">, providerId: string): ResetMode {
  if (Object.hasOwn(config.resetModes, providerId)) return config.resetModes[providerId]!;
  return Object.hasOwn(DEFAULT_RESET_MODES, providerId) ? DEFAULT_RESET_MODES[providerId]! : "keep";
}

/** The stored map, leniently: an unknown provider id or mode is dropped on its own. */
function readResetModes(stored: Record<string, unknown>): Record<string, ResetMode> {
  const modes: Record<string, ResetMode> = {};
  for (const [rawProvider, mode] of Object.entries(stored).slice(0, MAX_PROVIDERS)) {
    const providerId = normalizeProviderId(rawProvider);
    if (providerId && isResetMode(mode) && !Object.hasOwn(modes, providerId)) modes[providerId] = mode;
  }
  return modes;
}

/** The PUT body's map: every problem is reported. */
function parseResetModes(value: unknown, errors: string[]): Record<string, ResetMode> {
  const body = asRecord(value);
  if (!body || Object.keys(body).length > MAX_PROVIDERS) {
    errors.push(`resetModes must be a JSON object of at most ${MAX_PROVIDERS} providers`);
    return {};
  }
  const modes: Record<string, ResetMode> = {};
  for (const [rawProvider, mode] of Object.entries(body)) {
    const providerId = normalizeProviderId(rawProvider);
    if (!providerId) errors.push(`resetModes.${rawProvider} has an invalid provider id`);
    else if (Object.hasOwn(modes, providerId)) errors.push(`resetModes.${rawProvider} is listed twice after normalization`);
    else if (!isResetMode(mode)) errors.push(`resetModes.${providerId} must be "keep" or "restart"`);
    else modes[providerId] = mode;
  }
  return modes;
}
```

In `settingsFromConfig` add `resetModes: { ...config.resetModes },` after `resetOverrides`. In
`applySettings` add `resetModes: { ...settings.resetModes },` after `resetOverrides`. In
`parseStoredSettings`, next to `storedOverrides`, add `const storedModes = asRecord(doc.resetModes);` and in
the returned object, after `resetOverrides`:

```ts
    // Documents saved before reset modes existed lack the field: every provider gets its default.
    resetModes: storedModes ? readResetModes(storedModes) : defaults.resetModes,
```

In `parseSettingsUpdate`, after `const resetOverrides = …`, add `const resetModes = parseResetModes(body.resetModes, errors);`
and add `resetModes,` after `resetOverrides,` in the returned `settings`.

After `resetFor`, add (and let `resetFor` use `ownResetOf`):

```ts
/** The reset one provider's cycle runs on: its override over the shared period and time zone. */
export function resetFor(config: AppConfig, providerId: string): ResetConfig {
  const override = ownResetOf(config, providerId);
  return override ? { ...config.reset, ...override } : config.reset;
}

/** The provider's own reset, if it has one; null: it uses the shared one. */
export function ownResetOf(config: AppConfig, providerId: string): ResetOverride | null {
  return Object.hasOwn(config.resetOverrides, providerId) ? config.resetOverrides[providerId]! : null;
}

/** `config` with `providerId`'s own reset set to `override`, or removed (null). */
export function withResetOverride(config: AppConfig, providerId: string, override: ResetOverride | null): AppConfig {
  const { [providerId]: _, ...others } = config.resetOverrides;
  return { ...config, resetOverrides: override ? { ...others, [providerId]: override } : others };
}
```

- [ ] **Step 5: Carry `resetModes` through the panel's draft**

In `components/settings/draft.ts`: add `type ResetMode` to the `@/lib/config` import. Change
`DraftOwnReset.source` to `source?: "report" | "reset";`. In `Draft`, after `resetOverrides`, add:

```ts
  /** providerId → how it resets early; only the stored entries (lib/settings.ts `resetModeOf` fills in defaults). */
  resetModes: Record<string, ResetMode>;
```

In `SettingsRequest`, after `resetOverrides`, add `resetModes: Record<string, ResetMode>;`. In `draftFrom`,
destructure `resetModes` from `view.settings` and add `resetModes: { ...resetModes },` after the
`resetOverrides` entry of the returned draft. In `toRequest`'s returned `request`, add
`resetModes: { ...draft.resetModes },` after `resetOverrides,`.

In `app/api/settings/route.ts`'s doc comment, add under the PUT body, after the `reset` line:

```
 *            "resetOverrides": { "openai": { "weekday": 2, … } },  providers' own resets
 *            "resetModes": { "claude": "keep" },                 how a provider resets early (lib/resets.ts)
```

In `docs/data-model.md`, add `resetModes` to the `usage:settings` row's field list (after `resetOverrides`)
and, in "The settings document" section after the `resetOverrides` paragraph, add:

```md
`resetOverrides` entries may also carry `source?: "reset"` — set by a restart-type usage reset
(`lib/resets.ts`). `resetModes` (providerId → `"keep"` | `"restart"`) says how a provider resets a
user's usage early; a provider without an entry gets its default (`claude`/`anthropic` keep their
week, `openai` restarts it, anything else keeps).
```

- [ ] **Step 6: Run the tests, then the type check**

Run: `npx vitest run tests/settings.test.ts tests/settings-draft.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: errors only where a test (or seed) builds a whole `UsageSettings`, `AppConfig` or `Draft` literal
without `resetModes` (for example `MONTHLY` in `tests/settings.test.ts`). Add `resetModes: {}` to each one
it names, and to the `MONTHLY` constant so "accepts a complete update" still matches. Re-run until clean.

- [ ] **Step 7: Run the whole check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/config.ts lib/settings.ts components/settings/draft.ts app/api/settings/route.ts docs/data-model.md tests
git commit -m "feat(settings): add a per-provider reset mode"
```

---

### Task 2: The reset model (`lib/resets.ts`)

**Files:**
- Create: `lib/resets.ts`
- Test: `tests/resets.test.ts`

**Interfaces:**
- Consumes: `ResetMode`, `ResetOverride`, `ResetConfig`, `TokenMode` (lib/config.ts);
  `readStoredResetOverride` (Task 1); `getPreviousCycle`, `wallClockOf`, `Cycle` (lib/cycle.ts);
  `TimeWindow`, `UsageEvent` (lib/aggregate.ts — `UsageEvent.basisMs` is added in Task 6; until then
  `dropStaleBasis` reads it through an optional property access, see the code).
- Produces (all exported):
  - `type ResetSource = "manual" | "report"`, `interface ResetEvent`, `interface ProviderResets`, `interface Segment`
  - `MINUTE_MS`, `emptyResets()`, `isResetId(value)`, `parseProviderResets(raw)`, `serializeProviderResets(resets)`
  - `resetsOf(all, providerId): ProviderResets`, `resetEventsOf(all, providerId): ResetEvent[]`
  - `keepResetsOf(cycle: TimeWindow, events)`, `segmentsOf(cycle, events): Segment[]`,
    `segmentStartAt(cycle, events, atMs): number`, `restartStarting(events, startMs)`, `cycleResets(cycle, events)`
  - `cycleBefore(cycle: Cycle, reset: ResetConfig, shared: ResetConfig, events): { cycle: Cycle; reset: ResetConfig }`
  - `restartOverride(atMs, timeZone): ResetOverride`, `sameOverride(a, b): boolean`
  - `dropStaleBasis(events: UsageEvent[], resets: ResetEvent[], mode: TokenMode): UsageEvent[]`
  - `addReset(resets, event): ProviderResets`, `beforeFromRaw(raw): number | null`
  - `pruneResets(resets, cycle: TimeWindow, previousStartMs): ProviderResets`

- [ ] **Step 1: Write the failing tests**

Create `tests/resets.test.ts`:

```ts
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

  it("reads damaged JSON as no resets, drops a damaged event on its own, and sorts by time", () => {
    expect(parseProviderResets("not json")).toEqual(emptyResets());
    const doc = JSON.stringify({
      v: 1,
      events: [reset(), { ...reset({ id: "bad" }), atMs: "soon" }, reset({ id: "r0", atMs: at("2026-09-21T10:00:00Z") })],
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
    expect(restartOverride(R, "UTC")).toEqual({ weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" });
    expect(restartOverride(R, "Europe/Budapest")).toEqual({
      weekday: 2,
      monthDay: 22,
      hour: 16,
      minute: 0,
      source: "reset",
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
    const resets = addReset({ v: 1, events: [reset()], autoOffCycleStartMs: null }, reset({ id: "early", atMs: R - 3_600_000 }));
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
    const pruned = pruneResets(resets, CYCLE, previousStartMs);
    expect(pruned.events.map((event) => event.id)).toEqual(["prev", "r1"]);
    expect(pruned.autoOffCycleStartMs).toBeNull();
    expect(pruneResets({ ...resets, autoOffCycleStartMs: CYCLE.startMs }, CYCLE, previousStartMs).autoOffCycleStartMs).toBe(
      CYCLE.startMs,
    );
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/resets.test.ts`
Expected: FAIL — cannot resolve `@/lib/resets`.

- [ ] **Step 3: Implement `lib/resets.ts`**

```ts
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
  return events.filter((event) => {
    const basisMs = (event as UsageEvent & { basisMs?: number }).basisMs;
    return basisMs === undefined || !restarts.some((atMs) => event.ts >= atMs && basisMs < atMs);
  });
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
 * What housekeeping keeps of one provider's resets: the events from its
 * previous cycle's start on (an older one's cycle is archived by now,
 * lib/archive.ts), and a revert's detection switch while its cycle runs.
 */
export function pruneResets(resets: ProviderResets, cycle: TimeWindow, previousStartMs: number): ProviderResets {
  const off = resets.autoOffCycleStartMs;
  return {
    v: 1,
    events: resets.events.filter((event) => event.atMs >= previousStartMs),
    autoOffCycleStartMs: off !== null && off < cycle.startMs ? null : off,
  };
}
```

(Task 6 adds `basisMs` to `UsageEvent`; it then replaces the cast in `dropStaleBasis` with `event.basisMs`.)

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/resets.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/resets.ts tests/resets.test.ts
git commit -m "feat(resets): add the reset model and segment arithmetic"
```

---

### Task 3: Cycles that know about resets

**Files:**
- Modify: `lib/provider-cycles.ts`
- Modify: `lib/cycle-options.ts`
- Test: `tests/provider-cycles.test.ts`, `tests/cycle-options.test.ts`

**Interfaces:**
- Consumes: `cycleBefore`, `segmentStartAt`, `ResetEvent` (Task 2).
- Produces:
  - `providerCycle(now: Date, config: AppConfig, providerId: string, resets: ResetEvent[] = []): ProviderCycle`
  - `currentSegmentStartMs(now: Date, config: AppConfig, providerId: string, resets: ResetEvent[] = []): number`
  - `officialTagAt(now: Date, config: AppConfig, providerId: string, resets: ResetEvent[]): (atMs: number) => number | null`
  - `CycleOptionsInput.shared?: ResetConfig`, `CycleOptionsInput.resets?: ResetEvent[]`;
    `providerCycleOptions({ …, resets?: ResetEvent[] })`

- [ ] **Step 1: Write the failing tests**

Append to `tests/provider-cycles.test.ts` (add `currentSegmentStartMs`, `officialTagAt` to the import from
`@/lib/provider-cycles`, and `import type { ResetEvent } from "@/lib/resets";`):

```ts
describe("with resets", () => {
  const R = Date.parse("2026-09-22T14:00:00Z");
  const S = Date.parse("2026-09-21T00:00:00Z");
  const restarted = {
    ...config,
    resetOverrides: {
      ...config.resetOverrides,
      openai: { weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" as const },
    },
  };
  const event = (overrides: Partial<ResetEvent>): ResetEvent => ({
    id: "r",
    atMs: R,
    kind: "keep",
    cycleStartMs: S,
    before: 90,
    beforeAtMs: null,
    source: "manual",
    recordedAtMs: R,
    ...overrides,
  });
  const restart = event({ kind: "restart", previousOverride: null });

  it("makes the cycle a restart cut short the previous one", () => {
    const { cycle, previous } = providerCycle(NOW, restarted, "openai", [restart]);
    expect(cycle.start.toISOString()).toBe("2026-09-22T14:00:00.000Z");
    expect(previous.start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(previous.end.toISOString()).toBe("2026-09-22T14:00:00.000Z");
  });

  it("starts the current segment at the cycle's last keep reset", () => {
    expect(currentSegmentStartMs(NOW, config, "openai", [])).toBe(S);
    expect(currentSegmentStartMs(NOW, config, "openai", [event({})])).toBe(R);
  });

  it("tags a figure with the segment its moment falls in, in this cycle or the one before", () => {
    const tagAt = officialTagAt(NOW, restarted, "openai", [restart]);
    expect(tagAt(R + 3_600_000)).toBe(R);
    expect(tagAt(S + 3_600_000)).toBe(S);
    expect(tagAt(S - 1)).toBeNull();
  });
});
```

Append to `tests/cycle-options.test.ts` (import `getConfig` from `@/lib/config`, `providerCycleOptions` from
`@/lib/cycle-options` if not already, and `type ResetEvent` from `@/lib/resets`):

```ts
describe("providerCycleOptions with a restart", () => {
  it("offers the cycle the restart cut short, then older ones on the old schedule", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    const R = Date.parse("2026-09-22T14:00:00Z");
    const config = {
      ...getConfig({}),
      reset: { period: "weekly" as const, weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
      resetOverrides: { openai: { weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" as const } },
    };
    const restart: ResetEvent = {
      id: "r",
      atMs: R,
      kind: "restart",
      cycleStartMs: Date.parse("2026-09-21T00:00:00Z"),
      before: 90,
      beforeAtMs: null,
      source: "manual",
      recordedAtMs: R,
      previousOverride: null,
    };
    const options = providerCycleOptions({
      now,
      config,
      providerId: "openai",
      history: [],
      oldestReportMs: Date.parse("2026-09-01T00:00:00Z"),
      resets: [restart],
    });
    expect(options.slice(0, 3).map((option) => [new Date(option.startMs).toISOString(), new Date(option.endMs).toISOString()])).toEqual([
      ["2026-09-22T14:00:00.000Z", "2026-09-29T14:00:00.000Z"],
      ["2026-09-21T00:00:00.000Z", "2026-09-22T14:00:00.000Z"],
      ["2026-09-14T00:00:00.000Z", "2026-09-21T00:00:00.000Z"],
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/provider-cycles.test.ts tests/cycle-options.test.ts`
Expected: FAIL — the new exports are missing, and the restart's cut-short cycle is not offered.

- [ ] **Step 3: Implement `lib/provider-cycles.ts`**

Replace the file's code below the module comment with:

```ts
import type { TimeWindow } from "@/lib/aggregate";
import type { AppConfig } from "@/lib/config";
import { type Cycle, getCycle } from "@/lib/cycle";
import { cycleBefore, type ResetEvent, segmentStartAt } from "@/lib/resets";
import { resetFor } from "@/lib/settings";

// (module comment stays; add this paragraph to it:)
//  * A provider's reset events (lib/resets.ts) matter in two places: a cycle a
//  * restart began comes after the one it cut short, not after one worked out
//  * backwards; and a keep reset starts a new segment, which is what a current
//  * official figure is tagged with.

export interface ProviderCycle {
  cycle: Cycle;
  /** The cycle right before `cycle`: the footer's comparison, counter mode's baseline, the archive. */
  previous: Cycle;
}

function cycleWith(now: Date, reset: AppConfig["reset"], shared: AppConfig["reset"], resets: ResetEvent[]): ProviderCycle {
  const cycle = getCycle(now, reset);
  return { cycle, previous: cycleBefore(cycle, reset, shared, resets).cycle };
}

const windowOf = (cycle: Cycle): TimeWindow => ({ startMs: cycle.start.getTime(), endMs: cycle.end.getTime() });

/** The cycle `now` falls in for one provider, with the one before it; `resets` are that provider's. */
export function providerCycle(now: Date, config: AppConfig, providerId: string, resets: ResetEvent[] = []): ProviderCycle {
  return cycleWith(now, resetFor(config, providerId), config.reset, resets);
}

/** Of the providers' cycles and the shared reset's, the one that began first. */
export function earliestCycle(now: Date, config: AppConfig, providerIds: string[]): ProviderCycle {
  let earliest = cycleWith(now, config.reset, config.reset, []);
  for (const providerId of providerIds) {
    const candidate = providerCycle(now, config, providerId);
    if (candidate.cycle.start.getTime() < earliest.cycle.start.getTime()) earliest = candidate;
  }
  return earliest;
}
```

Keep `earliestStartMs` as it is but replace its `cycleWith(now, config.reset)` with
`cycleWith(now, config.reset, config.reset, [])`. (Its computed previous cycles start no later than a
restart's real one, so reading from them still reaches far enough.) Then append:

```ts
/**
 * The start of the segment of `providerId`'s current cycle that `now` falls
 * in: its last keep reset, else the cycle's start. A current official figure
 * is tagged with it (lib/official-usage.ts).
 */
export function currentSegmentStartMs(
  now: Date,
  config: AppConfig,
  providerId: string,
  resets: ResetEvent[] = [],
): number {
  return segmentStartAt(windowOf(providerCycle(now, config, providerId, resets).cycle), resets, now.getTime());
}

/**
 * The retag rule (lib/reset-recording.ts): the tag an official figure entered
 * at `atMs` gets — the start of its segment in the provider's current cycle,
 * or in the one before; null further back (such a figure keeps its tag).
 */
export function officialTagAt(
  now: Date,
  config: AppConfig,
  providerId: string,
  resets: ResetEvent[],
): (atMs: number) => number | null {
  const { cycle, previous } = providerCycle(now, config, providerId, resets);
  const current = windowOf(cycle);
  const before = windowOf(previous);
  return (atMs) => {
    if (atMs >= current.startMs) return segmentStartAt(current, resets, atMs);
    if (atMs >= before.startMs) return segmentStartAt(before, resets, atMs);
    return null;
  };
}
```

- [ ] **Step 4: Implement `lib/cycle-options.ts`**

Add `import { cycleBefore, type ResetEvent } from "@/lib/resets";` and drop the now unused
`getPreviousCycle` import. Extend `CycleOptionsInput`:

```ts
  /** The shared reset: what a restart's cut-short cycle ran on when the provider had no own reset. Default: `reset`. */
  shared?: ResetConfig;
  /** The provider's reset events (lib/resets.ts): a cycle a restart began comes after the one it cut short. */
  resets?: ResetEvent[];
```

In `listCycleOptions`, destructure `shared = reset, resets = []` along with the other fields, and replace the
`computed` loop with:

```ts
  const computed: { startMs: number; endMs: number }[] = [];
  let cursor: Cycle = current;
  let cursorReset = reset;
  // A month back at most every step; the bound is only a safety net against a zero-length cycle.
  for (let step = 0; step < 400; step++) {
    const before = cycleBefore(cursor, cursorReset, shared, resets);
    const previous = before.cycle;
    if (previous.start.getTime() >= cursor.start.getTime() || previous.start.getTime() < cutoffMs) break;
    computed.push({ startMs: previous.start.getTime(), endMs: previous.end.getTime() });
    cursor = previous;
    cursorReset = before.reset;
  }
```

Add a sentence to the module comment: "A cycle a restart began (lib/resets.ts) is preceded by the one it cut
short, and the cycles before that are worked out from the reset that one ran on."

In `providerCycleOptions`, add `resets?: ResetEvent[]` to its parameter (destructure `resets = []`) and pass
`shared: config.reset, resets` to `listCycleOptions`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/provider-cycles.test.ts tests/cycle-options.test.ts`
Expected: PASS.

- [ ] **Step 6: Check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/provider-cycles.ts lib/cycle-options.ts tests/provider-cycles.test.ts tests/cycle-options.test.ts
git commit -m "feat(resets): follow restarts and segments in provider cycles"
```

---

### Task 4: A segment's usage (`summarizeUsage` from a moment)

**Files:**
- Modify: `lib/aggregate.ts`
- Test: `tests/aggregate.test.ts`

**Interfaces:**
- Produces: `summarizeUsage(events: UsageEvent[], window: TimeWindow, mode: TokenMode, fromMs = window.startMs): UsageSummary`
  — per series, the usage up to `window.endMs` less the usage up to `fromMs`, both counted from
  `window.startMs`; only series with a counted event in `[fromMs, window.endMs)` are listed.

- [ ] **Step 1: Write the failing test**

Append to `tests/aggregate.test.ts` (import `summarizeUsage` and `type UsageEvent` if not already):

```ts
describe("summarizeUsage from a segment's start", () => {
  const window = { startMs: 0, endMs: 1000 };
  const e = (machineId: string, tokens: number, ts: number): UsageEvent => ({ machineId, groupId: "Work", tokens, ts });

  it("counts what each series used since `fromMs`, in every token mode", () => {
    // Snapshot: running totals since the window's start. "b" did not report since 500: not listed.
    const snapshot = [e("a", 100, 100), e("a", 300, 400), e("a", 350, 600), e("b", 50, 200)];
    const summary = summarizeUsage(snapshot, window, "snapshot", 500);
    expect(summary.total).toBe(50);
    expect(summary.series.map((s) => [s.machineId, s.tokens, s.reports])).toEqual([["a", 50, 1]]);

    const delta = [e("a", 100, 100), e("a", 200, 400), e("a", 50, 600)];
    expect(summarizeUsage(delta, window, "delta", 500).total).toBe(50);

    // Counter: a baseline before the window, and a restart from zero after `fromMs`.
    const counter = [e("a", 1000, -10), e("a", 1100, 100), e("a", 1300, 400), e("a", 20, 700)];
    expect(summarizeUsage(counter, window, "counter", 500).total).toBe(20);
  });

  it("is the whole window without `fromMs`", () => {
    const snapshot = [e("a", 100, 100), e("a", 350, 600)];
    expect(summarizeUsage(snapshot, window, "snapshot").total).toBe(350);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run tests/aggregate.test.ts`
Expected: FAIL — the snapshot total is 350, not 50 (`fromMs` is ignored).

- [ ] **Step 3: Implement**

In `lib/aggregate.ts`, delete the private `usageOfSeries` helper and change `summarizeUsage`:

```ts
/**
 * Aggregates raw reports into per-group and per-machine usage for one window.
 * Pass events from before the window too when available: counter mode uses
 * them as the baseline.
 *
 * `fromMs` (default: the window's start) counts only what was used from then
 * on: each series' usage up to the window's end less its usage up to
 * `fromMs`, both counted from the window's start. That is one segment of a
 * cycle (lib/resets.ts): snapshot reports are running totals since the cycle
 * start, so only the difference says what the segment used. Only the series
 * that reported inside `[fromMs, endMs)` are listed.
 */
export function summarizeUsage(
  events: UsageEvent[],
  window: TimeWindow,
  mode: TokenMode,
  fromMs: number = window.startMs,
): UsageSummary {
  // A merged machine's carry-over is a series of its own, but the same row: keyed by group and machine only.
  const byMachine = new Map<string, SeriesUsage>();
  for (const list of groupIntoSeries(events)) {
    const inWindow = list.filter(
      (e) => e.ts >= fromMs && e.ts < window.endMs && (!e.checkpoint || mode === "snapshot"),
    );
    const last = inWindow[inWindow.length - 1];
    if (!last) continue;
    const reports = inWindow.filter((e) => !e.checkpoint);
    const [before, until] = usageOfSeriesUntil(list, window.startMs, [fromMs, window.endMs], mode);
    const tokens = until! - before!;
```

(the rest of the function body is unchanged.)

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/aggregate.ts tests/aggregate.test.ts
git commit -m "feat(aggregate): measure the usage of a segment of a window"
```

---

### Task 5: Storing resets (`usage:resets`)

**Files:**
- Modify: `lib/redis-keys.ts`
- Modify: `lib/usage-store.ts`
- Modify: `docs/data-model.md`
- Test: `tests/usage-store.test.ts`

**Interfaces:**
- Consumes: `ProviderResets`, `parseProviderResets`, `serializeProviderResets`, `emptyResets` (Task 2).
- Produces:
  - `KEYS.resets = "usage:resets"`
  - `StoreIndexes.resets: Record<string, ProviderResets>` (filled by `loadIndexes()`)
  - `loadResets(): Promise<Record<string, ProviderResets>>`
  - `saveResets(providerId: string, resets: ProviderResets): Promise<void>` (an empty document deletes the field)
  - `saveResetOverride(providerId: string, override: ResetOverride | null, now: Date, providerIds: string[])` (null removes it)
  - `saveOfficialFields(fields: Record<string, string>): Promise<void>` (HSET of `usage:official`, nothing when empty)
  - `deleteArchivedCycle(providerId: string, startMs: number): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/usage-store.test.ts` (extend the imports: `deleteArchivedCycle`, `loadRawSettings`,
`loadResets`, `saveOfficialFields`, `saveResetOverride`, `saveResets` from `@/lib/usage-store`; `emptyResets`,
`type ProviderResets` from `@/lib/resets`; `getConfig` from `@/lib/config`; `resolveConfig`, `ownResetOf` from
`@/lib/settings`; `serializeCycleSummary`, `type CycleSummary` from `@/lib/history`):

```ts
describe("resets", () => {
  useRedis();
  const resets: ProviderResets = {
    v: 1,
    events: [
      {
        id: "r1",
        atMs: Date.parse("2026-09-22T14:00:00Z"),
        kind: "keep",
        cycleStartMs: Date.parse("2026-09-21T00:00:00Z"),
        before: 80,
        beforeAtMs: null,
        source: "manual",
        recordedAtMs: Date.parse("2026-09-22T14:05:00Z"),
      },
    ],
    autoOffCycleStartMs: null,
  };

  it("saves and loads one provider's resets, and drops a document left empty", async () => {
    await saveResets("claude", resets);
    expect((await loadResets()).claude).toEqual(resets);
    expect((await loadIndexes()).resets.claude).toEqual(resets);
    await saveResets("claude", emptyResets());
    expect(await loadResets()).toEqual({});
  });

  it("sets and removes a provider's own reset", async () => {
    const own = { weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" as const };
    await saveResetOverride("openai", own, NOW, ["openai"]);
    expect(ownResetOf(resolveConfig(getConfig(), await loadRawSettings()), "openai")).toEqual(own);
    await saveResetOverride("openai", null, NOW, ["openai"]);
    expect(ownResetOf(resolveConfig(getConfig(), await loadRawSettings()), "openai")).toBeNull();
  });

  it("writes official fields in one go, and nothing for none", async () => {
    await saveOfficialFields({});
    await saveOfficialFields({ claude: '{"raw":"5","enteredAt":1,"cycleStartMs":0}' });
    expect((await loadIndexes()).officialUsage).toEqual({ claude: '{"raw":"5","enteredAt":1,"cycleStartMs":0}' });
  });

  it("deletes an archived cycle by its start", async () => {
    const summary: CycleSummary = {
      v: 1,
      start: 1000,
      end: 2000,
      total: 5,
      limit: null,
      official: null,
      groups: {},
      machines: 1,
      models: {},
      subLimits: {},
      archivedAt: 2000,
    };
    await getRedis().zadd(KEYS.history("openai"), { score: 1000, member: serializeCycleSummary(summary) });
    await deleteArchivedCycle("openai", 1000);
    expect(await getRedis().zcard(KEYS.history("openai"))).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/usage-store.test.ts`
Expected: FAIL — `loadResets`, `saveResets`, … are not exported.

- [ ] **Step 3: Implement the key and its documentation**

In `lib/redis-keys.ts`, add `resets: "usage:resets",` to `KEYS` (after `officialUsage`), and to the layout
comment, after the `usage:official` entry:

```
 *   usage:resets             HASH  providerId → {"v": 1, "events": [ResetEvent…], "autoOffCycleStartMs": ms | null}
 *                                  (the provider's usage resets of its current and previous cycle,
 *                                  see lib/resets.ts; pruned by lib/housekeeping.ts)
```

In `docs/data-model.md`'s key table, add a row after `usage:official`:

```md
| `usage:resets` | HASH | `providerId → JSON {"v": 1, "events": [{"id", "atMs", "kind": "keep"\|"restart", "cycleStartMs", "before", "beforeAtMs", "source": "manual"\|"report", "recordedAtMs", "previousOverride"?}], "autoOffCycleStartMs": ms \| null}` — see `lib/resets.ts` | Housekeeping drops an event once it is older than the provider's previous cycle, and `autoOffCycleStartMs` once that cycle is over | `/api/resets`; `POST /api/official-usage/report` (a detected reset) |
```

- [ ] **Step 4: Implement the store functions**

In `lib/usage-store.ts`:

- Import `type ProviderResets, parseProviderResets, serializeProviderResets` from `@/lib/resets`.
- Add to `StoreIndexes`:

```ts
  /** Every provider's usage resets, parsed (lib/resets.ts); a provider with none is absent. */
  resets: Record<string, ProviderResets>;
```

- Add a parser above `loadIndexes`:

```ts
/** `usage:resets`, by provider: a field with an unknown provider id is skipped. */
function parseResetsHash(raw: unknown): Record<string, ProviderResets> {
  const resets: Record<string, ProviderResets> = {};
  for (const [field, value] of Object.entries(toStringRecord(raw))) {
    const providerId = normalizeProviderId(field);
    if (providerId) resets[providerId] = parseProviderResets(value);
  }
  return resets;
}
```

- In `loadIndexes`, add `indexes.hgetall(KEYS.resets);` after the official-usage read, destructure it as
  `rawResets`, and return `resets: parseResetsHash(rawResets),`. Update its doc comment to "The settings and
  the group, machine, official-usage and reset indexes, in one round trip."
- After `saveOfficialUsage`, add:

```ts
/** Several `usage:official` fields at once (a retag, lib/reset-recording.ts); nothing for none. */
export async function saveOfficialFields(fields: Record<string, string>): Promise<void> {
  if (Object.keys(fields).length > 0) await getRedis().hset(KEYS.officialUsage, fields);
}

/** Every provider's usage resets (lib/resets.ts), one read. */
export async function loadResets(): Promise<Record<string, ProviderResets>> {
  return parseResetsHash(await getRedis().hgetall(KEYS.resets));
}

/**
 * One provider's usage resets, as a whole: read-modify-write of its field, so
 * two writers racing (a report detecting a reset while one is edited by hand)
 * leave the later one's. A document with nothing left in it is removed.
 */
export async function saveResets(providerId: string, resets: ProviderResets): Promise<void> {
  if (resets.events.length === 0 && resets.autoOffCycleStartMs === null) await getRedis().hdel(KEYS.resets, providerId);
  else await getRedis().hset(KEYS.resets, { [providerId]: serializeProviderResets(resets) });
}
```

- Change `saveResetOverride` to accept `null`:

```ts
/**
 * Sets one provider's own reset in the stored settings (an official report
 * moving it to the provider's window, lib/official-report.ts; a restart-type
 * reset, lib/resets.ts), or removes it (null). Read, change, write: a
 * settings save racing it wins or loses as a whole, like two panel saves.
 */
export async function saveResetOverride(
  providerId: string,
  override: ResetOverride | null,
  now: Date,
  providerIds: string[],
): Promise<void> {
  const settings = parseStoredSettings(await loadRawSettings(), settingsFromConfig(getConfig(), providerIds));
  const { [providerId]: _, ...others } = settings.resetOverrides;
  settings.resetOverrides = override ? { ...others, [providerId]: override } : others;
  await getRedis().set(KEYS.settings, serializeSettings(settings, now));
}
```

- After `saveArchivedOfficial`, add:

```ts
/**
 * Removes the archived summary of the cycle that starts at `startMs`: a
 * restart that cut it short was moved or deleted (lib/reset-store.ts), so its
 * end or figure no longer holds. The next archiving run writes it again
 * while its events are still stored (lib/archive.ts).
 */
export async function deleteArchivedCycle(providerId: string, startMs: number): Promise<void> {
  await getRedis().zremrangebyscore(KEYS.history(providerId), startMs, startMs);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/usage-store.test.ts`
Expected: PASS.

- [ ] **Step 6: Check and commit**

Run: `npm run check`
Expected: PASS. (If a test builds a `StoreIndexes` literal, `tsc` asks for `resets: {}` there.)

```bash
git add lib/redis-keys.ts lib/usage-store.ts docs/data-model.md tests
git commit -m "feat(resets): store usage resets in usage:resets"
```

---

### Task 6: The counting-basis stamp

**Files:**
- Modify: `lib/aggregate.ts` (`UsageEvent.basisMs`)
- Modify: `lib/usage-store.ts` (`eventMember`, `storeReport`, `parseEvent`, `loadEvents`, layout comment)
- Modify: `lib/resets.ts` (`dropStaleBasis` reads `event.basisMs` directly)
- Modify: `lib/redis-keys.ts`, `docs/data-model.md` (the member's `"s"`)
- Test: `tests/usage-store.test.ts`

**Interfaces:**
- Consumes: `dropStaleBasis`, `resetEventsOf` (Task 2); `TOKEN_MODE` via `getConfig().tokenMode`.
- Produces: `UsageEvent.basisMs?: number`;
  `eventMember(machineId, tokens, timestampMs, models, costUsd, modelCosts, checkpoint = false, carried = false, basisMs: number | null = null)`;
  `loadEvents(providerIds, groups, sinceMs, resets: Record<string, ProviderResets> = {})` drops stale-basis
  events per provider.

- [ ] **Step 1: Write the failing tests**

Append to `tests/usage-store.test.ts`:

```ts
describe("storeReport — the counting basis", () => {
  useRedis();
  const S = Date.parse("2026-09-21T00:00:00Z");
  const R = Date.parse("2026-09-22T14:00:00Z");

  it("stamps every report and checkpoint with the cycle start it was counted from", async () => {
    const withDays = report({
      providers: { claude: 1200 },
      days: {
        "2026-09-21": { providers: { claude: 1000 } },
        "2026-09-22": { providers: { claude: 200 } },
      },
    });
    await storeOk(withDays, NOW, 70, { timeZone: "UTC", startMs: S });
    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    expect(eventsByProvider.claude!.some((event) => event.checkpoint)).toBe(true);
    expect(eventsByProvider.claude!.every((event) => event.basisMs === S)).toBe(true);
  });

  it("stamps nothing when the cycle could not be read", async () => {
    await storeOk(report({}), NOW, 70, null);
    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0);
    expect(eventsByProvider.claude![0]).not.toHaveProperty("basisMs");
  });

  it("drops the snapshot reports a restart made stale", async () => {
    await storeOk(report({ timestamp: "2026-09-22T15:00:00Z", providers: { claude: 9000 } }), NOW, 70, {
      timeZone: "UTC",
      startMs: S,
    });
    await storeOk(report({ timestamp: "2026-09-22T16:00:00Z", providers: { claude: 300 } }), NOW, 70, {
      timeZone: "UTC",
      startMs: R,
    });
    const resets = {
      claude: {
        v: 1 as const,
        events: [
          {
            id: "r",
            atMs: R,
            kind: "restart" as const,
            cycleStartMs: S,
            before: 90,
            beforeAtMs: null,
            source: "manual" as const,
            recordedAtMs: R,
            previousOverride: null,
          },
        ],
        autoOffCycleStartMs: null,
      },
    };
    const { eventsByProvider } = await loadEvents(["claude"], GROUPS, 0, resets);
    expect(eventsByProvider.claude!.map((event) => event.tokens)).toEqual([300]);
  });
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/usage-store.test.ts`
Expected: FAIL — no `basisMs` on the events; `loadEvents` ignores its fourth argument.

- [ ] **Step 3: Implement**

In `lib/aggregate.ts`, add to `UsageEvent` after `carried`:

```ts
  /**
   * The cycle start the server gave the client when it was stored (lib/ingest.ts): what a
   * snapshot running total counts from. Absent from members stored before the stamp existed.
   * A cycle a restart began ignores those counted from before it (lib/resets.ts `dropStaleBasis`).
   */
  basisMs?: number;
```

In `lib/resets.ts`'s `dropStaleBasis`, replace the cast with the field:

```ts
  return events.filter(
    (event) =>
      event.basisMs === undefined || !restarts.some((atMs) => event.ts >= atMs && event.basisMs! < atMs),
  );
```

In `lib/usage-store.ts`:

- `eventMember`: add a last parameter `basisMs: number | null = null` and, after the `x` entry,
  `...(basisMs !== null && { s: basisMs }),`. Add to its doc comment: "`basisMs` is the cycle start the
  client counted from (`"s"`), when the settings could be read."
- `storeReport`: after `const startOf = …`, add

```ts
  // What each provider's running total counts from: the cycle start the client was given.
  const basisOf = (providerId: string): number | null => (startOf ? startOf(providerId) : null);
```

  and pass `false, false, basisOf(providerId)` as the last three arguments of the report's `eventMember(…)`
  call, and `true, false, basisOf(providerId)` for the checkpoints' call (replacing their trailing `true`).
- `parseEvent`: destructure `s` too, and add to the returned object
  `...(typeof s === "number" && Number.isFinite(s) && { basisMs: s }),`.
- `loadEvents`: add the parameter `resets: Record<string, ProviderResets> = {}` (document it: "the
  providers' resets (`loadIndexes().resets`): a cycle a restart began drops the snapshot reports counted from
  before it"), add `event.basisMs ?? null` to the `identity` array, and before the final `return` add:

```ts
  const { tokenMode } = getConfig();
  for (const providerId of providers) {
    eventsByProvider[providerId] = dropStaleBasis(eventsByProvider[providerId]!, resetEventsOf(resets, providerId), tokenMode);
  }
```

  (import `dropStaleBasis`, `resetEventsOf` from `@/lib/resets`).
- In the layout comment at the top, extend the member shape with `"s": cycleStartMs` and add: `"s" the cycle
  start the client counted from (lib/resets.ts dropStaleBasis)`. Do the same in `lib/redis-keys.ts`, and in
  `docs/data-model.md`'s `usage:events:{providerId}:{groupId}` row add `"s"?: cycleStartMs` with "`"s"` is the
  cycle start the client counted from (set by the server; a cycle a restart began ignores snapshot reports
  counted from before it)".

- [ ] **Step 4: Run the tests and fix the expectations the stamp changes**

Run: `npx vitest run tests/usage-store.test.ts tests/integration`
Expected: the new tests PASS. Existing `toEqual` assertions on events stored with a `cycle` (for example
"stores a checkpoint for each finished day…") now also see `basisMs`. Add
`basisMs: Date.parse("2026-09-20T00:00:00Z")` (that test's `cycle.startMs`) to those expected objects; leave
tests that store with `cycle: null` alone. Re-run until green.

- [ ] **Step 5: Check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/aggregate.ts lib/usage-store.ts lib/resets.ts lib/redis-keys.ts docs/data-model.md tests
git commit -m "feat(resets): stamp stored reports with their counting basis"
```

---

### Task 7: The recording rules (`lib/reset-recording.ts`)

**Files:**
- Modify: `lib/official-usage.ts` (stored entries keep a report's `resetsAtMs`)
- Create: `lib/reset-recording.ts`
- Test: `tests/official-usage.test.ts`, `tests/reset-recording.test.ts`

**Interfaces:**
- Consumes: Task 2's model; `normalizeProviderId` (lib/providers.ts); `parseOfficialPercent` (lib/ground-truth.ts).
- Produces:
  - `lib/official-usage.ts`: exported `StoredOfficialEntry` (with `resetsAtMs?: number`),
    `StoredOfficialReading = { view: OfficialEntryView; cycleStartMs: number; resetsAtMs?: number }`,
    `parseStoredOfficialEntry(raw): StoredOfficialReading | null`, `OfficialUsageUpdate.resetsAtMs?: number`.
  - `lib/reset-recording.ts`:
    - `type ResetRefusal = "outside_cycle" | "duplicate_reset" | "has_later_resets" | "not_found" | "not_revertable"`
    - `interface ResetContext { now; mode; cycle: TimeWindow; resets: ProviderResets; override: ResetOverride | null; timeZone }`
    - `type ResetChange = { ok: false; refused: ResetRefusal } | { ok: true; resets; event; override?: ResetOverride | null }`
    - `recordReset(ctx, { id, atMs, before, beforeAtMs, source }): ResetChange`
    - `editReset(ctx, { id, atMs?, before? }): ResetChange`
    - `deleteReset(ctx, { id, revert }): ResetChange`
    - `beforeFromStored(stored: StoredOfficialReading | null, cycle, events, atMs): { before; beforeAtMs }`
    - `retaggedOfficialEntries(stored: Record<string, string>, providerId, tagAt): Record<string, string>`
    - `ResetPost`, `ResetPut`, `ResetDelete`, `parseResetPost`, `parseResetPut`, `parseResetDelete`

- [ ] **Step 1: Write the failing tests**

Append to `tests/official-usage.test.ts` (import `parseOfficialUsageUpdate`, `parseStoredOfficialEntry`,
`storedEntryFor` if not already):

```ts
describe("a report's window reset on a stored entry", () => {
  it("is stored with a report's figure and read back; a typed figure has none", () => {
    const fromReport = storedEntryFor(
      { providerId: "claude", subLimitId: null, raw: "41.2", cycleStartMs: 100, resetsAtMs: 900 },
      50,
    )!;
    expect(parseStoredOfficialEntry(fromReport)).toEqual({
      view: { raw: "41.2", enteredAt: 50 },
      cycleStartMs: 100,
      resetsAtMs: 900,
    });
    const typed = storedEntryFor({ providerId: "claude", subLimitId: null, raw: "45", cycleStartMs: 100 }, 60)!;
    expect(parseStoredOfficialEntry(typed)).toEqual({ view: { raw: "45", enteredAt: 60 }, cycleStartMs: 100 });
  });

  it("is never taken from the dashboard's PUT body", () => {
    const parsed = parseOfficialUsageUpdate({ providerId: "claude", subLimitId: null, raw: "45", cycleStartMs: 100, resetsAtMs: 900 });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    expect(parsed.update).not.toHaveProperty("resetsAtMs");
  });
});
```

Create `tests/reset-recording.test.ts`:

```ts
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
    expect(recordReset(ctx(), input({ atMs: NOW.getTime() + 60_000 }))).toEqual({ ok: false, refused: "outside_cycle" });
    expect(recordReset(ctx(), input({ atMs: NOW.getTime() })).ok).toBe(true);
    expect(recordReset(ctx({ resets: withEvents(event()) }), input())).toEqual({ ok: false, refused: "duplicate_reset" });
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
    expect(editReset(ctx({ resets: withEvents(other) }), { id: "r1", before: 1 })).toEqual({ ok: false, refused: "not_found" });
    expect(editReset(ctx(), { id: "nope", before: 1 })).toEqual({ ok: false, refused: "not_found" });
  });

  it("refuses to move a keep reset outside the cycle or onto another reset's minute", () => {
    const resets = withEvents(event(), event({ id: "b", atMs: R + HOUR }));
    expect(editReset(ctx({ resets }), { id: "r1", atMs: CYCLE.startMs })).toEqual({ ok: false, refused: "outside_cycle" });
    expect(editReset(ctx({ resets }), { id: "r1", atMs: R + HOUR })).toEqual({ ok: false, refused: "duplicate_reset" });
  });

  describe("the restart the cycle began with", () => {
    const restart = event({ id: "rs", kind: "restart", cycleStartMs: CYCLE.startMs, previousOverride: null });
    const keep = event({ id: "k", atMs: R + 2 * HOUR, cycleStartMs: R });
    const restartCycle = { startMs: R, endMs: R + 7 * 24 * HOUR };

    it("moves the provider's reset with it, and the cycle's keep resets keep naming their cycle", () => {
      const change = editReset(
        ctx({ mode: "restart", cycle: restartCycle, resets: withEvents(restart, keep), override: restartOverride(R, "UTC") }),
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
      ctx({ mode: "restart", cycle: restartCycle, resets: withEvents(restart), override: restartOverride(R, "UTC"), ...overrides });

    it("puts the provider's own reset back while it is still the one the restart set", () => {
      const change = deleteReset(context(), { id: "rs", revert: false });
      if (!change.ok) throw new Error(change.refused);
      expect(change.override).toEqual(old);
    });

    it("leaves an own reset changed on the panel since alone", () => {
      const change = deleteReset(context({ override: { weekday: 5, monthDay: 1, hour: 0, minute: 0 } }), { id: "rs", revert: false });
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
});

describe("request bodies", () => {
  it("parses a POST, with or without the optional figures", () => {
    expect(parseResetPost({ providerId: "Claude", atMs: R })).toEqual({ ok: true, value: { providerId: "claude", atMs: R } });
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/official-usage.test.ts tests/reset-recording.test.ts`
Expected: FAIL — `resetsAtMs` is dropped; `@/lib/reset-recording` does not exist.

- [ ] **Step 3: Keep a report's `resetsAtMs` in `lib/official-usage.ts`**

Replace the `StoredOfficialEntry` interface with an exported one, and add the reading type:

```ts
/** One `usage:official` field as stored. */
export interface StoredOfficialEntry extends OfficialEntryView {
  /** The segment it was entered in (lib/resets.ts): the cycle's start while the cycle has no keep resets. */
  cycleStartMs: number;
  /**
   * From a report (POST /api/official-usage/report): when the provider's window
   * resets. Automatic reset detection (lib/official-report.ts) compares two
   * readings by it; a typed figure has none.
   */
  resetsAtMs?: number;
}

/** A stored entry as read back: the view, its tag, and a report's window reset. */
export interface StoredOfficialReading {
  view: OfficialEntryView;
  cycleStartMs: number;
  resetsAtMs?: number;
}
```

In `parseStoredEntry`, also destructure `resetsAtMs` and return
`{ raw: text, enteredAt, cycleStartMs, ...(typeof resetsAtMs === "number" && Number.isFinite(resetsAtMs) && { resetsAtMs }) }`.
Change `parseStoredOfficialEntry`:

```ts
/** One stored entry, with the segment it was saved for; null when it does not parse. */
export function parseStoredOfficialEntry(raw: string): StoredOfficialReading | null {
  const entry = parseStoredEntry(raw);
  if (!entry) return null;
  const { resetsAtMs, cycleStartMs, ...view } = entry;
  return { view, cycleStartMs, ...(resetsAtMs !== undefined && { resetsAtMs }) };
}
```

Add to `OfficialUsageUpdate`:

```ts
  /** Only POST /api/official-usage/report sets it: the window's reset, stored with the figure. */
  resetsAtMs?: number;
```

and in `storedEntryFor`:

```ts
  return serializeOfficialEntry({
    raw: update.raw,
    enteredAt,
    cycleStartMs: update.cycleStartMs,
    ...(update.resetsAtMs !== undefined && { resetsAtMs: update.resetsAtMs }),
  });
```

Update the module comment's "A stored entry is tagged with the cycle it was typed in" to "A stored entry is
tagged with the segment of the cycle it was entered in (its start; see lib/resets.ts)".

- [ ] **Step 4: Implement `lib/reset-recording.ts`**

```ts
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

export function editReset(ctx: ResetContext, input: { id: string; atMs?: number; before?: number | null }): ResetChange {
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
```

Note: `parseResetPut`'s "atMs or before must be given" check only fires when the body is otherwise valid;
a `before: null` counts as given.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/official-usage.test.ts tests/reset-recording.test.ts`
Expected: PASS.

- [ ] **Step 6: Check and commit**

Run: `npm run check`
Expected: PASS. (`decideOfficialReport`'s callers still pass `stored.view`/`stored.cycleStartMs`; the return
type of `parseStoredOfficialEntry` only gained an optional field.)

```bash
git add lib/official-usage.ts lib/reset-recording.ts tests/official-usage.test.ts tests/reset-recording.test.ts
git commit -m "feat(resets): add the rules for recording, editing and deleting resets"
```

---

### Task 8: `/api/resets`

**Files:**
- Create: `lib/reset-store.ts`
- Create: `app/api/resets/route.ts`
- Modify: `lib/api.ts` (`ApiErrorCode`)
- Modify: `docs/api.md`
- Test: `tests/integration/resets.test.ts`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces:
  - `lib/reset-store.ts`: `type ResetAction = { kind: "record"; request: ResetPost } | { kind: "edit"; request: ResetPut } | { kind: "delete"; request: ResetDelete }`;
    `type ResetActionResult = { ok: false; refused: ResetRefusal } | { ok: true; events: ResetEvent[]; cycle: TimeWindow }`;
    `applyResetAction(action, now): Promise<ResetActionResult>`;
    `saveDetectedReset({ providerId, config, resets, reset, override, rawOfficialUsage, now }): Promise<ResetEvent>` (used in Task 11).
  - `ApiErrorCode` gains `"outside_cycle" | "duplicate_reset" | "has_later_resets" | "not_revertable"`.

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/resets.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, POST, PUT } from "@/app/api/resets/route";
import { getConfig } from "@/lib/config";
import { parseStoredOfficialEntry } from "@/lib/official-usage";
import { getRedis } from "@/lib/redis";
import { KEYS } from "@/lib/redis-keys";
import { ownResetOf, resolveConfig, serializeSettings, settingsFromConfig } from "@/lib/settings";
import { loadIndexes, loadRawSettings, loadResets, registerProviders, saveResets } from "@/lib/usage-store";
import { useRedis } from "../helpers/redis-fixture";
import { seedSession } from "../helpers/session";

/** /api/resets: a provider's usage resets in the current cycle (lib/reset-recording.ts, lib/reset-store.ts). */

const URL = "http://localhost/api/resets";
const ORIGIN = { origin: "http://localhost", host: "localhost" };
const PIN = "12345";
// Wednesday 2026-09-23 12:00 UTC; the shared reset is Monday 00:00 UTC.
const NOW = new Date("2026-09-23T12:00:00Z");
const S = Date.parse("2026-09-21T00:00:00Z");
const E = Date.parse("2026-09-28T00:00:00Z");
const R = Date.parse("2026-09-22T14:00:00Z");
const WEEK = 7 * 86_400_000;

function send(method: "POST" | "PUT" | "DELETE", body: unknown, headers: Record<string, string>): Request {
  return new Request(URL, { method, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
}

const handlers = { POST, PUT, DELETE };
async function call(method: "POST" | "PUT" | "DELETE", body: unknown, cookie: string) {
  const response = await handlers[method](send(method, body, { ...ORIGIN, cookie }));
  return { status: response.status, body: await response.json() };
}

async function ownReset(providerId: string) {
  return ownResetOf(resolveConfig(getConfig(), await loadRawSettings()), providerId);
}

async function officialEntry(field: string) {
  const raw = (await loadIndexes()).officialUsage[field];
  return raw ? parseStoredOfficialEntry(raw) : null;
}

describe("/api/resets", () => {
  useRedis();
  let cookie = "";
  beforeEach(async () => {
    vi.stubEnv("DASHBOARD_PIN", PIN);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await getRedis().set(KEYS.settings, serializeSettings({ ...settingsFromConfig(getConfig()), resetOverrides: {} }, NOW));
    await registerProviders(["claude", "openai"], NOW.getTime());
    cookie = await seedSession(PIN);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("refuses a foreign origin, a missing session and demo mode", async () => {
    const body = { providerId: "claude", atMs: R };
    expect((await POST(send("POST", body, { origin: "https://evil.example", host: "localhost", cookie }))).status).toBe(403);
    expect((await POST(send("POST", body, ORIGIN))).status).toBe(401);
    vi.stubEnv("DEMO_MODE", "1");
    const demo = await POST(send("POST", body, { ...ORIGIN, cookie }));
    expect(demo.status).toBe(403);
    expect((await demo.json()).error).toBe("demo_read_only");
  });

  it("answers 400 for a bad body and 404 for an unknown provider", async () => {
    expect((await call("POST", { providerId: "claude", atMs: R + 1 }, cookie)).status).toBe(400);
    const unknown = await call("POST", { providerId: "gemini", atMs: R }, cookie);
    expect(unknown).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it("records a keep reset and answers with the cycle's resets", async () => {
    const { status, body } = await call("POST", { providerId: "claude", atMs: R, before: 80 }, cookie);
    expect(status).toBe(200);
    expect(body.cycle).toEqual({ startMs: S, endMs: E });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ atMs: R, kind: "keep", before: 80, beforeAtMs: null, source: "manual", cycleStartMs: S });
    expect((await loadResets()).claude?.events).toEqual(body.events);
  });

  it("takes the before-figure from the stored figure read before the reset, and leaves that figure in its segment", async () => {
    const enteredAt = R - 600_000;
    await getRedis().hset(KEYS.officialUsage, { claude: JSON.stringify({ raw: "62", enteredAt, cycleStartMs: S }) });
    const { body } = await call("POST", { providerId: "claude", atMs: R }, cookie);
    expect(body.events[0]).toMatchObject({ before: 62, beforeAtMs: enteredAt });
    expect((await officialEntry("claude"))?.cycleStartMs).toBe(S);
  });

  it("stores the figure given for after the reset in the new segment", async () => {
    await call("POST", { providerId: "claude", atMs: R, before: 80, afterRaw: "3" }, cookie);
    expect(await officialEntry("claude")).toEqual({ view: { raw: "3", enteredAt: R }, cycleStartMs: R });
  });

  it("refuses a moment outside the cycle and a reset's minute twice", async () => {
    expect((await call("POST", { providerId: "claude", atMs: S }, cookie)).body.error).toBe("outside_cycle");
    await call("POST", { providerId: "claude", atMs: R }, cookie);
    const again = await call("POST", { providerId: "claude", atMs: R }, cookie);
    expect(again).toMatchObject({ status: 409, body: { error: "duplicate_reset" } });
  });

  it("records a restart for Codex: a new cycle starts at R, and deleting it puts the old one back", async () => {
    const recorded = await call("POST", { providerId: "openai", atMs: R, before: 90 }, cookie);
    expect(recorded.body.cycle).toEqual({ startMs: R, endMs: R + WEEK });
    expect(recorded.body.events[0]).toMatchObject({ kind: "restart", cycleStartMs: S, previousOverride: null });
    expect(await ownReset("openai")).toEqual({ weekday: 2, monthDay: 22, hour: 14, minute: 0, source: "reset" });

    const deleted = await call("DELETE", { providerId: "openai", id: recorded.body.events[0].id }, cookie);
    expect(deleted.body).toEqual({ ok: true, events: [], cycle: { startMs: S, endMs: E } });
    expect(await ownReset("openai")).toBeNull();
  });

  it("edits a keep reset", async () => {
    const { body } = await call("POST", { providerId: "claude", atMs: R, before: 80 }, cookie);
    const edited = await call("PUT", { providerId: "claude", id: body.events[0].id, atMs: R + 3_600_000, before: 70 }, cookie);
    expect(edited.status).toBe(200);
    expect(edited.body.events[0]).toMatchObject({ atMs: R + 3_600_000, before: 70 });
  });

  it("reverts only a detected reset: its figure comes back and detection stops for the cycle", async () => {
    const manual = await call("POST", { providerId: "claude", atMs: R, before: 80 }, cookie);
    const refused = await call("DELETE", { providerId: "claude", id: manual.body.events[0].id, revert: true }, cookie);
    expect(refused).toMatchObject({ status: 409, body: { error: "not_revertable" } });

    const beforeAtMs = R + 3_600_000 - 600_000;
    await saveResets("claude", {
      v: 1,
      events: [
        {
          id: "detected",
          atMs: R + 3_600_000,
          kind: "keep",
          cycleStartMs: S,
          before: 62,
          beforeAtMs,
          source: "report",
          recordedAtMs: R + 3_600_000,
        },
      ],
      autoOffCycleStartMs: null,
    });
    const reverted = await call("DELETE", { providerId: "claude", id: "detected", revert: true }, cookie);
    expect(reverted.status).toBe(200);
    expect(await officialEntry("claude")).toEqual({ view: { raw: "62", enteredAt: beforeAtMs }, cycleStartMs: S });
    expect((await loadResets()).claude?.autoOffCycleStartMs).toBe(S);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run tests/integration/resets.test.ts`
Expected: FAIL — `@/app/api/resets/route` does not exist.

- [ ] **Step 3: Add the error codes**

In `lib/api.ts`'s `ApiErrorCode` union, after `"stale_reading"`, add:

```ts
  | "outside_cycle"
  | "duplicate_reset"
  | "has_later_resets"
  | "not_revertable"
```

- [ ] **Step 4: Implement `lib/reset-store.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { TimeWindow } from "@/lib/aggregate";
import { type AppConfig, getConfig, type ResetOverride } from "@/lib/config";
import type { Cycle } from "@/lib/cycle";
import { officialUsageField, parseStoredOfficialEntry, serializeOfficialEntry } from "@/lib/official-usage";
import { officialTagAt, providerCycle } from "@/lib/provider-cycles";
import { mergeProviderIds } from "@/lib/providers";
import {
  beforeFromStored,
  deleteReset,
  editReset,
  type ResetChange,
  type ResetContext,
  type ResetDelete,
  type ResetPost,
  type ResetPut,
  type ResetRefusal,
  recordReset,
  retaggedOfficialEntries,
} from "@/lib/reset-recording";
import { addReset, cycleResets, type ProviderResets, type ResetEvent, resetsOf } from "@/lib/resets";
import { ownResetOf, resetModeOf, resolveConfig, storedProviderIds, withResetOverride } from "@/lib/settings";
import {
  deleteArchivedCycle,
  loadIndexes,
  saveOfficialFields,
  saveResetOverride,
  saveResets,
} from "@/lib/usage-store";

/**
 * The Redis side of usage resets (lib/reset-recording.ts decides): one change
 * written through — the provider's resets, its own reset when a restart moves
 * it, the official figures' tags (the retag rule), and the archived summary of
 * a cycle a restart no longer cuts short where it did. Each write is a
 * read-modify-write of one provider's data: two writers racing, the later one wins.
 */

export type ResetAction =
  | { kind: "record"; request: ResetPost }
  | { kind: "edit"; request: ResetPut }
  | { kind: "delete"; request: ResetDelete };

export type ResetActionResult =
  /** `not_found` also stands for a provider the store does not know. */
  | { ok: false; refused: ResetRefusal }
  | { ok: true; events: ResetEvent[]; cycle: TimeWindow };

const windowOf = (cycle: Cycle): TimeWindow => ({ startMs: cycle.start.getTime(), endMs: cycle.end.getTime() });

/**
 * Retags `providerId`'s official figures under `config` (the configuration
 * once the change is in), and writes `extra` into its own field, tagged the
 * same way.
 */
async function retagOfficial(
  now: Date,
  config: AppConfig,
  providerId: string,
  events: ResetEvent[],
  stored: Record<string, string>,
  extra: { raw: string; enteredAt: number } | null,
): Promise<void> {
  const tagAt = officialTagAt(now, config, providerId, events);
  const writes = retaggedOfficialEntries(stored, providerId, tagAt);
  const tag = extra && tagAt(extra.enteredAt);
  if (extra && tag !== null) {
    writes[officialUsageField(providerId, null)] = serializeOfficialEntry({ ...extra, cycleStartMs: tag });
  }
  await saveOfficialFields(writes);
}

/** The figure a change writes into the provider's own field: the one for after the reset, or the one a revert puts back. */
function extraFigure(action: ResetAction, event: ResetEvent): { raw: string; enteredAt: number } | null {
  if (action.kind === "record" && action.request.afterRaw !== undefined) {
    return { raw: action.request.afterRaw, enteredAt: event.atMs };
  }
  if (action.kind === "delete" && action.request.revert && event.before !== null) {
    return { raw: String(event.before), enteredAt: event.beforeAtMs ?? event.atMs };
  }
  return null;
}

export async function applyResetAction(action: ResetAction, now: Date): Promise<ResetActionResult> {
  const { providerId } = action.request;
  const indexes = await loadIndexes();
  const providerIds = mergeProviderIds(
    indexes.providers.map((provider) => provider.providerId),
    storedProviderIds(indexes.settings),
  );
  if (!providerIds.includes(providerId)) return { ok: false, refused: "not_found" };

  const config = resolveConfig(getConfig(), indexes.settings, providerIds);
  const resets = resetsOf(indexes.resets, providerId);
  const ctx: ResetContext = {
    now,
    mode: resetModeOf(config, providerId),
    cycle: windowOf(providerCycle(now, config, providerId, resets.events).cycle),
    resets,
    override: ownResetOf(config, providerId),
    timeZone: config.reset.timeZone,
  };

  let change: ResetChange;
  if (action.kind === "record") {
    const { atMs, before } = action.request;
    const ownRaw = indexes.officialUsage[officialUsageField(providerId, null)];
    const known =
      before === undefined
        ? beforeFromStored(ownRaw ? parseStoredOfficialEntry(ownRaw) : null, ctx.cycle, resets.events, atMs)
        : { before, beforeAtMs: null };
    change = recordReset(ctx, { id: randomUUID(), atMs, ...known, source: "manual" });
  } else if (action.kind === "edit") {
    change = editReset(ctx, action.request);
  } else {
    change = deleteReset(ctx, action.request);
  }
  if (!change.ok) return change;

  await saveResets(providerId, change.resets);
  if (change.override !== undefined) await saveResetOverride(providerId, change.override, now, providerIds);
  // The summary archived of the cycle a restart cut short no longer holds once the restart is edited
  // or gone; the next archiving run writes it again from the events (lib/archive.ts).
  if (action.kind !== "record" && change.event.kind === "restart") {
    await deleteArchivedCycle(providerId, change.event.cycleStartMs);
  }

  const after = change.override === undefined ? config : withResetOverride(config, providerId, change.override);
  await retagOfficial(now, after, providerId, change.resets.events, indexes.officialUsage, extraFigure(action, change.event));

  const cycle = windowOf(providerCycle(now, after, providerId, change.resets.events).cycle);
  return { ok: true, events: cycleResets(cycle, change.resets.events), cycle };
}

/**
 * Records a reset `decideOfficialReport` found in a reading
 * (lib/official-report.ts) under a fresh id, and retags the official figures.
 * The caller moves the provider's own reset (`override`) and stores the
 * reading itself.
 */
export async function saveDetectedReset(params: {
  providerId: string;
  config: AppConfig;
  resets: ProviderResets;
  reset: Omit<ResetEvent, "id">;
  override: ResetOverride | null;
  rawOfficialUsage: Record<string, string>;
  now: Date;
}): Promise<ResetEvent> {
  const { providerId, config, resets, reset, override, rawOfficialUsage, now } = params;
  const event: ResetEvent = { id: randomUUID(), ...reset };
  const updated = addReset(resets, event);
  await saveResets(providerId, updated);
  const after = override ? withResetOverride(config, providerId, override) : config;
  await retagOfficial(now, after, providerId, updated.events, rawOfficialUsage, null);
  return event;
}
```

- [ ] **Step 5: Implement `app/api/resets/route.ts`**

```ts
import { apiError, json, readJsonBody, requireSameOrigin, requireSession, withApiHandler } from "@/lib/api";
import { currentTime } from "@/lib/clock";
import { demoReadOnly } from "@/lib/demo/mode";
import { parseResetDelete, parseResetPost, parseResetPut } from "@/lib/reset-recording";
import { applyResetAction, type ResetAction } from "@/lib/reset-store";

/**
 * /api/resets — a provider's usage resets in its current cycle (lib/resets.ts):
 * recorded by hand on the dashboard, edited, deleted, or reverted when the
 * menu bar app's readings were wrongly taken for one. Authenticated by the
 * dashboard's session cookie, same origin only.
 *
 *   POST   { "providerId": "claude",
 *            "atMs": 1758549600000,     a whole minute after the cycle's start, not after now
 *            "before": 80,              optional, 0–100 or null; absent: the stored figure, if read before atMs
 *            "afterRaw": "3" }          optional: the figure since the reset, stored at atMs
 *   PUT    { "providerId", "id", "atMs"?, "before"? }      a reset of the current cycle
 *   DELETE { "providerId", "id", "revert"?: true }        revert: a detected reset only; puts its
 *                                                         before-figure back, detection stops this cycle
 *
 * The kind is the provider's mode (lib/settings.ts `resetModeOf`); a restart
 * moves the provider's own reset to atMs.
 *
 * 200 { ok, events, cycle: { startMs, endMs } } · 400 bad JSON/payload · 401 no session ·
 * 403 foreign origin, or demo mode (demo_read_only) · 404 not_found (provider or reset) ·
 * 409 outside_cycle | duplicate_reset | has_later_resets | not_revertable ·
 * 413 body too large · 415 not JSON · 503 Redis down
 */

const MAX_BODY_BYTES = 1_024;

type ParsedAction = { ok: true; action: ResetAction } | { ok: false; errors: string[] };

function resetHandler(parse: (body: unknown) => ParsedAction) {
  return withApiHandler("api/resets", async ({ request }) => {
    const foreign = requireSameOrigin(request);
    if (foreign) return foreign;
    const readOnly = demoReadOnly();
    if (readOnly) return readOnly;

    const unauthorized = await requireSession();
    if (unauthorized) return unauthorized;

    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    if (!body.ok) return body.response;
    const parsed = parse(body.value);
    if (!parsed.ok) return apiError("invalid_payload", 400, { details: parsed.errors });

    const result = await applyResetAction(parsed.action, currentTime());
    if (!result.ok) return apiError(result.refused, result.refused === "not_found" ? 404 : 409);
    return json({ ok: true, events: result.events, cycle: result.cycle }, 200);
  });
}

export const POST = resetHandler((body) => {
  const parsed = parseResetPost(body);
  return parsed.ok ? { ok: true, action: { kind: "record", request: parsed.value } } : parsed;
});

export const PUT = resetHandler((body) => {
  const parsed = parseResetPut(body);
  return parsed.ok ? { ok: true, action: { kind: "edit", request: parsed.value } } : parsed;
});

export const DELETE = resetHandler((body) => {
  const parsed = parseResetDelete(body);
  return parsed.ok ? { ok: true, action: { kind: "delete", request: parsed.value } } : parsed;
});
```

- [ ] **Step 6: Document the endpoint**

In `docs/api.md`, add after the `POST /api/official-usage/report` section:

````md
## `POST`/`PUT`/`DELETE /api/resets`

Auth: **session** + same-origin; refused in demo mode. A provider's usage resets in its current cycle
(see the reset types in [configuration.md](configuration.md) and `lib/resets.ts`). 1 KB body.

```json
{ "providerId": "claude", "atMs": 1758549600000, "before": 80, "afterRaw": "3" }
```

`POST` records one. `atMs` is a whole minute after the current cycle's start and not after now; the kind
is the provider's reset type: a `keep` reset may fall anywhere in that range, a `restart` must come after
the cycle's last `keep` reset and moves the provider's own reset to `atMs` (a fresh cycle starts there).
`before` (0–100 or `null`) is the share used right before the reset; without it, the stored figure is
taken if it was read before `atMs`. `afterRaw` stores the figure since the reset at `atMs`.

`PUT { providerId, id, atMs?, before? }` edits a `keep` reset of the current cycle, or the `restart` the
cycle began with (its new time must stay before the cycle's first `keep` reset). `DELETE { providerId,
id, revert? }` deletes one; a `restart` with `keep` resets after it is refused, and a deleted restart puts
the provider's previous own reset back unless it was changed on the settings panel since. `revert: true`
is for a reset the menu bar app's readings revealed: its before-figure becomes the current figure again
and automatic detection stops for the rest of that cycle.

`200 { "ok": true, "events": [ResetEvent…], "cycle": { "startMs", "endMs" } }` (the cycle's resets after
the change) · `400` invalid JSON/payload · `401` no session · `403` foreign origin or demo mode ·
`404 not_found` (provider or reset) · `409 outside_cycle | duplicate_reset | has_later_resets |
not_revertable` · `413`/`415` bad body · `503` Redis down.
````

and add rows to the error-code table after `stale_reading`:

```md
| `outside_cycle` | 409 | A reset's time is not after the current cycle's start, or is in the future (`/api/resets`). |
| `duplicate_reset` | 409 | A reset is already recorded at that minute. |
| `has_later_resets` | 409 | A restart-type reset would end the cycle before one of its keep-type resets. |
| `not_revertable` | 409 | Only a reset detected from the menu bar app's readings can be reverted. |
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/integration/resets.test.ts`
Expected: PASS.

- [ ] **Step 8: Check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/api.ts lib/reset-store.ts app/api/resets/route.ts docs/api.md tests/integration/resets.test.ts
git commit -m "feat(resets): add /api/resets to record, edit and delete resets"
```

---

### Task 9: Readers load the resets (dashboard, status, export)

**Files:**
- Modify: `app/[locale]/(dashboard)/page.tsx`
- Modify: `lib/status.ts`
- Modify: `app/api/export/route.ts`
- Test: `tests/integration/status.test.ts`

**Interfaces:**
- Consumes: `loadIndexes().resets` (Task 5), `loadEvents(…, resets)` (Task 6), `providerCycle(…, resets)`,
  `currentSegmentStartMs` (Task 3), `providerCycleOptions({ …, resets })` (Task 3), `resetEventsOf` (Task 2).
- Produces: current official figures are those tagged with the provider's current segment start; a restart's
  stale-basis reports are left out everywhere these readers sum.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/status.test.ts` (import `ingestReport` from `@/lib/ingest` and `saveResets` from
`@/lib/usage-store`):

```ts
describe("GET /api/status after a keep reset", () => {
  useRedis();
  const NOW = new Date("2026-09-23T12:00:00Z");
  const S = Date.parse("2026-09-21T00:00:00Z");
  const R = Date.parse("2026-09-23T08:00:00Z");

  beforeEach(async () => {
    vi.stubEnv("USAGE_API_TOKEN", SERVER_TOKEN);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await seedSettings({ useTokenLimits: false, resetOverrides: {} });
    const stored = await ingestReport(
      { machineId: "mac", groupId: "Personal", providers: { claude: 5000 }, timestamp: NOW.toISOString() },
      NOW,
    );
    if (!stored.ok) throw new Error(JSON.stringify(stored));
    await saveResets("claude", {
      v: 1,
      events: [
        { id: "r", atMs: R, kind: "keep", cycleStartMs: S, before: 80, beforeAtMs: null, source: "manual", recordedAtMs: R },
      ],
      autoOffCycleStartMs: null,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  const claudeOf = async () => ((await (await GET(get())).json()) as StatusPayload).providers.find((p) => p.id === "claude");

  it("reads the figure tagged with the reset as the current one", async () => {
    await getRedis().hset(KEYS.officialUsage, {
      claude: JSON.stringify({ raw: "7", enteredAt: R + 3_600_000, cycleStartMs: R }),
    });
    expect((await claudeOf())?.source).toBe("official");
  });

  it("no longer reads the figure from before the reset as current", async () => {
    await getRedis().hset(KEYS.officialUsage, {
      claude: JSON.stringify({ raw: "80", enteredAt: R - 3_600_000, cycleStartMs: S }),
    });
    expect((await claudeOf())?.source).not.toBe("official");
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run tests/integration/status.test.ts`
Expected: FAIL — the figure tagged with R is not read as current (the reader still compares with the cycle start).

- [ ] **Step 3: Implement `lib/status.ts`**

In `loadStatus`, import `currentSegmentStartMs` (from `@/lib/provider-cycles`) and `resetEventsOf` (from
`@/lib/resets`), drop `providerCycle` from the import if unused, and change:

```ts
  const { eventsByProvider, groups } = await loadEvents(providerIds, indexes.groups, since, indexes.resets);
  // Each provider's stored ground-truth figure applies while its current segment runs (lib/resets.ts).
  const officialUsage = currentOfficialEntries(indexes.officialUsage, (providerId) =>
    currentSegmentStartMs(now, config, providerId, resetEventsOf(indexes.resets, providerId)),
  );
```

- [ ] **Step 4: Implement the dashboard page**

In `app/[locale]/(dashboard)/page.tsx`'s `loadDashboard` (imports: `currentSegmentStartMs` from
`@/lib/provider-cycles`, `resetEventsOf` from `@/lib/resets`):

```ts
  const resetEventsFor = (providerId: string) => resetEventsOf(indexes.resets, providerId);
  const own = selectedId ? providerCycle(now, config, selectedId, resetEventsFor(selectedId)) : null;
```

```ts
  const { eventsByProvider, groups } = await loadEvents(providerIds, indexes.groups, since, indexes.resets);
  // Each provider's stored ground-truth figure applies while its current segment runs (lib/resets.ts).
  const officialUsage = currentOfficialEntries(indexes.officialUsage, (providerId) =>
    currentSegmentStartMs(now, config, providerId, resetEventsFor(providerId)),
  );
```

and pass `resets: resetEventsFor(selectedId),` to `providerCycleOptions({ … })`.

- [ ] **Step 5: Implement the export**

In `app/api/export/route.ts` (import `resetEventsOf` from `@/lib/resets`): in `windowOf`, call
`providerCycle(now, config, id, resetEventsOf(indexes.resets, id))`, and pass `indexes.resets` as the fourth
argument of `loadEvents(…)`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/integration/status.test.ts tests/integration/export.test.ts`
Expected: PASS.

- [ ] **Step 7: Check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add "app/[locale]/(dashboard)/page.tsx" lib/status.ts app/api/export/route.ts tests/integration/status.test.ts
git commit -m "feat(resets): read official figures by segment and drop stale-basis reports"
```

---

### Task 10: Alerts per segment

**Files:**
- Modify: `lib/alerts.ts`
- Modify: `lib/redis-keys.ts`, `docs/data-model.md` (the alert key now names the segment)
- Test: `tests/integration/alerts.test.ts`

**Interfaces:**
- Consumes: `loadResets`, `loadEvents(…, resets)`, `segmentStartAt`, `resetEventsOf`, `summarizeUsage(…, fromMs)`.
- Produces: `AlertCycle.segmentStartMs?: number`; the guard key is
  `usage:alert:{providerId}:{segmentStartMs ?? startMs}:{threshold}`.

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe` of `tests/integration/alerts.test.ts` (import `saveResets` from
`@/lib/usage-store`, `ingestReport` from `@/lib/ingest`, `checkIngestAlerts` from `@/lib/alerts`):

```ts
  describe("after a keep reset", () => {
    const NOW = new Date("2026-09-23T12:00:00Z");
    const S = Date.parse("2026-09-21T00:00:00Z");
    const R = Date.parse("2026-09-23T08:00:00Z");
    const resetDoc = {
      v: 1 as const,
      events: [
        { id: "r", atMs: R, kind: "keep" as const, cycleStartMs: S, before: 95, beforeAtMs: null, source: "manual" as const, recordedAtMs: R },
      ],
      autoOffCycleStartMs: null,
    };
    const alerts = { webhookUrl: "https://hooks.example.com/x", thresholds: [50, 90], perProvider: true, format: "generic" as const, locale: "en" };

    it("fires the thresholds again for the new segment's figure", async () => {
      await seedSettings({ useTokenLimits: false, resetOverrides: {}, alerts });
      await saveResets("claude", resetDoc);
      const fetchSpy = mockFetch();

      await checkOfficialUsageAlerts({ providerId: "claude", subLimitId: null, raw: "92", cycleStartMs: R }, NOW);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(await getRedis().exists(KEYS.alert("claude", R, 90))).toBe(1);
    });

    it("ignores a figure tagged with an earlier segment", async () => {
      await seedSettings({ useTokenLimits: false, resetOverrides: {}, alerts });
      await saveResets("claude", resetDoc);
      const fetchSpy = mockFetch();

      await checkOfficialUsageAlerts({ providerId: "claude", subLimitId: null, raw: "92", cycleStartMs: S }, NOW);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("measures the tokens of the segment only", async () => {
      await seedSettings({ useTokenLimits: true, limits: { claude: 1000 }, resetOverrides: {}, alerts });
      await saveResets("claude", resetDoc);
      const fetchSpy = mockFetch();
      const store = async (tokens: number, iso: string) => {
        const at = new Date(iso);
        const result = await ingestReport({ machineId: "mac", groupId: "Personal", providers: { claude: tokens }, timestamp: iso }, at);
        if (!result.ok) throw new Error(JSON.stringify(result));
        return result.report;
      };
      await store(900, "2026-09-23T07:00:00Z");
      const last = await store(1000, "2026-09-23T11:00:00Z");

      // 1000 since the cycle start would be 100%; since the reset it is 100 tokens, 10%.
      await checkIngestAlerts(last, NOW);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/integration/alerts.test.ts`
Expected: FAIL — the figure tagged with R is skipped (compared with the cycle start), and the ingest check
measures the whole cycle (fires at 100%).

- [ ] **Step 3: Implement `lib/alerts.ts`**

Imports: `loadResets` (with `loadEvents`, `loadIndexes`, `loadRawSettings`) from `@/lib/usage-store`,
`resetEventsOf`, `segmentStartAt` from `@/lib/resets`.

Extend `AlertCycle`:

```ts
  /**
   * The segment the usage was measured in (lib/resets.ts): a threshold fires
   * once per segment, so a reset lets them fire again. Default: `startMs`.
   */
  segmentStartMs?: number;
```

In `evaluateAlerts`, build the key with `KEYS.alert(providerId, cycle.segmentStartMs ?? cycle.startMs, threshold)`.
In the module comment, change "A threshold fires once per provider per cycle" to "A threshold fires once per
provider per segment of a cycle (the whole cycle when it has no keep reset, lib/resets.ts)" and the key's
description to `usage:alert:{providerId}:{segmentStartMs}:{threshold}`.

In `checkIngestAlerts`'s loop:

```ts
      const cycle = getCycle(now, resetConfigOf(settings, providerId));
      const startMs = cycle.start.getTime();
      const endMs = cycle.end.getTime();
      // Since the cycle's last keep reset: what the dashboard's meter counts (lib/resets.ts).
      const segmentStartMs = segmentStartAt({ startMs, endMs }, resetEventsOf(indexes.resets, providerId), now.getTime());

      const { eventsByProvider } = await loadEvents([providerId], indexes.groups, startMs, indexes.resets);
      const events = (eventsByProvider[providerId] ?? []).filter((event) =>
        countsForProvider(settings.excludedProviders, event.groupId, providerId),
      );
      const summary = summarizeUsage(events, { startMs, endMs }, config.tokenMode, segmentStartMs);
```

and pass `cycle: { startMs, endMs, segmentStartMs, timeZone: settings.reset.timeZone }` to `evaluateAlerts`.

In `checkOfficialUsageAlerts`:

```ts
    const config = getConfig();
    const [rawSettings, resets] = await Promise.all([loadRawSettings(), loadResets()]);
    const settings = parseStoredSettings(rawSettings, settingsFromConfig(config));
```

```ts
    const cycle = getCycle(now, resetConfigOf(settings, update.providerId));
    const window = { startMs: cycle.start.getTime(), endMs: cycle.end.getTime() };
    // A figure counts for the segment it was saved for, and only while that segment runs.
    const segmentStartMs = segmentStartAt(window, resetEventsOf(resets, update.providerId), now.getTime());
    if (update.cycleStartMs !== segmentStartMs) return;

    await evaluateAlerts({
      providerId: update.providerId,
      label: providerLabel(update.providerId),
      usedFraction: percent / 100,
      cycle: { ...window, segmentStartMs, timeZone: settings.reset.timeZone },
      settings: alerts,
      now,
    });
```

Update its doc comment: "Skipped for a figure saved for an earlier segment or cycle: it says nothing about
the current one."

In `lib/redis-keys.ts` and `docs/data-model.md`, rename the alert key's middle part to `{segmentStartMs}` and
say "once per provider per segment of a cycle (the cycle's start while it has no keep reset)".

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/alerts.test.ts tests/alerts.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

Run: `npm run check`
Expected: PASS.

```bash
git add lib/alerts.ts lib/redis-keys.ts docs/data-model.md tests/integration/alerts.test.ts
git commit -m "feat(alerts): fire thresholds per segment after a reset"
```

---

### Task 11: Automatic detection from the menu bar app's readings

**Files:**
- Modify: `lib/official-report.ts`
- Modify: `app/api/official-usage/report/route.ts`
- Modify: `docs/api.md`
- Test: `tests/official-report.test.ts`, `tests/integration/official-report.test.ts`

**Interfaces:**
- Consumes: `resetModeOf`, `ownResetOf`, `withResetOverride` (Task 1); `ProviderResets`, `keepResetsOf`,
  `segmentStartAt`, `restartOverride`, `beforeFromRaw`, `MINUTE_MS`, `resetsOf` (Task 2); `providerCycle(…, resets)`
  (Task 3); `StoredOfficialReading` (Task 7); `saveDetectedReset` (Task 8).
- Produces:
  - `RESET_DROP_POINTS = 5`
  - `decideOfficialReport(report, config, now, stored: StoredOfficialReading | null, resets: ProviderResets): OfficialReportDecision`
  - `OfficialReportDecision` gains `{ kind: "ignored" }`, and `accept` gains `reset: Omit<ResetEvent, "id"> | null`
    (`cycleStartMs` is now the tag: the segment the figure belongs to).
  - The route answers `200 { ok, saved, cycleChanged, reset, detectedReset: { id, kind, atMs } | null }`.

- [ ] **Step 1: Update the existing unit tests to the new signature**

In `tests/official-report.test.ts`: import `emptyResets` from `@/lib/resets`. Every
`decideOfficialReport(…, null, null)` becomes `decideOfficialReport(…, null, emptyResets())`; every call that
passes a stored view and its cycle start, `(…, { raw, enteredAt }, cycleStartMs)`, becomes
`(…, { view: { raw, enteredAt }, cycleStartMs }, emptyResets())`; every expected `{ kind: "accept", … }`
object gains `reset: null`.

- [ ] **Step 2: Write the failing detection tests**

Append to `tests/official-report.test.ts` (import `RESET_DROP_POINTS` from `@/lib/official-report`,
`withResetOverride` from `@/lib/settings`, `type ProviderResets` from `@/lib/resets`):

```ts
describe("decideOfficialReport — reset detection", () => {
  const MINUTE = 60_000;
  // Claude already aligned to its window: Thursday 09:00 UTC, cycle 2026-09-17 09:00 → 2026-09-24 09:00.
  const claude = withResetOverride(base, "claude", { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" });
  const CLAUDE_START = Date.parse("2026-09-17T09:00:00Z");
  const CLAUDE_END = Date.parse("2026-09-24T09:00:00Z");
  const earlier = (raw: string, overrides = {}) => ({
    view: { raw, enteredAt: Date.parse("2026-09-23T10:00:00Z") },
    cycleStartMs: CLAUDE_START,
    resetsAtMs: CLAUDE_END,
    ...overrides,
  });
  const on: ProviderResets = { v: 1, events: [], autoOffCycleStartMs: null };

  it("records a keep reset when the same window's figure drops by the threshold or more", () => {
    const reading = parsed({ usedPercent: 3, resetsAtMs: CLAUDE_END, observedAtMs: Date.parse("2026-09-23T11:50:30Z") });
    const R = Date.parse("2026-09-23T11:50:00Z");
    expect(decideOfficialReport(reading, claude, NOW, earlier("62"), on)).toEqual({
      kind: "accept",
      save: true,
      override: null,
      cycleStartMs: R,
      raw: "3",
      reset: {
        atMs: R,
        kind: "keep",
        cycleStartMs: CLAUDE_START,
        before: 62,
        beforeAtMs: Date.parse("2026-09-23T10:00:00Z"),
        source: "report",
        recordedAtMs: NOW.getTime(),
      },
    });
  });

  it("does not detect a smaller drop, a typed figure, or a cycle with detection off", () => {
    const reading = parsed({ usedPercent: 62 - RESET_DROP_POINTS + 0.5, resetsAtMs: CLAUDE_END });
    expect(decideOfficialReport(reading, claude, NOW, earlier("62"), on)).toMatchObject({ kind: "accept", reset: null });
    const low = parsed({ usedPercent: 3, resetsAtMs: CLAUDE_END });
    const typed = { view: { raw: "62", enteredAt: Date.parse("2026-09-23T10:00:00Z") }, cycleStartMs: CLAUDE_START };
    expect(decideOfficialReport(low, claude, NOW, typed, on)).toMatchObject({ reset: null });
    const off = { ...on, autoOffCycleStartMs: CLAUDE_START };
    expect(decideOfficialReport(low, claude, NOW, earlier("62"), off)).toMatchObject({ kind: "accept", reset: null });
  });

  it("refuses a reading from before the current segment", () => {
    const keep = { id: "k", atMs: Date.parse("2026-09-23T11:00:00Z"), kind: "keep" as const, cycleStartMs: CLAUDE_START, before: 62, beforeAtMs: null, source: "manual" as const, recordedAtMs: 0 };
    const reading = parsed({ resetsAtMs: CLAUDE_END, observedAtMs: Date.parse("2026-09-23T10:30:00Z") });
    expect(decideOfficialReport(reading, claude, NOW, null, { ...on, events: [keep] })).toEqual({ kind: "stale_reading" });
  });

  describe("Codex (restart)", () => {
    // openai runs on the shared reset: 2026-09-21 00:00 → 2026-09-28 00:00.
    const S = Date.parse("2026-09-21T00:00:00Z");
    const E = Date.parse("2026-09-28T00:00:00Z");
    const R = Date.parse("2026-09-23T08:00:00Z");
    const stored = { view: { raw: "90", enteredAt: Date.parse("2026-09-22T12:00:00Z") }, cycleStartMs: S, resetsAtMs: E };
    const jumped = () => parsed({ providerId: "openai", usedPercent: 1, resetsAtMs: R + 7 * 86_400_000 });

    it("records a restart when the window jumps a week past R", () => {
      expect(decideOfficialReport(jumped(), base, NOW, stored, on)).toEqual({
        kind: "accept",
        save: true,
        override: { weekday: 3, monthDay: 23, hour: 8, minute: 0, source: "reset" },
        cycleStartMs: R,
        raw: "1",
        reset: {
          atMs: R,
          kind: "restart",
          cycleStartMs: S,
          before: 90,
          beforeAtMs: Date.parse("2026-09-22T12:00:00Z"),
          source: "report",
          recordedAtMs: NOW.getTime(),
          previousOverride: null,
        },
      });
      expect(R % MINUTE).toBe(0);
    });

    it("ignores a moved window while detection is off for the cycle, instead of moving the reset", () => {
      expect(decideOfficialReport(jumped(), base, NOW, stored, { ...on, autoOffCycleStartMs: S })).toEqual({ kind: "ignored" });
    });

    it("only aligns, without a reset, when there is no earlier reading to compare with", () => {
      expect(decideOfficialReport(jumped(), base, NOW, null, on)).toMatchObject({
        kind: "accept",
        override: { weekday: 3, hour: 8, minute: 0, source: "report" },
        reset: null,
      });
    });
  });
});
```

Note: `parsed(...)`'s helper fills defaults for omitted fields (`providerId: "claude"`, `observedAtMs` 11:50),
so override only what each case needs.

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run tests/official-report.test.ts`
Expected: FAIL — `RESET_DROP_POINTS` missing; no `reset` field; no `ignored` kind.

- [ ] **Step 4: Implement `decideOfficialReport`**

In `lib/official-report.ts`, replace the imports with:

```ts
import type { TimeWindow } from "@/lib/aggregate";
import type { AppConfig, ResetOverride } from "@/lib/config";
import { type Cycle, wallClockOf } from "@/lib/cycle";
import type { StoredOfficialReading } from "@/lib/official-usage";
import { providerCycle } from "@/lib/provider-cycles";
import { normalizeProviderId } from "@/lib/providers";
import {
  beforeFromRaw,
  keepResetsOf,
  MINUTE_MS,
  type ProviderResets,
  type ResetEvent,
  restartOverride,
  segmentStartAt,
} from "@/lib/resets";
import { ownResetOf, resetFor, resetModeOf, withResetOverride } from "@/lib/settings";
```

Add to the module comment:

```
 * It also notices a usage reset (lib/resets.ts), comparing the reading with
 * the provider's stored one from a report of the same segment: for a
 * "restart" provider, a window that jumped from this cycle's end to a week
 * after R; for a "keep" provider, the same window and a figure at least
 * RESET_DROP_POINTS lower. A revert switches this off for the rest of the
 * cycle (`autoOffCycleStartMs`); readings whose window ends elsewhere are then
 * ignored rather than moving the reset back.
```

After `RESET_TOLERANCE_MS`, add `export const RESET_DROP_POINTS = 5;`. Replace `OfficialReportDecision` and
`decideOfficialReport`:

```ts
export type OfficialReportDecision =
  | { kind: "period_not_weekly" }
  | { kind: "stale_reading" }
  /** Detection is off for the cycle and the window ends elsewhere: nothing is stored or moved. */
  | { kind: "ignored" }
  | {
      kind: "accept";
      /** False: a figure at least as recent is already stored for this segment. */
      save: boolean;
      /** The provider's new reset, when it moves; null when it already matches. */
      override: ResetOverride | null;
      /** The tag to store the figure under: the start of the segment it belongs to. */
      cycleStartMs: number;
      /** `usedPercent` as the dashboard's ground-truth field stores it. */
      raw: string;
      /** A reset the reading revealed, to be recorded under a fresh id; null: none. */
      reset: Omit<ResetEvent, "id"> | null;
    };

const windowOf = (cycle: Cycle): TimeWindow => ({ startMs: cycle.start.getTime(), endMs: cycle.end.getTime() });

/**
 * What to do with `report` (see the module comment). `stored` is the
 * provider's current `usage:official` entry, with its tag; `resets` its
 * resets (lib/resets.ts).
 */
export function decideOfficialReport(
  report: OfficialReport,
  config: AppConfig,
  now: Date,
  stored: StoredOfficialReading | null,
  resets: ProviderResets,
): OfficialReportDecision {
  if (config.reset.period !== "weekly") return { kind: "period_not_weekly" };
  if (report.resetsAtMs <= now.getTime()) return { kind: "stale_reading" };

  const { providerId } = report;
  const { events } = resets;
  const nowMs = now.getTime();
  const raw = String(Math.round(report.usedPercent * 10) / 10);
  const near = (a: number, b: number) => Math.abs(a - b) <= RESET_TOLERANCE_MS;
  const current = windowOf(providerCycle(now, config, providerId, events).cycle);
  const mode = resetModeOf(config, providerId);

  // What a reset is told by: a report's earlier reading of this very segment, while detection is on.
  const earlier =
    resets.autoOffCycleStartMs !== current.startMs &&
    stored !== null &&
    stored.resetsAtMs !== undefined &&
    stored.cycleStartMs === segmentStartAt(current, events, nowMs) &&
    stored.view.enteredAt < report.observedAtMs
      ? { ...stored, resetsAtMs: stored.resetsAtMs, percent: beforeFromRaw(stored.view.raw) }
      : null;
  const before = earlier?.percent ?? null;
  const detected = (atMs: number, kind: "keep" | "restart", cycleStartMs: number): Omit<ResetEvent, "id"> => ({
    atMs,
    kind,
    cycleStartMs,
    before,
    beforeAtMs: earlier!.view.enteredAt,
    source: "report",
    recordedAtMs: nowMs,
    ...(kind === "restart" && { previousOverride: ownResetOf(config, providerId) }),
  });

  // 1. A restart: the earlier reading's window was this cycle, the new one ends a week after R.
  if (
    mode === "restart" &&
    earlier &&
    before !== null &&
    near(earlier.resetsAtMs, current.endMs) &&
    report.resetsAtMs > current.endMs + RESET_TOLERANCE_MS
  ) {
    const atMs = Math.round((report.resetsAtMs - WEEK_MS) / MINUTE_MS) * MINUTE_MS;
    const lastStartMs = keepResetsOf(current, events).at(-1)?.atMs ?? current.startMs;
    if (atMs > lastStartMs && atMs <= Math.min(report.observedAtMs, nowMs)) {
      return {
        kind: "accept",
        save: true,
        override: restartOverride(atMs, config.reset.timeZone),
        cycleStartMs: atMs,
        raw,
        reset: detected(atMs, "restart", current.startMs),
      };
    }
  }

  // 2. A window that ends elsewhere moves the provider's reset to it, without a reset event.
  let effective = config;
  let override: ResetOverride | null = null;
  if (!near(current.endMs, report.resetsAtMs)) {
    if (resets.autoOffCycleStartMs === current.startMs) return { kind: "ignored" };
    const resetAt = new Date(Math.round(report.resetsAtMs / MINUTE_MS) * MINUTE_MS);
    const { weekday, hour, minute } = wallClockOf(resetAt, config.reset.timeZone);
    override = { weekday, monthDay: resetFor(config, providerId).monthDay, hour, minute, source: "report" };
    effective = withResetOverride(config, providerId, override);
  }
  const cycle = windowOf(providerCycle(now, effective, providerId, events).cycle);
  const segmentStartMs = segmentStartAt(cycle, events, nowMs);
  if (report.observedAtMs < segmentStartMs) return { kind: "stale_reading" };

  // 3. A keep reset: the same window, and the figure fell by RESET_DROP_POINTS or more.
  if (
    mode === "keep" &&
    override === null &&
    earlier &&
    before !== null &&
    near(earlier.resetsAtMs, report.resetsAtMs) &&
    before - report.usedPercent >= RESET_DROP_POINTS
  ) {
    // An upper bound: the reset happened between the two readings; it can be corrected by hand.
    const atMs = Math.floor(Math.min(report.observedAtMs, nowMs) / MINUTE_MS) * MINUTE_MS;
    if (atMs > segmentStartMs) {
      return { kind: "accept", save: true, override: null, cycleStartMs: atMs, raw, reset: detected(atMs, "keep", cycle.startMs) };
    }
  }

  const newer = stored === null || stored.cycleStartMs !== segmentStartMs || stored.view.enteredAt < report.observedAtMs;
  return { kind: "accept", save: newer, override, cycleStartMs: segmentStartMs, raw, reset: null };
}
```

(`WEEK_MS` already exists in the file. Remove the old body and the now unused imports.)

- [ ] **Step 5: Run the unit tests**

Run: `npx vitest run tests/official-report.test.ts`
Expected: PASS.

- [ ] **Step 6: Write the failing route test**

In `tests/integration/official-report.test.ts`: every expected 200 body gains `detectedReset: null` (where a
test matches the whole body with `toEqual`). Then append inside the `describe`:

```ts
  it("detects a keep reset from two readings of the same window, and records it", async () => {
    await seedSettings("weekly");
    const token = await tokenOf("official");
    await registerProviders(["claude"], NOW.getTime());
    // The first reading aligns Claude to its window (Thursday 09:00) and is stored with its window.
    expect((await POST(post(body({ usedPercent: 62 }), token))).status).toBe(200);

    const observedAtMs = Date.parse("2026-09-23T11:55:00Z");
    const response = await POST(post(body({ usedPercent: 2, observedAtMs }), token));
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer).toMatchObject({ ok: true, saved: true, cycleChanged: false, reset: null });
    expect(answer.detectedReset).toMatchObject({ kind: "keep", atMs: observedAtMs });

    const resets = await loadResets();
    expect(resets.claude?.events).toEqual([expect.objectContaining({ id: answer.detectedReset.id, before: 62, source: "report" })]);
    const stored = parseStoredOfficialEntry((await loadIndexes()).officialUsage.claude!);
    expect(stored).toMatchObject({ view: { raw: "2" }, cycleStartMs: observedAtMs });
  });
```

(imports: `loadIndexes`, `loadResets` from `@/lib/usage-store`; `parseStoredOfficialEntry` from `@/lib/official-usage`.)

- [ ] **Step 7: Run it to see it fail**

Run: `npx vitest run tests/integration/official-report.test.ts`
Expected: FAIL — the route passes the old arguments and answers no `detectedReset`.

- [ ] **Step 8: Wire the route**

In `app/api/official-usage/report/route.ts` (imports: `json` stays; `resetsOf` from `@/lib/resets`;
`saveDetectedReset` from `@/lib/reset-store`):

```ts
  const storedRaw = indexes.officialUsage[officialUsageField(report.providerId, null)];
  const stored = storedRaw ? parseStoredOfficialEntry(storedRaw) : null;
  const resets = resetsOf(indexes.resets, report.providerId);

  const decision = decideOfficialReport(report, config, now, stored, resets);
  // Detection is off for this cycle (a reverted reset) and the window ends elsewhere: nothing to do.
  if (decision.kind === "ignored") {
    return json({ ok: true, saved: false, cycleChanged: false, reset: null, detectedReset: null }, 200);
  }
  if (decision.kind !== "accept") return apiError(decision.kind, 409);

  if (decision.override) await saveResetOverride(report.providerId, decision.override, now, providerIds);
  const detected =
    decision.reset &&
    (await saveDetectedReset({
      providerId: report.providerId,
      config,
      resets,
      reset: decision.reset,
      override: decision.override,
      rawOfficialUsage: indexes.officialUsage,
      now,
    }));
  if (decision.save) {
    const update = {
      providerId: report.providerId,
      subLimitId: null,
      raw: decision.raw,
      cycleStartMs: decision.cycleStartMs,
      // Kept with the figure: the next reading is compared with it (reset detection).
      resetsAtMs: report.resetsAtMs,
    };
    // The reading's own time: the dashboard says when the figure was true, not when it arrived.
    await saveOfficialUsage(update, new Date(report.observedAtMs));
    defer(() => checkOfficialUsageAlerts(update, now));
  }

  const { override } = decision;
  return json(
    {
      ok: true,
      saved: decision.save,
      cycleChanged: override !== null,
      reset: override && { weekday: override.weekday, hour: override.hour, minute: override.minute },
      detectedReset: detected ? { id: detected.id, kind: detected.kind, atMs: detected.atMs } : null,
    },
    200,
  );
```

Update the route's doc comment: add "a reading that reveals a usage reset records it (lib/resets.ts) and
answers it in `detectedReset`; while detection is off for the cycle, a reading whose window ends elsewhere is
ignored (`saved: false`)", and change the status line to `200 { ok, saved, cycleChanged, reset, detectedReset }`.

- [ ] **Step 9: Document it**

In `docs/api.md`'s `POST /api/official-usage/report` section, after "a reading no newer than the figure
already stored for that cycle is not written.", add:

```md
It also detects a usage reset by comparing the reading with the stored figure of an earlier report of the
same segment: for a provider whose reset type is `restart` (Codex), a window that moved from this cycle's
end to a week after R records a restart at R (`resetsAtMs` − 7 days, to the minute) and moves the
provider's reset there; for a `keep` provider (Claude), the same window and a figure at least 5 points
lower records a keep reset at the reading's minute. After a revert (`DELETE /api/resets` with `revert`),
detection is off for the rest of that cycle, and a reading whose window ends elsewhere is ignored
(`saved: false`, nothing moved).
```

and change the 200 line to
`200 { "ok": true, "saved": <bool>, "cycleChanged": <bool>, "reset": { "weekday", "hour", "minute" } | null, "detectedReset": { "id", "kind", "atMs" } | null }`.

- [ ] **Step 10: Run the tests, check and commit**

Run: `npx vitest run tests/official-report.test.ts tests/integration/official-report.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

```bash
git add lib/official-report.ts app/api/official-usage/report/route.ts docs/api.md tests/official-report.test.ts tests/integration/official-report.test.ts
git commit -m "feat(resets): detect resets from the menu bar app's readings"
```

---

### Task 12: Archiving with segments

**Files:**
- Modify: `lib/history.ts`
- Modify: `lib/archive.ts`
- Modify: `app/[locale]/(dashboard)/page.tsx`, `lib/housekeeping.ts` (pass `resets` to `archiveDueCycles`)
- Modify: `docs/data-model.md` (History section)
- Test: `tests/history.test.ts`, `tests/housekeeping.test.ts`

**Interfaces:**
- Consumes: `summarizeUsage(…, fromMs)` (Task 4); `keepResetsOf`, `restartStarting`, `resetEventsOf` (Task 2);
  `providerCycle(…, resets)` (Task 3).
- Produces:
  - `CycleSegmentSummary = { start: number; end: number; official: number | null; total: number; groups: Record<string, number> }`
  - `CycleSummary.segments?: CycleSegmentSummary[]`, `CycleSummary.endedByReset?: true`
  - `SummarizeCycleInput.keepResets?: { atMs: number; before: number | null }[]`, `SummarizeCycleInput.endedByReset?: boolean`
  - `ArchiveInput.resets: Record<string, ProviderResets>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/history.test.ts` (import `parseCycleSummary`, `serializeCycleSummary`, `summarizeCycle` and
`type UsageEvent` as needed):

```ts
describe("summarizeCycle with keep resets", () => {
  const S = Date.parse("2026-09-21T00:00:00Z");
  const R = Date.parse("2026-09-22T14:00:00Z");
  const E = Date.parse("2026-09-28T00:00:00Z");
  const e = (machineId: string, groupId: string, tokens: number, iso: string): UsageEvent => ({
    machineId,
    groupId,
    tokens,
    ts: Date.parse(iso),
  });
  // Snapshot running totals since S.
  const events = [
    e("a", "Work", 100, "2026-09-21T10:00:00Z"),
    e("a", "Work", 400, "2026-09-22T13:00:00Z"),
    e("a", "Work", 600, "2026-09-22T20:00:00Z"),
    e("b", "Home", 50, "2026-09-23T09:00:00Z"),
  ];
  const summarize = (overrides = {}) =>
    summarizeCycle({
      events,
      window: { startMs: S, endMs: E },
      mode: "snapshot",
      limit: null,
      official: 20,
      subLimits: [],
      archivedAt: E,
      keepResets: [{ atMs: R, before: 80 }],
      ...overrides,
    });

  it("adds the segments' figures up and restates each segment's groups", () => {
    const summary = summarize();
    expect(summary.official).toBe(100);
    expect(summary.total).toBe(650);
    expect(summary.segments).toEqual([
      { start: S, end: R, official: 80, total: 400, groups: { Work: 400 } },
      { start: R, end: E, official: 20, total: 250, groups: { Work: 200, Home: 50 } },
    ]);
  });

  it("leaves an unknown figure out of the sum, and is null with none known", () => {
    expect(summarize({ keepResets: [{ atMs: R, before: null }] }).official).toBe(20);
    expect(summarize({ keepResets: [{ atMs: R, before: null }], official: null }).official).toBeNull();
  });

  it("has no segments without keep resets, and marks a cycle a restart cut short", () => {
    const summary = summarize({ keepResets: [], endedByReset: true });
    expect(summary).not.toHaveProperty("segments");
    expect(summary.official).toBe(20);
    expect(summary.endedByReset).toBe(true);
  });

  it("round-trips the new fields, and reads damaged segments as a damaged summary", () => {
    const summary = summarize({ endedByReset: true });
    expect(parseCycleSummary(serializeCycleSummary(summary))).toEqual(summary);
    expect(parseCycleSummary(JSON.stringify({ ...summary, segments: [{ start: "x" }] }))).toBeNull();
  });
});
```

Append inside `describe("history step", …)` of `tests/housekeeping.test.ts` (imports: `KEYS` from
`@/lib/redis-keys`; `saveResets` from `@/lib/usage-store`; `restartOverride` from `@/lib/resets`; `getRedis`
already imported):

```ts
    it("archives a cycle a restart cut short with its real end and the restart's before-figure", async () => {
      const R = Date.parse("2026-09-24T08:00:00Z");
      const S = getCycle(new Date(R), getConfig().reset).start.getTime();
      const at = new Date(S + DAY_MS);
      const stored = await ingestReport(
        { machineId: "mac", groupId: "Personal", providers: { openai: 500 }, timestamp: at.toISOString() },
        at,
      );
      if (!stored.ok) throw new Error(JSON.stringify(stored));
      await getRedis().set(
        KEYS.settings,
        serializeSettings({ ...settingsFromConfig(getConfig()), resetOverrides: { openai: restartOverride(R, "UTC") } }, NOW),
      );
      await saveResets("openai", {
        v: 1,
        events: [
          { id: "r", atMs: R, kind: "restart", cycleStartMs: S, before: 90, beforeAtMs: null, source: "manual", recordedAtMs: R, previousOverride: null },
        ],
        autoOffCycleStartMs: null,
      });

      const report = await runHousekeeping(NOW, { dryRun: false });

      expect(report.history.ids).toContain("openai");
      expect((await loadHistory(["openai"])).openai?.[0]).toMatchObject({ start: S, end: R, official: 90, endedByReset: true, total: 500 });
    });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/history.test.ts tests/housekeeping.test.ts`
Expected: FAIL — no `segments`/`endedByReset`; the openai cycle is archived as `[R − 7 days, R)`.

- [ ] **Step 3: Implement `lib/history.ts`**

Add after `CycleSummary`'s `official` doc, changing its wording:

```ts
  /**
   * The official percentage of that cycle; null when none was entered. With
   * `segments`, the sum of their known figures: it can exceed 100.
   */
  official: number | null;
```

and add to `CycleSummary` after `archivedAt`:

```ts
  /** The cycle's stretches between its keep resets (lib/resets.ts), in order; present only when it had any. */
  segments?: CycleSegmentSummary[];
  /** A restart-type reset cut the cycle short: `end` is the reset. */
  endedByReset?: true;
```

with, above it:

```ts
/** One stretch of an archived cycle (lib/resets.ts `segmentsOf`). */
export interface CycleSegmentSummary {
  start: number;
  end: number;
  /** The figure it ended on (0–100); null when unknown. */
  official: number | null;
  /** Measured tokens in it, the provider's own (as `CycleSummary.total`). */
  total: number;
  /** groupId → measured tokens in it. */
  groups: Record<string, number>;
}
```

Add to `SummarizeCycleInput`:

```ts
  /**
   * The keep resets that split the window (lib/resets.ts), in order, each with
   * the figure its segment ended on; `official` is then the last segment's figure.
   */
  keepResets?: { atMs: number; before: number | null }[];
  /** A restart cut the cycle short at `window.endMs`. */
  endedByReset?: boolean;
```

In `summarizeCycle`, destructure `keepResets = [], endedByReset = false` too, and before the `return`:

```ts
  // Each segment's usage is its own difference of the running totals (lib/aggregate.ts `summarizeUsage`).
  const bounds = [window.startMs, ...keepResets.map((reset) => reset.atMs), window.endMs];
  const figures = [...keepResets.map((reset) => reset.before), official];
  const segments: CycleSegmentSummary[] = figures.map((figure, index) => {
    const segment = summarizeUsage(split.main, { startMs: window.startMs, endMs: bounds[index + 1]! }, mode, bounds[index]);
    return {
      start: bounds[index]!,
      end: bounds[index + 1]!,
      official: figure,
      total: segment.total,
      groups: Object.fromEntries(segment.groups.map((g) => [g.groupId, g.tokens])),
    };
  });
  const known = figures.filter((figure): figure is number => figure !== null);
  const summed = known.length > 0 ? Math.round(known.reduce((sum, figure) => sum + figure, 0) * 100) / 100 : null;
```

and in the returned object use `official: keepResets.length > 0 ? summed : official,`, and add
`...(keepResets.length > 0 && { segments }), ...(endedByReset && { endedByReset: true as const }),` after
`archivedAt`.

In `parseCycleSummary`, destructure `segments, endedByReset` too; before the `return` add:

```ts
  if (endedByReset !== undefined && endedByReset !== true) return null;
  const parsedSegments = segments === undefined ? undefined : parseSegments(segments);
  if (parsedSegments === null) return null;
```

return `...(parsedSegments && { segments: parsedSegments }), ...(endedByReset === true && { endedByReset: true as const }),`
after `archivedAt`, and add the helper above it:

```ts
function parseSegments(value: unknown): CycleSegmentSummary[] | null {
  if (!Array.isArray(value)) return null;
  const segments: CycleSegmentSummary[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { start, end, official, total, groups } = item as Record<string, unknown>;
    if (!isFiniteNumber(start) || !isFiniteNumber(end) || !isFiniteNumber(total) || !isNumberRecord(groups)) return null;
    if (official !== null && !isFiniteNumber(official)) return null;
    segments.push({ start, end, official: official as number | null, total, groups });
  }
  return segments;
}
```

- [ ] **Step 4: Implement `lib/archive.ts`**

Add to `ArchiveInput`:

```ts
  /** Every provider's resets (`loadIndexes().resets`): a restart's cut-short cycle, keep resets' segments. */
  resets: Record<string, ProviderResets>;
```

Import `keepResetsOf`, `type ProviderResets`, `resetEventsOf`, `restartStarting` from `@/lib/resets`. Destructure
`resets` in `archiveDueCycles`, and in `windowOf` call `providerCycle(now, config, providerId, resetEventsOf(resets, providerId))`.
In the per-provider summary build, replace the `summarizeCycle({ … })` call with:

```ts
        const events = resetEventsOf(resets, providerId);
        const window = { startMs: previousStartMs, endMs: cycleStartMs };
        const keep = keepResetsOf(window, events);
        // A cycle a restart cut short ended on the restart's before-figure; else its last segment's figure.
        const cut = restartStarting(events, cycleStartMs);
        const lastStartMs = keep.at(-1)?.atMs ?? previousStartMs;
        const summary = summarizeCycle({
          events: (eventsByProvider[providerId] ?? []).filter((event) => counts(event.groupId)),
          window,
          mode: config.tokenMode,
          limit: config.useTokenLimits ? providerConfig.limit : null,
          official: cut?.before ?? officialPercentForCycle(rawOfficialUsage, providerId, lastStartMs),
          subLimits: subLimitsOf(config, providerId),
          archivedAt: cycleStartMs,
          keepResets: keep.map(({ atMs, before }) => ({ atMs, before })),
          endedByReset: cut !== undefined,
        });
```

Add to the module comment of `archiveDueCycles`: "A cycle a restart cut short (lib/resets.ts) is archived as
`[S, R)`, marked `endedByReset`; a cycle with keep resets carries its segments."

- [ ] **Step 5: Pass the resets from both callers**

In `app/[locale]/(dashboard)/page.tsx` and `lib/housekeeping.ts`, add `resets: indexes.resets,` to the
`archiveDueCycles({ … })` call. In `lib/housekeeping.ts`, also pass `indexes.resets` as the fourth argument of
its `loadEvents(…)`.

- [ ] **Step 6: Document the summary fields**

In `docs/data-model.md`'s "History (archived cycles)" section, add after the example:

```md
A cycle with keep-type resets (Claude) also carries `segments`: `[{ "start", "end", "official", "total",
"groups" }]`, one per stretch between its resets, each with the figure it ended on; `official` is then the
sum of the known figures and can exceed 100. A cycle a restart-type reset (Codex) cut short carries
`"endedByReset": true`; its `end` is the reset and its `official` the figure from right before it.
```

- [ ] **Step 7: Run the tests, check and commit**

Run: `npx vitest run tests/history.test.ts tests/housekeeping.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

```bash
git add lib/history.ts lib/archive.ts lib/housekeeping.ts "app/[locale]/(dashboard)/page.tsx" docs/data-model.md tests/history.test.ts tests/housekeeping.test.ts
git commit -m "feat(resets): archive cycles with their segments and restarts"
```

---

### Task 13: Housekeeping prunes resets and reads official figures by segment

**Files:**
- Modify: `lib/housekeeping.ts`
- Modify: `docs/data-model.md` (the `usage:official` retention)
- Test: `tests/housekeeping.test.ts`

**Interfaces:**
- Consumes: `pruneResets`, `resetEventsOf` (Task 2); `providerCycle(…, resets)`, `currentSegmentStartMs` (Task 3);
  `saveResets` (Task 5).
- Produces: `HousekeepingReport.resets: HousekeepingStepReport` (ids are `providerId:eventId`).

- [ ] **Step 1: Write the failing tests**

In `tests/housekeeping.test.ts`'s "does nothing on a bare store" expectation, add `resets: { removed: 0, ids: [] },`
after `officialUsage`. Then append inside `describe("runHousekeeping", …)` (imports: `loadResets`, `saveResets`
from `@/lib/usage-store`):

```ts
  it("prunes reset events whose cycle is archived by now, and a revert's switch once its cycle is over", async () => {
    const cycle = getCycle(NOW, getConfig().reset);
    const previous = getPreviousCycle(cycle, getConfig().reset);
    const event = (id: string, atMs: number, cycleStartMs: number) => ({
      id,
      atMs,
      kind: "keep" as const,
      cycleStartMs,
      before: 50,
      beforeAtMs: null,
      source: "manual" as const,
      recordedAtMs: atMs,
    });
    const older = previous.start.getTime() - 7 * DAY_MS;
    await saveResets("claude", {
      v: 1,
      events: [
        event("old", older + DAY_MS, older),
        event("prev", previous.start.getTime() + DAY_MS, previous.start.getTime()),
        event("now", cycle.start.getTime() + DAY_MS, cycle.start.getTime()),
      ],
      autoOffCycleStartMs: previous.start.getTime(),
    });

    const report = await runHousekeeping(NOW, { dryRun: false });

    expect(report.resets).toEqual({ removed: 1, ids: ["claude:old"] });
    const kept = (await loadResets()).claude;
    expect(kept?.events.map((e) => e.id)).toEqual(["prev", "now"]);
    expect(kept?.autoOffCycleStartMs).toBeNull();
  });

  it("prunes an official figure from an earlier segment of the current cycle", async () => {
    const cycle = getCycle(NOW, getConfig().reset);
    const R = cycle.start.getTime() + DAY_MS;
    await getRedis().hset("usage:providers", { claude: String(NOW.getTime()) });
    await saveResets("claude", {
      v: 1,
      events: [
        { id: "r", atMs: R, kind: "keep", cycleStartMs: cycle.start.getTime(), before: 50, beforeAtMs: null, source: "manual", recordedAtMs: R },
      ],
      autoOffCycleStartMs: null,
    });
    await getRedis().hset("usage:official", {
      claude: JSON.stringify({ raw: "50", enteredAt: R - 1000, cycleStartMs: cycle.start.getTime() }),
      "claude:fable": JSON.stringify({ raw: "5", enteredAt: R + 1000, cycleStartMs: R }),
    });

    const report = await runHousekeeping(NOW, { dryRun: false });

    expect(report.officialUsage.ids).toEqual(["claude"]);
  });
```

(With the file's `NOW`, 2026-09-26T10:00Z, and the default Monday 00:00 UTC reset, the cycle starts
2026-09-21, so `R` is 2026-09-22 00:00, in the past.)

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run tests/housekeeping.test.ts`
Expected: FAIL — no `resets` step; the earlier-segment figure survives.

- [ ] **Step 3: Implement**

In `lib/housekeeping.ts` (imports: `currentSegmentStartMs`, `providerCycle` from `@/lib/provider-cycles`;
`type ProviderResets`, `pruneResets`, `resetEventsOf` from `@/lib/resets`; `saveResets` from
`@/lib/usage-store`):

- Add `resets: HousekeepingStepReport;` to `HousekeepingReport` with the doc "Reset events whose cycle is
  archived by now (ids `providerId:eventId`)".
- Change Step 5's stale test to compare with the segment:

```ts
  // Step 5: official-usage entries from an earlier segment or cycle (each provider's own), or that no longer parse.
  const staleOfficialFields = Object.entries(indexes.officialUsage)
    .filter(([field, raw]) => {
      const cycleStartMs = officialCycleStartMs(raw);
      const providerId = providerOfOfficialField(field);
      const currentStartMs = currentSegmentStartMs(now, config, providerId, resetEventsOf(indexes.resets, providerId));
      return cycleStartMs === null || cycleStartMs < currentStartMs;
    })
    .map(([field]) => field);
```

- After Step 5, add:

```ts
  // Step 5b: reset events older than their provider's previous cycle (archived by now, step 4),
  // and a revert's detection switch once its cycle is over (lib/resets.ts).
  const prunedResets: [string, ProviderResets][] = [];
  const resetIds: string[] = [];
  for (const [providerId, resets] of Object.entries(indexes.resets)) {
    const { cycle, previous } = providerCycle(now, config, providerId, resets.events);
    const pruned = pruneResets(
      resets,
      { startMs: cycle.start.getTime(), endMs: cycle.end.getTime() },
      previous.start.getTime(),
    );
    if (pruned.events.length === resets.events.length && pruned.autoOffCycleStartMs === resets.autoOffCycleStartMs) continue;
    for (const event of resets.events) {
      if (!pruned.events.includes(event)) resetIds.push(`${providerId}:${event.id}`);
    }
    prunedResets.push([providerId, pruned]);
  }
```

- In the `if (!dryRun)` block: `for (const [providerId, pruned] of prunedResets) await saveResets(providerId, pruned);`
- In `report`: `resets: { removed: resetIds.length, ids: resetIds },` after `officialUsage`; add
  `resets: report.resets,` to the per-step logging object and `resets: report.resets.removed,` to the
  `housekeeping.run` log.
- Update the module comment's list of pruned hashes to include `usage:resets`.

In `docs/data-model.md`, change the `usage:official` row's retention to "Pruned by housekeeping once its tag
(`cycleStartMs`, the start of the segment it was entered in) is older than the provider's current segment",
and its shape to include `"resetsAtMs"?: ms` (a report's window reset).

- [ ] **Step 4: Run the tests, check and commit**

Run: `npx vitest run tests/housekeeping.test.ts tests/integration/housekeeping.test.ts`
Expected: PASS.

Run: `npm run check`
Expected: PASS.

```bash
git add lib/housekeeping.ts docs/data-model.md tests/housekeeping.test.ts
git commit -m "feat(resets): prune reset events and earlier segments' figures"
```

---

### Task 14: Full verification

**Files:** none new (fixes only, if something fails).

- [ ] **Step 1: Run the whole check**

Run: `npm run check`
Expected: PASS (Biome, `tsc --noEmit`, every Vitest suite).

- [ ] **Step 2: Build and run the end-to-end suite**

Run: `npm run build && npm run e2e`
Expected: PASS. Plan 1 changes no UI; the demo dashboard must look and behave as before.

- [ ] **Step 3: Exercise the API by hand on a scratch copy**

Follow the local UI verification memory (`usageratio-local-ui-verification`): never touch the user's
`next dev` on :3000 and never point a local run at the repo's `.env.local` (production KV). Start a scratch
copy on another port with an in-memory or local Redis (`npm run redis:up` and inline `KV_*` env), log in with
the PIN, then with `curl` (session cookie, same `Origin`):

1. `POST /api/resets` a keep reset for `claude` → 200, the reset is listed, `cycle` unchanged.
2. `PUT` it to another minute, `DELETE` it → 200 each.
3. `POST` a restart for `openai` → `cycle.startMs` is the reset; `GET /api/settings` shows `openai`'s own
   reset with `source: "reset"`; `DELETE` it → the cycle comes back.
4. `POST /api/official-usage/report` twice with an `official` token (62 %, then 2 %, same `resetsAtMs`) →
   the second answer has `detectedReset`; `DELETE /api/resets` with `revert: true` → the figure is 62 again.

Report each result, and stop the scratch server afterwards.

- [ ] **Step 4: Commit any fixes**

If a step needed a fix, commit it with a Conventional Commit message (no AI attribution). Plan 1 is done;
plan 2 (current-cycle UI) is written next.

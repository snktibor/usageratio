# Usage reset — past cycles (plan 3 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show finished cycles the way usage resets left them: a cycle with keep-type resets came to the sum of
its segments' figures (above 100% possible), split per segment between its groups and machines, corrected one
segment at a time; a cycle a restart-type reset cut short is marked so; the demo dashboard carries a reset.

**Architecture:** Pure helpers in `lib/history.ts` (`sumOfFigures`, per-segment `groupSharesOf`,
`withCorrectedOfficial`) back the previous-cycles list, the summary-only view and the archived correction
(`PUT /api/official-usage/archived` gains `segmentStartMs`). A closed cycle's dashboard model reads its
segments from its archived summary (`pastSegments`; its keep-reset events may be pruned by now) and restarts its
lines there; `applySegmentFigures` (lib/ground-truth.ts) restates it by the segments' figures. The correction
UI gets one field per segment (`useSegmentEntries`, `components/segment-figures.tsx`). Demo data gains one Claude
keep reset in the current week.

**Tech Stack:** Next.js 16 App Router, React 19 client components, next-intl (en/hu/de), Tailwind v4,
TypeScript, Upstash Redis (in-memory store in tests), Vitest (node, jsdom, integration), Testing Library,
Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-10-22-usage-reset-design.md` (section "Past cycles", "Demo data",
"Testing"). Plans 1 and 2 (done): `docs/superpowers/plans/2026-10-22-usage-reset-core.md`,
`docs/superpowers/plans/2026-10-23-usage-reset-current-cycle.md`.

## Global Constraints

- Worktree `/Users/snktibor/Documents/Projects/usageratio-usage-reset`, branch `feat/usage-reset`; never
  commit on `main`; do not push or open a PR in this plan. Never touch `/Users/snktibor/Documents/Projects/usageratio`
  (its `.env.local` points at the production store).
- Conventional Commits. **No AI attribution in any commit message**: no `Co-Authored-By` naming an AI, no
  "Generated with …" line, nothing saying the commit was AI-assisted.
- Pure logic in `lib/`, tests in `tests/` (`tests/*.test.ts` node, `tests/components/**/*.test.tsx` jsdom,
  `tests/integration/**/*.test.ts`); routes stay thin; no chart library; no new dependencies.
- UI text only through `messages/*.json`, en/hu/de in parity, every key used by literal or template-literal
  `t(…)` calls (`tests/messages.test.ts`). The files round-trip exactly through
  `JSON.stringify(…, null, 2) + "\n"`, so keys are added with the node snippet given in each task.
- A segmented cycle's `official` is the sum of its segments' known figures, rounded to two decimals, null when
  none is known (`sumOfFigures`); it can exceed 100. A segment without a figure contributes nothing anywhere.
- `npm run check` (`biome ci` + `tsc --noEmit` + Vitest) passes at the end of every task. Run one test file with
  `npx vitest run <file>`. The code in this plan is not Biome-formatted line by line: run `npm run format`
  before `npm run check` and commit what it changes.

## Deviations from the spec (found while planning)

1. **A correction without `segmentStartMs` of a segmented summary corrects its last segment** — the figure the
   cycle ended on, which is what that request meant before segments existed — and sums again. The spec only
   says "Without segments it behaves as today". A `segmentStartMs` that names no segment answers 404.
2. **The detail view's chart restarts at each reset, as the current cycle's does**, each segment scaled by its
   own figure; the main figure above it is the sum. Its line ends therefore show the last segment's figure.
3. **The detail view reads a closed cycle's segments from its archived summary**, not from reset events (keep
   events are pruned once a cycle is no longer the previous one). A closed cycle without an archived summary
   shows no segments.
4. **A closed segmented cycle's sub-limits count the whole cycle**: their figures are not archived, so there is
   nothing to split them by.
5. **Docs:** `docs/api.md` had no section for `PUT /api/official-usage/archived`; this plan adds one, since the
   contract changes.

## File structure

| File | Responsibility |
| --- | --- |
| `lib/history.ts` | `sumOfFigures`, per-segment `groupSharesOf`, `withCorrectedOfficial` |
| `lib/official-usage.ts`, `lib/usage-store.ts`, `app/api/official-usage/archived/route.ts` | the per-segment correction |
| `components/cycle-history.tsx` | "124% (80% + 44%)", "ended by a reset", per-segment group stacks |
| `components/use-official-entry.ts` | `useSegmentEntries`: one figure per segment, saved to the archive |
| `components/segment-figures.tsx` (new) | the per-segment correction fields |
| `components/archived-cycle-view.tsx` | the summary-only view's sum and per-segment correction |
| `lib/dashboard.ts` | `PastSegment`, `DashboardModel.pastSegments`, `resetMoments`; archived segments into a closed model |
| `lib/timeline.ts` | `buildTimeline(…, fromMs)`: a model's tokens and cost across the segments it is given |
| `lib/ground-truth.ts` | `applySegmentFigures`, `DashboardView.segmentFigures`, `timelineRates` for a closed cycle |
| `app/[locale]/(dashboard)/page.tsx` | the detail view passes the archived summaries in |
| `components/cycle-chart.tsx`, `components/usage-chart.tsx`, `components/model-chart.tsx`, `components/group-machines.tsx` | markers, veils and wording for a closed cycle's segments |
| `components/ground-truth-input.tsx`, `components/dashboard-view.tsx` | the detail view's sum and per-segment correction |
| `lib/demo/dataset.ts`, `lib/demo/seed.ts` | one Claude keep reset in the current week |
| `e2e/demo.spec.ts` | the demo dashboard shows the reset line and list |
| `messages/{en,hu,de}.json`, `docs/configuration.md`, `docs/api.md`, `docs/data-model.md` | text and docs |

---

### Task 1: A finished cycle's figures by segment (`lib/history.ts`)

**Files:**
- Modify: `lib/history.ts` (`summarizeCycle` uses the new `sumOfFigures`; `groupSharesOf`; new `withCorrectedOfficial`)
- Test: `tests/history.test.ts`

**Interfaces:**
- Consumes (plan 1): `CycleSummary.segments?: CycleSegmentSummary[]` (`{ start, end, official: number | null, total, groups: Record<string, number> }`),
  `CycleSummary.endedByReset?: true`; `official` of a segmented summary is the sum of its segments' known figures.
- Produces:
  - `sumOfFigures(figures: (number | null)[]): number | null`
  - `groupSharesOf(entry: CycleSummary): GroupShare[]` — `quotaShare` now per segment for a segmented summary
  - `withCorrectedOfficial(summary: CycleSummary, official: number | null, segmentStartMs?: number): CycleSummary | null`

- [ ] **Step 1: Write the failing tests**

In `tests/history.test.ts` add `sumOfFigures` and `withCorrectedOfficial` to the `@/lib/history` import, and
append (after `describe("finalUsageOf / groupSharesOf", …)`; `WINDOW` and `HOUR` exist at the top of the file):

```ts
/** A week with a keep reset after three days: 80% before it (Work only), 44% after (Work 100, Personal 400). */
const SEGMENTED: CycleSummary = {
  v: 1,
  start: WINDOW.startMs,
  end: WINDOW.endMs,
  total: 1_000,
  limit: null,
  official: 124,
  groups: { Work: 600, Personal: 400 },
  machines: 2,
  models: {},
  subLimits: {},
  archivedAt: WINDOW.endMs,
  segments: [
    { start: WINDOW.startMs, end: 72 * HOUR, official: 80, total: 500, groups: { Work: 500 } },
    { start: 72 * HOUR, end: WINDOW.endMs, official: 44, total: 500, groups: { Work: 100, Personal: 400 } },
  ],
};

describe("sumOfFigures", () => {
  it("adds the known figures up to two decimals, and is null with none known", () => {
    expect(sumOfFigures([80, 20.25, null])).toBe(100.25);
    expect(sumOfFigures([33.333, 33.333])).toBe(66.67);
    expect(sumOfFigures([null, null])).toBeNull();
    expect(sumOfFigures([])).toBeNull();
  });
});

describe("groupSharesOf with segments", () => {
  it("splits each segment's figure by that segment's tokens and adds the parts up, past 100% in total", () => {
    expect(finalUsageOf(SEGMENTED)).toBe(1.24);
    const shares = groupSharesOf(SEGMENTED);
    expect(shares.map((group) => [group.groupId, group.share])).toEqual([
      ["Work", 0.6],
      ["Personal", 0.4],
    ]);
    // Work: all of the first segment's 80%, a fifth of the second's 44%; Personal: four fifths of 44%.
    expect(shares[0]!.quotaShare).toBeCloseTo(0.888);
    expect(shares[1]!.quotaShare).toBeCloseTo(0.352);
  });

  it("leaves a segment without a figure out", () => {
    const partial: CycleSummary = {
      ...SEGMENTED,
      official: 44,
      segments: [{ ...SEGMENTED.segments![0]!, official: null }, SEGMENTED.segments![1]!],
    };
    const shares = groupSharesOf(partial);
    expect(shares[0]!.quotaShare).toBeCloseTo(0.088);
    expect(shares[1]!.quotaShare).toBeCloseTo(0.352);
  });

  it("splits the token limit's share over the whole cycle when no segment has a figure", () => {
    const none: CycleSummary = {
      ...SEGMENTED,
      official: null,
      limit: 4_000,
      segments: SEGMENTED.segments!.map((segment) => ({ ...segment, official: null })),
    };
    const shares = groupSharesOf(none);
    expect(shares[0]!.quotaShare).toBeCloseTo(0.15);
    expect(shares[1]!.quotaShare).toBeCloseTo(0.1);
  });
});

describe("withCorrectedOfficial", () => {
  it("corrects one segment by its start, and sums the figures again", () => {
    const corrected = withCorrectedOfficial(SEGMENTED, 50, 72 * HOUR)!;
    expect(corrected.segments!.map((segment) => segment.official)).toEqual([80, 50]);
    expect(corrected.official).toBe(130);
    expect({ ...corrected, segments: undefined, official: 124 }).toEqual({ ...SEGMENTED, segments: undefined });
  });

  it("corrects the figure the cycle ended on without a segment: its last segment's", () => {
    const corrected = withCorrectedOfficial(SEGMENTED, 20)!;
    expect(corrected.segments!.map((segment) => segment.official)).toEqual([80, 20]);
    expect(corrected.official).toBe(100);
  });

  it("clears a segment's figure with null, and the cycle's once none is left", () => {
    expect(withCorrectedOfficial(SEGMENTED, null, WINDOW.startMs)!.official).toBe(44);
    const cleared = withCorrectedOfficial(withCorrectedOfficial(SEGMENTED, null, WINDOW.startMs)!, null)!;
    expect(cleared.official).toBeNull();
  });

  it("sets the whole cycle's figure without segments, and finds no segment in such a summary", () => {
    const plain: CycleSummary = { ...SEGMENTED, official: 82, segments: undefined };
    delete (plain as Partial<CycleSummary>).segments;
    expect(withCorrectedOfficial(plain, 100)).toEqual({ ...plain, official: 100 });
    expect(withCorrectedOfficial(plain, 100, WINDOW.startMs)).toBeNull();
  });

  it("is null for a start that is no segment's", () => {
    expect(withCorrectedOfficial(SEGMENTED, 50, 71 * HOUR)).toBeNull();
  });
});
```

Run: `npx vitest run tests/history.test.ts`
Expected: FAIL — `sumOfFigures` and `withCorrectedOfficial` are not exported; Work's `quotaShare` is 0.744 (124% × 0.6).

- [ ] **Step 2: The helpers**

In `lib/history.ts`, add after `HISTORY_TOP_MODELS`:

```ts
/** The sum of the known figures (0–100 each), to two decimals; null when none is known. */
export function sumOfFigures(figures: (number | null)[]): number | null {
  const known = figures.filter((figure): figure is number => figure !== null);
  return known.length > 0 ? Math.round(known.reduce((sum, figure) => sum + figure, 0) * 100) / 100 : null;
}
```

In `summarizeCycle`, replace the two lines

```ts
  const known = figures.filter((figure): figure is number => figure !== null);
  const summed = known.length > 0 ? Math.round(known.reduce((sum, figure) => sum + figure, 0) * 100) / 100 : null;
```

with `const summed = sumOfFigures(figures);`.

Replace `groupSharesOf` (doc and body) with:

```ts
/**
 * A cycle's groups, heaviest first, with their share of its measured tokens
 * and of its quota: the final usage (`finalUsageOf`) split between them by
 * their measured tokens, the way the live dashboard splits the official
 * percentage (lib/dashboard.ts). A cycle with keep resets splits each
 * segment's own figure by that segment's tokens and adds the parts up; a
 * segment without a figure adds nothing.
 */
export function groupSharesOf(entry: CycleSummary): GroupShare[] {
  const entries = Object.entries(entry.groups).filter(([, tokens]) => tokens > 0);
  const total = entries.reduce((sum, [, tokens]) => sum + tokens, 0);
  const percentOf = quotaPercentOf(entry);
  return entries
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([groupId, tokens]) => {
      const share = total > 0 ? tokens / total : 0;
      const percent = percentOf(groupId, share);
      // Split in percent, then scaled down: the same arithmetic as the chart's stacked bars, so both round alike.
      return { groupId, tokens, share, quotaShare: percent === null ? null : percent / 100 };
    });
}

/** A group's part of the cycle's final percentage (0–100), by the rule `groupSharesOf` states; null when unknown. */
function quotaPercentOf(entry: CycleSummary): (groupId: string, share: number) => number | null {
  const percent = finalPercentOf(entry);
  if (percent === null) return () => null;
  const segments = entry.segments ?? [];
  // No segment with a figure: the cycle's one figure (or the token limit's share) splits over the whole cycle.
  if (segments.every((segment) => segment.official === null)) return (_groupId, share) => percent * share;
  return (groupId) =>
    segments.reduce((sum, segment) => {
      const tokens = Object.hasOwn(segment.groups, groupId) ? segment.groups[groupId]! : 0;
      return segment.official === null || segment.total <= 0 ? sum : sum + (segment.official * tokens) / segment.total;
    }, 0);
}
```

Add after `archivedOfficialEntries`:

```ts
/**
 * `summary` with a corrected figure (null clears it): one segment's, named by
 * its start, or, without `segmentStartMs`, the one the cycle ended on — its
 * last segment's, or the whole cycle's when it had no keep resets. `official`
 * then sums the segments' known figures again (`sumOfFigures`). Null when
 * `segmentStartMs` names no segment of it.
 */
export function withCorrectedOfficial(
  summary: CycleSummary,
  official: number | null,
  segmentStartMs?: number,
): CycleSummary | null {
  const segments = summary.segments ?? [];
  if (segments.length === 0) return segmentStartMs === undefined ? { ...summary, official } : null;
  const index =
    segmentStartMs === undefined
      ? segments.length - 1
      : segments.findIndex((segment) => segment.start === segmentStartMs);
  if (index < 0) return null;
  const corrected = segments.map((segment, at) => (at === index ? { ...segment, official } : segment));
  return { ...summary, segments: corrected, official: sumOfFigures(corrected.map((segment) => segment.official)) };
}
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/history.test.ts`
Expected: PASS (the existing `groupSharesOf` tests too: a summary without segments splits as before).

- [ ] **Step 4: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add lib/history.ts tests/history.test.ts
git commit -m "feat(resets): split a finished cycle's figure per segment and correct one segment at a time"
```

### Task 2: Correcting one segment's archived figure (server)

**Files:**
- Modify: `lib/official-usage.ts` (`ArchivedOfficialUpdate`, `parseArchivedOfficialUpdate`)
- Modify: `lib/usage-store.ts` (`saveArchivedOfficial`)
- Modify: `app/api/official-usage/archived/route.ts`
- Modify: `docs/api.md` (new section + table of contents line), `docs/data-model.md` (History section)
- Test: `tests/official-usage.test.ts`, `tests/history.test.ts` (`saveArchivedOfficial`), `tests/integration/official-usage-archived.test.ts`

**Interfaces:**
- Consumes: `withCorrectedOfficial` (Task 1).
- Produces: `PUT /api/official-usage/archived` accepts an optional `segmentStartMs` (finite number);
  `saveArchivedOfficial(providerId, cycleStartMs, official, segmentStartMs?: number): Promise<boolean>`
  (false, writing nothing: no summary of that cycle, or no segment starting at `segmentStartMs`);
  `ArchivedOfficialUpdate.segmentStartMs?: number`.

- [ ] **Step 1: Write the failing tests**

Append to `describe("parseArchivedOfficialUpdate", …)` in `tests/official-usage.test.ts`:

```ts
  it("carries the corrected segment's start when given, and rejects one that is no number", () => {
    expect(
      parseArchivedOfficialUpdate({ providerId: "claude", raw: "44", cycleStartMs: CYCLE_START, segmentStartMs: 5 }),
    ).toEqual({
      ok: true,
      update: { providerId: "claude", cycleStartMs: CYCLE_START, official: 44, segmentStartMs: 5 },
    });
    const bad = parseArchivedOfficialUpdate({ providerId: "claude", raw: "44", cycleStartMs: CYCLE_START, segmentStartMs: "x" });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors).toEqual(["segmentStartMs must be a finite number when given"]);
  });
```

In `tests/history.test.ts`, `describe("saveArchivedOfficial", …)`: replace the test
"keeps the segments and the restart mark of the cycle it corrects" with:

```ts
  it("corrects the figure the cycle ended on, its last segment's, and keeps the restart mark", async () => {
    const summary: CycleSummary = {
      ...summaryAt(HOUR),
      official: 100,
      segments: [
        { start: HOUR, end: 2 * HOUR, official: 80, total: 400, groups: { work: 400 } },
        { start: 2 * HOUR, end: 3 * HOUR, official: 20, total: 250, groups: { work: 250 } },
      ],
      endedByReset: true,
    };
    await archiveCycle("claude", summary);

    expect(await saveArchivedOfficial("claude", HOUR, 95)).toBe(true);
    expect((await loadHistory(["claude"])).claude?.[0]).toEqual({
      ...summary,
      official: 175,
      segments: [summary.segments![0], { ...summary.segments![1]!, official: 95 }],
    });
  });

  it("corrects one segment by its start, and writes nothing for a start that is no segment's", async () => {
    const summary: CycleSummary = {
      ...summaryAt(HOUR),
      official: 100,
      segments: [
        { start: HOUR, end: 2 * HOUR, official: 80, total: 400, groups: { work: 400 } },
        { start: 2 * HOUR, end: 3 * HOUR, official: 20, total: 250, groups: { work: 250 } },
      ],
    };
    await archiveCycle("claude", summary);

    expect(await saveArchivedOfficial("claude", HOUR, 60, HOUR)).toBe(true);
    expect((await loadHistory(["claude"])).claude?.[0]?.official).toBe(80);
    expect(await saveArchivedOfficial("claude", HOUR, 60, 5 * HOUR)).toBe(false);
    expect((await loadHistory(["claude"])).claude?.[0]?.official).toBe(80);
  });
```

Append to `describe("PUT /api/official-usage/archived", …)` in `tests/integration/official-usage-archived.test.ts`
(it has `SUMMARY`, `START`, `END`, `PIN`, `ORIGIN`, `put()`, `seedSession`, `archiveCycle`, `loadHistory`):

```ts
  it("corrects one segment of a cycle with keep resets, and answers 404 for a segment it does not have", async () => {
    const MID = START + 3 * 86_400_000;
    await archiveCycle("claude", {
      ...SUMMARY,
      official: 100,
      segments: [
        { start: START, end: MID, official: 80, total: 3_000_000, groups: { work: 3_000_000 } },
        { start: MID, end: END, official: 20, total: 2_000_000, groups: { work: 2_000_000 } },
      ],
    });
    const cookie = await seedSession(PIN);

    const ok = await PUT(put({ providerId: "claude", raw: "44", cycleStartMs: START, segmentStartMs: MID }, { ...ORIGIN, cookie }));
    expect(ok.status).toBe(200);
    const [stored] = (await loadHistory(["claude"])).claude ?? [];
    expect(stored?.official).toBe(124);
    expect(stored?.segments?.map((segment) => segment.official)).toEqual([80, 44]);

    const missing = await PUT(
      put({ providerId: "claude", raw: "44", cycleStartMs: START, segmentStartMs: MID + 1 }, { ...ORIGIN, cookie }),
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe("not_found");
  });
```

Run: `npx vitest run tests/official-usage.test.ts tests/history.test.ts tests/integration/official-usage-archived.test.ts`
Expected: FAIL — `segmentStartMs` is ignored: the parse result lacks it, the store overwrites `official` only.

- [ ] **Step 2: Parse, store, route**

In `lib/official-usage.ts`, `ArchivedOfficialUpdate` gains:

```ts
  /**
   * One segment of a cycle with keep resets, by its start (lib/history.ts
   * `withCorrectedOfficial`); absent: the figure the cycle ended on.
   */
  segmentStartMs?: number;
```

and `parseArchivedOfficialUpdate` becomes:

```ts
export function parseArchivedOfficialUpdate(input: unknown): ArchivedOfficialParseResult {
  if (typeof input !== "object" || input === null) return { ok: false, errors: ["body must be an object"] };
  const { providerId: rawProviderId, raw, cycleStartMs, segmentStartMs } = input as Record<string, unknown>;

  const errors: string[] = [];
  const providerId = normalizeProviderId(rawProviderId);
  if (!providerId) errors.push("providerId must be a valid provider id");
  const parsed =
    typeof raw === "string" && raw.length <= OFFICIAL_USAGE_RAW_MAX_LENGTH ? parseOfficialPercent(raw) : null;
  if (parsed === null || parsed.invalid) errors.push("raw must be a percentage between 0 and 100, or empty");
  if (typeof cycleStartMs !== "number" || !Number.isFinite(cycleStartMs)) {
    errors.push("cycleStartMs must be a finite number");
  }
  if (segmentStartMs !== undefined && (typeof segmentStartMs !== "number" || !Number.isFinite(segmentStartMs))) {
    errors.push("segmentStartMs must be a finite number when given");
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    update: {
      providerId: providerId!,
      cycleStartMs: cycleStartMs as number,
      official: parsed!.percent,
      ...(segmentStartMs !== undefined && { segmentStartMs: segmentStartMs as number }),
    },
  };
}
```

In `lib/usage-store.ts`, add `withCorrectedOfficial` to the `@/lib/history` import and replace
`saveArchivedOfficial` (doc and body) with:

```ts
/**
 * Corrects the official percentage archived with one of `providerId`'s cycles
 * (null clears it), keeping every other field of its summary: one segment's
 * figure of a cycle with keep resets, named by its start, or the one the cycle
 * ended on (lib/history.ts `withCorrectedOfficial`). The summary is replaced
 * as a whole: `ZREMRANGEBYSCORE` on its start, then `ZADD`, in one
 * transaction, so two corrections racing each other still leave exactly one
 * summary of the cycle (the later one's). Returns false, writing nothing, when
 * the cycle has no readable summary, or no segment starting at `segmentStartMs`.
 */
export async function saveArchivedOfficial(
  providerId: string,
  cycleStartMs: number,
  official: number | null,
  segmentStartMs?: number,
): Promise<boolean> {
  const key = KEYS.history(providerId);
  const members = await getRedis().zrange(key, cycleStartMs, cycleStartMs, { byScore: true });
  const summary = (Array.isArray(members) ? members : [])
    .map((member) => parseCycleSummary(String(member)))
    .find((entry): entry is CycleSummary => entry !== null && entry.start === cycleStartMs);
  const corrected = summary ? withCorrectedOfficial(summary, official, segmentStartMs) : null;
  if (!corrected) return false;

  const tx = getRedis().multi();
  tx.zremrangebyscore(key, cycleStartMs, cycleStartMs);
  tx.zadd(key, { score: cycleStartMs, member: serializeCycleSummary(corrected) });
  await tx.exec();
  return true;
}
```

In `app/api/official-usage/archived/route.ts`, the doc block's body example becomes

```ts
 *   PUT  { "providerId": "claude",
 *           "raw": "100",                      as typed; empty clears the figure
 *           "cycleStartMs": 1758326400000,     the archived cycle's start
 *           "segmentStartMs": 1758499200000 }  optional: one segment of a cycle with keep resets
 *                                              (absent: the figure the cycle ended on)
```

its status line `404 not_found (no archived summary of that cycle)` becomes
`404 not_found (no archived summary of that cycle, or no segment starting there)`, and the handler's last lines become:

```ts
  const { providerId, cycleStartMs, official, segmentStartMs } = parsed.update;
  if (!(await saveArchivedOfficial(providerId, cycleStartMs, official, segmentStartMs))) {
    return apiError("not_found", 404);
  }

  return json({ ok: true }, 200);
```

- [ ] **Step 3: Documentation**

In `docs/api.md`, add to the table of contents right after the `PUT /api/official-usage` line:

```markdown
- [`PUT /api/official-usage/archived`](#put-apiofficial-usagearchived)
```

and add a section right before `## \`POST /api/official-usage/report\``:

````markdown
## `PUT /api/official-usage/archived`

Auth: **session** + same-origin; refused in demo mode. Corrects the official percentage archived with a
finished cycle ([History](data-model.md#history-archived-cycles)), say the 82% last typed before the reset when
the cycle in fact ended on 100%.

```json
{ "providerId": "claude", "raw": "100", "cycleStartMs": 1758326400000, "segmentStartMs": 1758499200000 }
```

Empty `raw` clears the figure. A cycle with keep-type usage resets keeps one figure per segment: `segmentStartMs`
names the segment to correct (absent: its last one, the figure the cycle ended on), and the cycle's `official`
becomes the sum of the segments' known figures. `200 { "ok": true }` · `400` invalid JSON/payload · `401` no
session · `403` foreign origin or demo mode · `404 not_found` no archived summary of that cycle, or no segment
starting at `segmentStartMs` · `413`/`415` bad body · `503` Redis down.
````

In `docs/data-model.md`, append to the paragraph that starts "A cycle with keep-type resets (Claude) also carries
`segments`": ` A correction of a segmented cycle (\`PUT /api/official-usage/archived\`) rewrites one segment's
figure and sums them again.`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/official-usage.test.ts tests/history.test.ts tests/integration/official-usage-archived.test.ts`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add lib/official-usage.ts lib/usage-store.ts app/api/official-usage/archived/route.ts docs/api.md docs/data-model.md tests/official-usage.test.ts tests/history.test.ts tests/integration/official-usage-archived.test.ts
git commit -m "feat(resets): correct one segment's archived figure"
```

### Task 3: The previous-cycles list and chart

**Files:**
- Modify: `components/cycle-history.tsx` (`FinalUsage`, the list row's badges, `HistoryChart`'s group stacks)
- Modify: `messages/en.json`, `messages/hu.json`, `messages/de.json` (`Widgets`)
- Test: `tests/components/cycle-history.test.tsx`

**Interfaces:**
- Consumes: `CycleSummary.segments`, `CycleSummary.endedByReset`; `groupSharesOf` (Task 1: `quotaShare` per segment).
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing tests**

Append to `describe("CycleHistory", …)` in `tests/components/cycle-history.test.tsx` (it has `summary()`, `END`,
`DAY`, `NEWER`, `OLDER`, `renderHistory()`):

```tsx
  it("writes a cycle with keep resets as the sum of its segments, and marks one a reset cut short", () => {
    const segmented = summary({
      start: END - 7 * DAY,
      end: END,
      total: 1_000,
      official: 124,
      groups: { Work: 600, Personal: 400 },
      machines: 2,
      segments: [
        { start: END - 7 * DAY, end: END - 4 * DAY, official: 80, total: 500, groups: { Work: 500 } },
        { start: END - 4 * DAY, end: END, official: 44, total: 500, groups: { Work: 100, Personal: 400 } },
      ],
    });
    const cut = summary({ start: END - 14 * DAY, end: END - 9 * DAY, total: 500, official: 70, endedByReset: true });
    renderHistory([segmented, cut]);

    const [first, second] = screen.getAllByRole("listitem");
    const link = within(first!).getByRole("link");
    expect(link.textContent).toContain("124%");
    expect(link.textContent).toContain("(80% + 44%)");
    // Each segment's figure split by that segment's tokens: Work 80% + 8.8%, Personal 35.2%.
    expect(link.textContent).toContain("Work89% of quota · 60% of tokens");
    expect(link.textContent).toContain("Personal35% of quota · 40% of tokens");
    expect(within(first!).queryByText("ended by a reset")).toBeNull();
    expect(within(second!).getByText("ended by a reset")).toBeTruthy();
  });

  it("stacks a segmented cycle's bar by each segment's own split", () => {
    localStorage.removeItem("usageratio_history_view");
    const segmented = summary({
      start: END - 7 * DAY,
      end: END,
      total: 1_000,
      official: 124,
      groups: { Work: 600, Personal: 400 },
      segments: [
        { start: END - 7 * DAY, end: END - 4 * DAY, official: 80, total: 500, groups: { Work: 500 } },
        { start: END - 4 * DAY, end: END, official: 44, total: 500, groups: { Work: 100, Personal: 400 } },
      ],
    });
    renderHistory([segmented, OLDER]);
    fireEvent.click(screen.getByRole("radio", { name: "By group" }));
    const table = screen.getByRole("table");
    const row = within(table).getAllByRole("row").find((tr) => tr.textContent?.includes("124%"))!;
    expect(row.textContent).toContain("89%");
    expect(row.textContent).toContain("35%");
  });
```

Run: `npx vitest run tests/components/cycle-history.test.tsx`
Expected: FAIL — no "(80% + 44%)", no "ended by a reset", Work's quota share is 74%.

- [ ] **Step 2: The list and the chart**

Add the message:

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const add = {
  en: { history_ended_by_reset: "ended by a reset" },
  hu: { history_ended_by_reset: "resettel zárult" },
  de: { history_ended_by_reset: "durch einen Reset beendet" },
};
for (const [locale, keys] of Object.entries(add)) {
  const path = `messages/${locale}.json`;
  const messages = JSON.parse(readFileSync(path, "utf8"));
  Object.assign(messages.Widgets, keys);
  writeFileSync(path, `${JSON.stringify(messages, null, 2)}\n`);
}
EOF
```

In `components/cycle-history.tsx`:

Replace `FinalUsage` with:

```tsx
/**
 * How much of the budget the cycle came to: the official figure, else the share of its token limit. A cycle
 * with keep resets came to the sum of its segments' figures, listed after it ("124% (80% + 44%)").
 */
function FinalUsage({ entry, t, locale }: { entry: CycleSummary; t: Translator<"Widgets">; locale: string }) {
  const limitShare = limitShareOf(entry);
  const [figure, note] =
    entry.official !== null
      ? [formatHeroPercent(entry.official / 100, locale), t("history_final_official")]
      : limitShare !== null
        ? [formatHeroPercent(limitShare / 100, locale), t("history_final_limit")]
        : ["–", t("history_final_unknown")];
  const parts =
    entry.official !== null && entry.segments
      ? entry.segments
          .map((segment) => (segment.official === null ? "–" : formatPercent(segment.official / 100, locale)))
          .join(" + ")
      : null;
  return (
    <span className="flex flex-col items-end text-right">
      <span className={`text-xl font-medium tabular-nums ${figure === "–" ? "text-ink-3" : "text-ink"}`}>{figure}</span>
      {parts && <span className="text-xs tabular-nums text-ink-3">({parts})</span>}
      <span className="text-xs text-ink-3">{note}</span>
    </span>
  );
}
```

In `HistoryChart`, replace the `segments` computation (the block starting
`// Each column's value split between its groups by their measured tokens`) with:

```tsx
  // Each column's value split between its groups, bottom to top in `groupOrder`: a percentage as the cycle's own
  // figure splits (per segment, with keep resets: lib/history.ts `groupSharesOf`), tokens by their share.
  const segments = chronological.map((entry, index) => {
    const value = values[index]!;
    if (value === null) return [];
    const shares = new Map(groupSharesOf(entry).map((group) => [group.groupId, group]));
    return groupOrder.flatMap((groupId) => {
      const group = shares.get(groupId);
      if (!group) return [];
      const part = metric !== "measured" && group.quotaShare !== null ? group.quotaShare * 100 : value * group.share;
      return [{ groupId, value: part }];
    });
  });
```

In `CycleHistory`'s list row, right after the `{summaryOnly && (…)}` badge, add:

```tsx
                              {entry.endedByReset && (
                                <span className="rounded-full border border-rule px-2 py-0.5 text-xs text-ink-3">
                                  {t("history_ended_by_reset")}
                                </span>
                              )}
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/components/cycle-history.test.tsx tests/messages.test.ts`
Expected: PASS.

- [ ] **Step 4: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add components/cycle-history.tsx messages/en.json messages/hu.json messages/de.json tests/components/cycle-history.test.tsx
git commit -m "feat(resets): show a past cycle's segments and a reset-cut cycle in the previous cycles"
```

### Task 4: Per-segment correction fields, and the summary-only view

**Files:**
- Modify: `components/use-official-entry.ts` (`putOfficialUsage` body; new `useSegmentEntries`)
- Create: `components/segment-figures.tsx`
- Modify: `components/archived-cycle-view.tsx` (`ArchivedOfficialFigure`)
- Modify: `messages/en.json`, `messages/hu.json`, `messages/de.json` (`Widgets`)
- Test: `tests/components/correct-official.test.tsx`

**Interfaces:**
- Consumes: `PUT /api/official-usage/archived` with `segmentStartMs` (Task 2); `sumOfFigures` (Task 1);
  `Entry`, `EntryStatus`, `EMPTY_ENTRY` in `components/use-official-entry.ts`.
- Produces:
  - `useSegmentEntries(providerId: string, cycleStartMs: number, segments: { startMs: number; official: number | null }[], closedAtMs: number): [Map<number, Entry>, (startMs: number, raw: string) => void, Map<number, EntryStatus>]`
    — keyed by segment start; a change is saved after the usual pause with `segmentStartMs`, then the page refreshes.
  - `SegmentFigures({ segments, entries, statuses, onChange, timeZone }: { segments: { startMs: number; endMs: number }[]; entries: Map<number, Entry>; statuses: Map<number, EntryStatus>; onChange: (startMs: number, raw: string) => void; timeZone: string })`
    in `components/segment-figures.tsx` — one labelled field per segment.

- [ ] **Step 1: Write the failing test**

Append to `describe("correcting a finished cycle's official percentage", …)` in
`tests/components/correct-official.test.tsx` (it has `START`, `END`, `historyContext`, `sent()`, `refresh`, and
fake timers with a stubbed `fetch`):

```tsx
  it("in the summary-only view: a cycle with keep resets shows the sum, and corrects one segment", async () => {
    const MID = START + 3 * 86_400_000;
    const summary: CycleSummary = {
      v: 1,
      start: START,
      end: END,
      total: 1_000,
      limit: null,
      official: 100,
      groups: {},
      machines: 1,
      models: {},
      subLimits: {},
      archivedAt: END,
      segments: [
        { start: START, end: MID, official: 80, total: 500, groups: {} },
        { start: MID, end: END, official: 20, total: 500, groups: {} },
      ],
    };
    renderWithIntl(
      <ArchivedCycleView
        summaries={[{ id: "claude", label: "Claude", summary }]}
        historyByProvider={{ claude: [summary] }}
        historyContext={historyContext}
        timeZone="Europe/Budapest"
        selectedStartMs={START}
        pastCycle
        costEstimate={false}
      />,
    );

    expect(screen.getAllByText("100%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("(80% + 20%)").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    const fields = screen.getAllByRole("textbox", { name: /Official percentage/ });
    expect(fields.map((field) => (field as HTMLInputElement).value)).toEqual(["80", "20"]);

    fireEvent.change(fields[1]!, { target: { value: "44" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sent(fetchMock)).toEqual([
      {
        path: "/api/official-usage/archived",
        body: { providerId: "claude", raw: "44", cycleStartMs: START, segmentStartMs: MID },
      },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);

    // Back to the figure: the sum follows the corrected segment.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("124%")).toBeDefined();
    expect(screen.getAllByText("(80% + 44%)").length).toBeGreaterThan(0);
  });
```

Run: `npx vitest run tests/components/correct-official.test.tsx`
Expected: FAIL — one field with "100", no segment fields.

- [ ] **Step 2: The hook**

In `components/use-official-entry.ts`, the `body` parameter of `putOfficialUsage` becomes
`{ providerId: string; subLimitId?: string | null; raw: string; cycleStartMs: number; segmentStartMs?: number }`,
and append:

```ts
/**
 * A finished cycle's figures when it had keep resets, one per segment, keyed
 * by the segment's start (lib/history.ts `CycleSegmentSummary`): each is
 * corrected on its own (app/api/official-usage/archived/route.ts,
 * `segmentStartMs`), and once saved the page is refreshed, so the
 * previous-cycles list shows the new sum. Each start carries its own save
 * status, as `useSubLimitEntries` does for a sub-limit; `server` changes
 * reach a field only while no edit of it is on its way.
 */
export function useSegmentEntries(
  providerId: string,
  cycleStartMs: number,
  segments: { startMs: number; official: number | null }[],
  closedAtMs: number,
): [Map<number, Entry>, (startMs: number, raw: string) => void, Map<number, EntryStatus>] {
  const router = useRouter();
  const toEntry = (official: number | null): Entry =>
    official === null ? EMPTY_ENTRY : { raw: String(official), enteredAt: closedAtMs };
  const [entries, setEntries] = useState<Map<number, Entry>>(
    () => new Map(segments.map((segment) => [segment.startMs, toEntry(segment.official)])),
  );
  const [statuses, setStatuses] = useState<Map<number, EntryStatus>>(new Map());
  const pending = useRef<Set<number>>(new Set());
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  // A stable dependency for the effect: the segments are a new array every render.
  const serverKey = segments.map((segment) => `${segment.startMs}=${segment.official ?? ""}`).join("\n");

  // biome-ignore lint/correctness/useExhaustiveDependencies: `serverKey` stands in for the ever-new `segments`
  useEffect(() => {
    setEntries((current) => {
      const next = new Map<number, Entry>();
      for (const segment of segments) {
        next.set(
          segment.startMs,
          pending.current.has(segment.startMs)
            ? (current.get(segment.startMs) ?? EMPTY_ENTRY)
            : toEntry(segment.official),
        );
      }
      return next;
    });
  }, [serverKey]);

  const update = useCallback(
    (startMs: number, raw: string) => {
      const next: Entry = raw.trim() === "" ? EMPTY_ENTRY : { raw, enteredAt: closedAtMs };
      setEntries((current) => new Map(current).set(startMs, next));
      setStatuses((current) => new Map(current).set(startMs, { status: "saving", problem: null }));
      pending.current.add(startMs);
      clearTimeout(timers.current.get(startMs));
      timers.current.set(
        startMs,
        setTimeout(() => {
          void putOfficialUsage("/api/official-usage/archived", {
            providerId,
            raw: next.raw,
            cycleStartMs,
            segmentStartMs: startMs,
          })
            .then((result) => {
              setStatuses((current) =>
                new Map(current).set(
                  startMs,
                  result.ok ? { status: "saved", problem: null } : { status: "failed", problem: result.reason },
                ),
              );
              if (result.ok) router.refresh();
            })
            .finally(() => {
              pending.current.delete(startMs);
            });
        }, DEBOUNCE_MS),
      );
    },
    [providerId, cycleStartMs, closedAtMs, router],
  );

  return [entries, update, statuses];
}
```

- [ ] **Step 3: The fields**

Add the messages:

```bash
node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const add = {
  en: {
    segment_figures_hint:
      "This cycle had usage resets: enter the figure each stretch ended on. The cycle's figure is their sum.",
    segment_figure_label: "Official percentage",
  },
  hu: {
    segment_figures_hint:
      "Ebben a ciklusban volt reset: add meg, mennyin zárult egy-egy szakasz. A ciklus értéke ezek összege.",
    segment_figure_label: "Hivatalos százalék",
  },
  de: {
    segment_figures_hint:
      "In diesem Zyklus gab es Resets: Gib für jeden Abschnitt den Wert an, mit dem er endete. Der Wert des Zyklus ist ihre Summe.",
    segment_figure_label: "Offizieller Prozentsatz",
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

Create `components/segment-figures.tsx`:

```tsx
"use client";

import { useLocale, useTranslations } from "next-intl";
import { StatusLine } from "@/components/status-line";
import { EMPTY_ENTRY, type Entry, type EntryStatus } from "@/components/use-official-entry";
import { formatCycleRange } from "@/lib/format";
import { parseOfficialPercent } from "@/lib/ground-truth";

/**
 * A finished cycle with keep resets, corrected one segment at a time: a field
 * per stretch between its resets, labelled with when it ran
 * (components/use-official-entry.ts `useSegmentEntries` keeps and saves them).
 */
export function SegmentFigures({
  segments,
  entries,
  statuses,
  onChange,
  timeZone,
}: {
  segments: { startMs: number; endMs: number }[];
  entries: Map<number, Entry>;
  statuses: Map<number, EntryStatus>;
  onChange: (startMs: number, raw: string) => void;
  timeZone: string;
}) {
  const locale = useLocale();
  const t = useTranslations("Widgets");
  return (
    <div>
      <p className="max-w-3xl text-sm text-ink-3">{t("segment_figures_hint")}</p>
      <ul className="mt-3 space-y-3">
        {segments.map((segment) => {
          const entry = entries.get(segment.startMs) ?? EMPTY_ENTRY;
          const { invalid } = parseOfficialPercent(entry.raw);
          const status = statuses.get(segment.startMs);
          return (
            <li key={segment.startMs}>
              <label className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                <span className="sr-only">{t("segment_figure_label")}</span>
                <span className="min-w-56 text-sm text-ink-2 tabular-nums">
                  {formatCycleRange(segment.startMs, segment.endMs, timeZone, locale)}
                </span>
                <span className="relative">
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    maxLength={7}
                    placeholder="–"
                    value={entry.raw}
                    onChange={(event) => onChange(segment.startMs, event.target.value)}
                    aria-invalid={invalid || undefined}
                    className="block w-24 rounded-md border border-rule bg-page py-1 pl-3 pr-8 text-lg font-medium tabular-nums text-ink placeholder:text-ink-3"
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-3"
                  >
                    %
                  </span>
                </span>
              </label>
              {invalid && <p className="mt-1 text-sm text-ink">{t("number_between_0_100")}</p>}
              {status?.status === "failed" && status.problem && (
                <div className="mt-1">
                  <StatusLine tone="problem">{t(`official_save_failed_${status.problem}`)}</StatusLine>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: The summary-only view**

In `components/archived-cycle-view.tsx`, import `SegmentFigures` from `@/components/segment-figures`,
`useSegmentEntries` and `EMPTY_ENTRY` from `@/components/use-official-entry` (next to `useOfficialEntry`), and
`sumOfFigures` from `@/lib/history`. In `ArchivedOfficialFigure`, after the `useOfficialEntry(…)` call add:

```tsx
  // A cycle with keep resets came to the sum of its segments' figures, each corrected on its own.
  const pastSegments = (summary.segments ?? []).map((segment) => ({
    startMs: segment.start,
    endMs: segment.end,
    official: segment.official,
  }));
  const segmented = pastSegments.length > 0;
  const [segmentEntries, setSegmentEntry, segmentStatuses] = useSegmentEntries(
    providerId,
    summary.start,
    pastSegments,
    summary.end,
  );
  const segmentFigures = pastSegments.map(
    (segment) => parseOfficialPercent((segmentEntries.get(segment.startMs) ?? EMPTY_ENTRY).raw).percent,
  );
```

and replace the line `const { percent: official, invalid } = parseOfficialPercent(entry.raw);` with:

```tsx
  const own = parseOfficialPercent(entry.raw);
  const official = segmented ? sumOfFigures(segmentFigures) : own.percent;
  const invalid = segmented ? false : own.invalid;
  const parts = segmented
    ? segmentFigures.map((figure) => (figure === null ? "–" : formatPercent(figure / 100, locale))).join(" + ")
    : null;
```

(keep this after the hooks). Then:
- in the `correcting` branch, render, for a segmented summary, the per-segment fields instead of the single input:
  replace the `<dd className="mt-1 flex flex-wrap items-center gap-2">…</dd>` block with

  ```tsx
        <dd className="mt-1 flex flex-wrap items-start gap-2">
          {segmented ? (
            <SegmentFigures
              segments={pastSegments}
              entries={segmentEntries}
              statuses={segmentStatuses}
              onChange={setSegmentEntry}
              timeZone={timeZone}
            />
          ) : (
            /* the existing <span className="relative"> with the single input, unchanged */
          )}
          {/* the existing Done button, unchanged */}
        </dd>
  ```

  keeping the existing single-input `<span className="relative">…</span>` and the Done `<button>` exactly as they are;
- in the read-only branch, right after the figure's `<span className="text-2xl …">`, add
  `{parts && official !== null && <span className="text-sm tabular-nums text-ink-3">({parts})</span>}`.

`ArchivedOfficialFigure` needs the time zone: add a `timeZone: string` prop and pass `timeZone={timeZone}` where
`ArchivedCycleView` renders it.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/components/correct-official.test.tsx tests/messages.test.ts`
Expected: PASS (the two existing correction tests too).

- [ ] **Step 6: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add components/use-official-entry.ts components/segment-figures.tsx components/archived-cycle-view.tsx messages/en.json messages/hu.json messages/de.json tests/components/correct-official.test.tsx
git commit -m "feat(resets): correct a past cycle's figure one segment at a time"
```

### Task 5: A closed cycle's model carries its segments (lib)

**Files:**
- Modify: `lib/timeline.ts` (`buildTimeline` gains `fromMs`)
- Modify: `lib/dashboard.ts` (`PastSegment`, `DashboardModel.pastSegments`, `StoreSnapshot.archivedSegments`, `ProviderStoreSnapshot.history`, `resetMoments`, `buildDashboard`, `buildProviderDashboards`)
- Modify: `lib/ground-truth.ts` (`DashboardView.segmentFigures`, `applySegmentFigures`, `timelineRates`)
- Modify: `app/[locale]/(dashboard)/page.tsx` (the detail branch's store)
- Test: `tests/timeline.test.ts`, `tests/dashboard.test.ts`, `tests/ground-truth.test.ts`

**Interfaces:**
- Consumes: `CycleSummary`, `CycleSegmentSummary` (`lib/history.ts`); plan 2's `buildTimeline(…, resetsMs)` (lines restart at
  each of `resetsMs`, R − 1 and R sampled), `DashboardModel.resets/segment`, `timelineRates`, `applyGroundTruth`.
- Produces:
  - `buildTimeline(events, groupIds, window, nowMs, mode, modelEvents = events, resetsMs = [], fromMs = resetsMs.at(-1) ?? window.startMs)`
    — a model's `tokens` and `cost` count every segment from `fromMs` on.
  - `export interface PastSegment { startMs: number; endMs: number; official: number | null; total: number; groups: Record<string, number>; machines: { machineId: string; groupId: string; tokens: number }[] }`
  - `DashboardModel.pastSegments: PastSegment[]` (closed cycle with ≥ 2 archived segments; else `[]`)
  - `StoreSnapshot.archivedSegments?: CycleSegmentSummary[]`; `ProviderStoreSnapshot.history?: Record<string, CycleSummary[]>`
  - `resetMoments(model: Pick<DashboardModel, "resets" | "pastSegments">): number[]` — where the timeline's lines restart
  - `applySegmentFigures(model: DashboardModel, figures: (number | null)[]): DashboardView`; `DashboardView.segmentFigures?: (number | null)[]`

- [ ] **Step 1: Write the failing tests**

Append to `describe("buildTimeline across a keep reset", …)` in `tests/timeline.test.ts`:

```ts
  it("counts a model across every segment from fromMs on, lines still restarting at the reset", () => {
    const priced: UsageEvent[] = [
      { ...report("mac", "Personal", 100, 1, { "claude-opus-4-1": 100 }), costUsd: 1, modelCosts: { "claude-opus-4-1": 1 } },
      { ...report("mac", "Personal", 60, 4, { "claude-opus-4-1": 60 }), costUsd: 1.5, modelCosts: { "claude-opus-4-1": 1.5 } },
    ];
    const timeline = buildTimeline(priced, ["Personal"], WEEK, NOW, "delta", priced, [RESET], WEEK.startMs);
    expect(timeline.models.map((model) => [model.modelId, model.tokens])).toEqual([["claude-opus-4-1", 160]]);
    expect(timeline.models[0]!.cost).toBeCloseTo(1.5);
    expect(timeline.groups[0]!.values.at(-1)).toBe(60);
  });
```

In `tests/dashboard.test.ts` change the `@/lib/dashboard` import to
`import { buildDashboard, buildProviderDashboards, resetMoments, type StoreSnapshot } from "@/lib/dashboard";`,
add `import type { CycleSummary } from "@/lib/history";`, and append:

```ts
describe("buildDashboard — a closed cycle with keep resets", () => {
  const R = CYCLE_START + 38 * HOUR;
  const END = CYCLE_START + 168 * HOUR;
  const window = {
    cycle: { start: new Date(CYCLE_START), end: new Date(END) },
    previous: { start: new Date(CYCLE_START - 168 * HOUR), end: new Date(CYCLE_START) },
  };
  // As archived: the segments' bounds and figures (their archived totals are not what the model reads).
  const archivedSegments = [
    { start: CYCLE_START, end: R, official: 80, total: 0, groups: {} },
    { start: R, end: END, official: 44, total: 0, groups: {} },
  ];
  const events = [report("win", "Work", 30_000, 10), report("mac", "Home", 20_000, 20), report("win", "Work", 12_000, 40)];
  const later = new Date(END + 32 * HOUR);
  const closed = buildDashboard(later, config, snapshot({ events, archivedSegments }), [], window);

  it("counts the whole cycle, and carries each segment's measured tokens with its archived figure", () => {
    expect(closed.total).toBe(62_000);
    expect(closed.segment.startMs).toBe(CYCLE_START);
    expect(closed.resets).toEqual([]);
    expect(closed.pastSegments).toEqual([
      {
        startMs: CYCLE_START,
        endMs: R,
        official: 80,
        total: 50_000,
        groups: { Work: 30_000, Home: 20_000 },
        machines: [
          { machineId: "win", groupId: "Work", tokens: 30_000 },
          { machineId: "mac", groupId: "Home", tokens: 20_000 },
        ],
      },
      {
        startMs: R,
        endMs: END,
        official: 44,
        total: 12_000,
        groups: { Work: 12_000 },
        machines: [{ machineId: "win", groupId: "Work", tokens: 12_000 }],
      },
    ]);
  });

  it("restarts its timeline's lines at each segment", () => {
    const { times, groups } = closed.timeline;
    const work = groups.find((group) => group.groupId === "Work")!;
    expect(work.values[times.indexOf(R - 1)]).toBe(30_000);
    expect(work.values[times.indexOf(R)]).toBe(0);
    expect(work.values.at(-1)).toBe(12_000);
    expect(resetMoments(closed)).toEqual([R]);
  });

  it("has no segments with a single archived one, and ignores archived ones for an open cycle", () => {
    const single = buildDashboard(later, config, snapshot({ events, archivedSegments: archivedSegments.slice(0, 1) }), [], window);
    expect(single.pastSegments).toEqual([]);
    expect(resetMoments(single)).toEqual([]);
    const open = buildDashboard(NOW, config, snapshot({ events, archivedSegments }));
    expect(open.pastSegments).toEqual([]);
  });

  it("reads a past cycle's segments from the provider's archived summary", () => {
    const summary: CycleSummary = {
      v: 1,
      start: CYCLE_START,
      end: END,
      total: 62_000,
      limit: null,
      official: 124,
      groups: {},
      machines: 2,
      models: {},
      subLimits: {},
      archivedAt: END,
      segments: archivedSegments,
    };
    const [claude] = buildProviderDashboards(
      later,
      config,
      ["claude"],
      { eventsByProvider: { claude: events }, groups: [], machines: [], history: { claude: [summary] } },
      new Map(),
      window,
    );
    expect(claude!.dashboard.pastSegments.map((segment) => segment.official)).toEqual([80, 44]);
  });
});
```

In `tests/ground-truth.test.ts` change the `@/lib/ground-truth` import to
`import { applyGroundTruth, applySegmentFigures, parseOfficialPercent, timelineRates } from "@/lib/ground-truth";`
and append:

```ts
describe("applySegmentFigures — a closed cycle with keep resets", () => {
  const R = CYCLE_START + 38 * HOUR;
  const END = CYCLE_START + 168 * HOUR;
  const closed = buildDashboard(
    new Date(END + 32 * HOUR),
    config,
    {
      events: [report("win-1", "Work", 30_000, 10), report("mac", "Home", 20_000, 20), report("win-1", "Work", 12_000, 40)],
      groups: [],
      machines: [],
      archivedSegments: [
        { start: CYCLE_START, end: R, official: 80, total: 0, groups: {} },
        { start: R, end: END, official: 44, total: 0, groups: {} },
      ],
    },
    [],
    {
      cycle: { start: new Date(CYCLE_START), end: new Date(END) },
      previous: { start: new Date(CYCLE_START - 168 * HOUR), end: new Date(CYCLE_START) },
    },
  );

  it("comes to the sum of the figures, each split by its own segment's tokens", () => {
    const view = applySegmentFigures(closed, [80, 44]);
    expect(view.calibrated).toBe(true);
    expect(view.quota!.usedFraction).toBeCloseTo(1.24);
    expect(view.segmentFigures).toEqual([80, 44]);
    // Work: 30k of the first segment's 50k at 80%, all of the second's 12k at 44%. Home: 20k of 50k at 80%.
    const work = view.groups.find((group) => group.groupId === "Work")!;
    const home = view.groups.find((group) => group.groupId === "Home")!;
    expect(work.limitShare).toBeCloseTo(0.92);
    expect(home.limitShare).toBeCloseTo(0.32);
    expect(work.tokens).toBeCloseTo(0.92 * 500_000);
    expect(view.machines.find((machine) => machine.machineId === "win-1")!.limitShare).toBeCloseTo(0.92);
  });

  it("leaves a segment without a figure out, and is the measured view with none known", () => {
    expect(applySegmentFigures(closed, [null, 44]).quota!.usedFraction).toBeCloseTo(0.44);
    const measured = applySegmentFigures(closed, [null, null]);
    expect(measured.calibrated).toBe(false);
    expect(measured.segmentFigures).toBeUndefined();
  });

  it("rates each segment of the timeline at its own figure, an unknown one at the token limit's rate", () => {
    const { times } = closed.timeline;
    const rates = timelineRates(closed, applySegmentFigures(closed, [80, 44]))!;
    expect(rates[times.indexOf(R - 1)]).toBeCloseTo(0.8 / 50_000);
    expect(rates.at(-1)).toBeCloseTo(0.44 / 12_000);
    const partial = timelineRates(closed, applySegmentFigures(closed, [null, 44]))!;
    expect(partial[times.indexOf(R - 1)]).toBeCloseTo(1 / 500_000);
  });
});
```

Run: `npx vitest run tests/timeline.test.ts tests/dashboard.test.ts tests/ground-truth.test.ts`
Expected: FAIL — `resetMoments` and `applySegmentFigures` are not exported; the model's tokens are the last segment's (60).

- [ ] **Step 2: `buildTimeline` counts a model from `fromMs`**

In `lib/timeline.ts`, change the doc of `ModelTimeline.tokens` to
`/** Its tokens since the timeline's \`fromMs\` (the current segment's start; a closed cycle's start), over all groups. */`
and of `ModelTimeline.cost` to `/** Its API-list-price cost estimate since the same moment, over all groups; undefined without a cost split naming it. */`.
In `buildTimeline`, add the parameter `fromMs: number = resetsMs.at(-1) ?? window.startMs` after `resetsMs`, extend its
doc comment's last sentence to "…every line restarts from 0 at each, and a model's tokens and cost count every segment
from `fromMs` on (by default the last one: the current segment).", delete the line
`const segmentStartMs = resetsMs.at(-1) ?? window.startMs;`, and replace the models' `tokens`/`cost` lines:

```ts
  // Where each segment from `fromMs` on ends on the timeline: right before each later reset, and at the last sample.
  const segmentEnds = [
    ...resetsMs.filter((atMs) => atMs > fromMs).map((atMs) => times.indexOf(atMs - 1)),
    last,
  ].filter((index) => index >= 0);
```

(placed right after `const last = times.length - 1;`), and inside the `.map((key) => …)`:

```ts
      const tokens = groups.reduce(
        (sum, group) => sum + segmentEnds.reduce((part, index) => part + group.values[index]!, 0),
        0,
      );
      const cost = modelCostTotal(modelEvents, key, window, fromMs);
```

- [ ] **Step 3: The closed model's segments**

In `lib/dashboard.ts`:

Add `import type { CycleSegmentSummary, CycleSummary } from "@/lib/history";`.

`StoreSnapshot` gains:

```ts
  /** A closed cycle's segments as archived (lib/history.ts `CycleSummary.segments`); an open cycle ignores them. */
  archivedSegments?: CycleSegmentSummary[];
```

`ProviderStoreSnapshot` gains:

```ts
  /** Every provider's archived cycles (lib/usage-store.ts `loadHistory`): a past cycle's segments are its summary's. */
  history?: Record<string, CycleSummary[]>;
```

Add after `DashboardReset`:

```ts
/** A closed cycle's stretch between its keep resets, as archived (lib/history.ts), with what was measured in it. */
export interface PastSegment {
  startMs: number;
  endMs: number;
  /** 0–100: the figure it ended on, as archived; null when unknown. */
  official: number | null;
  /** Tokens the machines measured in it (a separate sub-limit's are not among them). */
  total: number;
  /** groupId → measured tokens in it. */
  groups: Record<string, number>;
  /** Every machine's measured tokens in it, within its group. */
  machines: { machineId: string; groupId: string; tokens: number }[];
}
```

`DashboardModel` gains, after `resets`:

```ts
  /**
   * A closed cycle's segments, from its archived summary (lib/history.ts: its
   * keep-reset events may be pruned by now), when it had keep resets; none for
   * an open cycle (its segments are `resets` and `segment`) and for a cycle
   * without them. The timeline's lines restart at each.
   */
  pastSegments: PastSegment[];
```

Add after `segmentSince`:

```ts
/** Where the timeline's lines restart: an open cycle's keep resets, a closed cycle's segments after its first. */
export function resetMoments(model: Pick<DashboardModel, "resets" | "pastSegments">): number[] {
  return model.pastSegments.length > 0
    ? model.pastSegments.slice(1).map((segment) => segment.startMs)
    : model.resets.flatMap((reset) => (reset.kind === "keep" ? [reset.atMs] : []));
}
```

In `buildDashboard`, after `const segmentStartMs = resetsMs.at(-1) ?? startMs;` add:

```ts
  // A closed cycle counts whole; its archived segments restart the timeline's lines and split its figure.
  const archived = closed && (snapshot.archivedSegments?.length ?? 0) > 1 ? snapshot.archivedSegments! : [];
  const linesRestartMs = closed ? archived.slice(1).map((segment) => segment.start) : resetsMs;
```

change the `buildTimeline(…)` call's last argument `resetsMs` to `linesRestartMs, segmentStartMs` (`segmentStartMs` is
the cycle's start for a closed cycle), and add to the returned object, after `resets`:

```ts
    pastSegments: archived.map((segment) => {
      const usage = summarizeUsage(split.main, { startMs, endMs: segment.end }, config.tokenMode, segment.start);
      return {
        startMs: segment.start,
        endMs: segment.end,
        official: segment.official,
        total: usage.total,
        groups: Object.fromEntries(usage.groups.map((group) => [group.groupId, group.tokens])),
        machines: usage.series.map((series) => ({
          machineId: series.machineId,
          groupId: series.groupId,
          tokens: series.tokens,
        })),
      };
    }),
```

In `buildProviderDashboards`, inside the `map` callback, after `const resets = …` add:

```ts
    // A past cycle's segments are its archived summary's.
    const archivedSegments = window
      ? (store.history?.[providerId] ?? []).find((entry) => entry.start === window.cycle.start.getTime())?.segments
      : undefined;
```

and add `...(archivedSegments && { archivedSegments }),` to the snapshot object passed to `buildDashboard` (after `resets,`).

In `app/[locale]/(dashboard)/page.tsx`, the detail branch's store `{ ...store, machines: [] }` becomes
`{ ...store, machines: [], history: historyByProvider }`.

- [ ] **Step 4: Restating a closed cycle by its segments**

In `lib/ground-truth.ts`, `DashboardView` gains:

```ts
  /** A closed cycle's segment figures it was restated by (`applySegmentFigures`), one per `model.pastSegments`; absent otherwise. */
  segmentFigures?: (number | null)[];
```

Add after `applyGroundTruth` (import `PastSegment` as a type from `@/lib/dashboard`, next to `DashboardModel`):

```ts
/**
 * A closed cycle with keep resets restated by its segments' figures
 * (`model.pastSegments`, one figure per segment, 0–100 or null): the cycle came
 * to their sum, which can pass 100%, and every group and machine gets, for
 * each segment, its part of that segment's measured tokens times the segment's
 * figure, added up. A segment without a figure adds nothing; with none known
 * this is the measured view.
 */
export function applySegmentFigures(model: DashboardModel, figures: (number | null)[]): DashboardView {
  const known = figures.filter((figure): figure is number => figure !== null);
  if (known.length === 0) return applyGroundTruth(model, null);

  const inTokens = model.quota !== null;
  const limit = model.quota?.limit ?? 1;
  const officialTotal = (known.reduce((sum, figure) => sum + figure, 0) / 100) * limit;
  const asOfMs = Math.min(model.generatedAt, model.cycle.endMs);
  const partOf = (tokensIn: (segment: PastSegment) => number) =>
    model.pastSegments.reduce((sum, segment, index) => {
      const figure = figures[index];
      return figure === null || figure === undefined || segment.total <= 0
        ? sum
        : sum + (figure / 100) * (tokensIn(segment) / segment.total);
    }, 0);
  const restate = <T extends { tokens: number }>(row: T, tokensIn: (segment: PastSegment) => number): T => {
    const limitShare = partOf(tokensIn);
    return { ...row, limitShare, tokens: inTokens ? limitShare * limit : row.tokens };
  };

  return {
    calibrated: true,
    quota: assessQuota(officialTotal, limit, { startMs: model.cycle.startMs, endMs: model.cycle.endMs, nowMs: asOfMs }),
    inTokens,
    measured: { total: model.total, usedFraction: model.quota?.usedFraction ?? null },
    scale: inTokens && model.total > 0 ? officialTotal / model.total : null,
    asOfMs,
    groups: model.groups.map((group) =>
      restate(group, (segment) => (Object.hasOwn(segment.groups, group.groupId) ? segment.groups[group.groupId]! : 0)),
    ),
    machines: model.machines.map((machine) =>
      restate(
        machine,
        (segment) =>
          segment.machines.find((row) => row.machineId === machine.machineId && row.groupId === machine.groupId)
            ?.tokens ?? 0,
      ),
    ),
    segmentFigures: figures,
  };
}
```

Replace `timelineRates` with:

```ts
/**
 * What one measured token on the timeline (lib/timeline.ts) is as a fraction
 * of the budget, at each of its samples. The current segment's tokens go at
 * the headline figure over its measured tokens (1/limit without a reading).
 * Under an official reading, a finished segment's go at its own before-figure
 * over the tokens measured in it (lib/resets.ts); one whose figure is unknown
 * takes the current rate. A closed cycle's segments (`model.pastSegments`) go
 * at the figures it was restated by (`applySegmentFigures`). Null while
 * nothing tells how much of the budget is gone: no token limit and no reading.
 */
export function timelineRates(model: DashboardModel, view: DashboardView): number[] | null {
  const { quota } = view;
  if (!quota) return null;
  // Right after a reset nothing is measured yet: the segment's samples are all 0, the limit's rate is as good as any.
  const current = model.total > 0 ? quota.usedFraction / model.total : view.inTokens ? 1 / quota.limit : 0;
  if (model.pastSegments.length > 0) return pastSegmentRates(model, view, current);
  const keeps = model.resets.filter((reset) => reset.kind === "keep");
  return model.timeline.times.map((ms) => {
    // The reset that ends the segment this sample falls in; none in the current segment.
    const ending = keeps.find((reset) => reset.atMs > ms);
    if (!ending || !view.calibrated || ending.before === null || !ending.tokens) return current;
    return ending.before / 100 / ending.tokens;
  });
}

/**
 * A closed cycle's rates: each segment's tokens at its own figure over the
 * tokens measured in it. A segment without a figure goes at the token
 * limit's rate, or, without a limit, at the known segments' average rate;
 * every segment does while the view is the measured one.
 */
function pastSegmentRates(model: DashboardModel, view: DashboardView, current: number): number[] {
  const figures = view.segmentFigures;
  if (!figures) return model.timeline.times.map(() => current);
  const known = model.pastSegments.flatMap((segment, index) => {
    const figure = figures[index];
    return figure !== null && figure !== undefined && segment.total > 0 ? [{ figure, total: segment.total }] : [];
  });
  const knownTokens = known.reduce((sum, { total }) => sum + total, 0);
  const fallback =
    view.inTokens && view.quota
      ? 1 / view.quota.limit
      : knownTokens > 0
        ? known.reduce((sum, { figure }) => sum + figure / 100, 0) / knownTokens
        : 0;
  const last = model.pastSegments.length - 1;
  return model.timeline.times.map((ms) => {
    const found = model.pastSegments.findIndex((segment) => ms < segment.endMs);
    const index = found < 0 ? last : found;
    const segment = model.pastSegments[index]!;
    const figure = figures[index];
    return figure === null || figure === undefined || segment.total <= 0 ? fallback : figure / 100 / segment.total;
  });
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/timeline.test.ts tests/dashboard.test.ts tests/ground-truth.test.ts tests/group-machines.test.ts`
Expected: PASS.

- [ ] **Step 6: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add lib/timeline.ts lib/dashboard.ts lib/ground-truth.ts "app/[locale]/(dashboard)/page.tsx" tests/timeline.test.ts tests/dashboard.test.ts tests/ground-truth.test.ts
git commit -m "feat(resets): carry a closed cycle's archived segments in its model and restate it by them"
```

### Task 6: A closed cycle's charts mark its segments

**Files:**
- Modify: `components/cycle-chart.tsx` (reset moments), `components/usage-chart.tsx` (veils, description),
  `components/model-chart.tsx` and `components/group-machines.tsx` (the "restarts at each reset" wording)
- Modify: `messages/en.json`, `messages/hu.json`, `messages/de.json` (`Widgets.group_machines_desc`)
- Test: `tests/components/usage-chart.test.tsx`, `tests/components/model-chart.test.tsx`, `tests/components/group-breakdown.test.tsx`

**Interfaces:**
- Consumes (Task 5): `resetMoments(model)`, `DashboardModel.pastSegments`, `applySegmentFigures`,
  `DashboardView.segmentFigures`. `Widgets.measured_tokens_by_group` already takes `since: "reset" | "cycle"`.
- Produces: nothing other tasks use.

- [ ] **Step 1: Write the failing tests**

Append to `tests/components/usage-chart.test.tsx` (add `applySegmentFigures` to its `@/lib/ground-truth` import;
it has `NOW`, `HOUR`, `config` with a 500k token limit, `S` the cycle start):

```tsx
describe("UsageChart — a closed cycle with keep resets", () => {
  const END = S + 7 * 24 * HOUR;
  const R = S + 38 * HOUR;
  const closed = buildDashboard(
    new Date(END + 32 * HOUR),
    config,
    {
      events: [
        { machineId: "win-1", groupId: "Work", tokens: 30_000, ts: S + HOUR },
        { machineId: "win-1", groupId: "Work", tokens: 12_000, ts: R + HOUR },
      ],
      groups: [],
      machines: [],
      archivedSegments: [
        { start: S, end: R, official: null, total: 0, groups: {} },
        { start: R, end: END, official: 44, total: 0, groups: {} },
      ],
    },
    [],
    {
      cycle: { start: new Date(S), end: new Date(END) },
      previous: { start: new Date(S - 7 * 24 * HOUR), end: new Date(S) },
    },
  );

  it("marks the reset, and fades a segment that has no figure", () => {
    renderWithIntl(<UsageChart model={closed} view={applySegmentFigures(closed, [null, 44])} subLimits={[]} />);
    expect(screen.getByText("reset")).toBeDefined();
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(1);
    expect(screen.getByText(/every line starts again from 0/)).toBeDefined();
  });

  it("draws every segment plainly when each has its figure", () => {
    renderWithIntl(<UsageChart model={closed} view={applySegmentFigures(closed, [80, 44])} subLimits={[]} />);
    expect(document.querySelectorAll("[data-pale]")).toHaveLength(0);
  });
});
```

Append to `tests/components/model-chart.test.tsx` (it has `HOUR`, `CYCLE_START`, `events` — Work's 30k of
`claude-opus-4` at hour 10 — and imports `buildDashboard`, `getConfig`, `renderWithIntl`, `ModelChart`):

```tsx
describe("ModelChart — a closed cycle with keep resets", () => {
  it("says the lines start again from 0 at each of its resets", () => {
    const END = CYCLE_START + 168 * HOUR;
    const R = CYCLE_START + 38 * HOUR;
    const config = {
      ...getConfig({}),
      tokenMode: "delta" as const,
      reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
    };
    const closed = buildDashboard(
      new Date(END + 32 * HOUR),
      config,
      {
        events: [
          ...events,
          { machineId: "win", groupId: "Work", tokens: 12_000, ts: R + HOUR, models: { "claude-opus-4": 12_000 } },
        ],
        groups: [],
        machines: [],
        archivedSegments: [
          { start: CYCLE_START, end: R, official: 80, total: 0, groups: {} },
          { start: R, end: END, official: 44, total: 0, groups: {} },
        ],
      },
      [],
      {
        cycle: { start: new Date(CYCLE_START), end: new Date(END) },
        previous: { start: new Date(CYCLE_START - 168 * HOUR), end: new Date(CYCLE_START) },
      },
    );
    renderWithIntl(<ModelChart model={closed} />);
    expect(screen.getByText(/starting again from 0 at each reset/)).toBeDefined();
  });
});
```

Append to `tests/components/group-breakdown.test.tsx`:

```tsx
describe("GroupBreakdown — after a keep reset", () => {
  it("says the machines' lines start again from 0 at each reset", () => {
    const model = buildDashboard(
      NOW,
      {
        ...getConfig({}),
        tokenMode: "delta" as const,
        useTokenLimits: false,
        // Fixed to Budapest time: the reset's cycle must be the model's.
        reset: { ...getConfig({}).reset, timeZone: "Europe/Budapest" },
      },
      {
        events: [report("mac", "Personal", 10_000), { machineId: "mac", groupId: "Personal", tokens: 5_000, ts: CYCLE_START + 40 * HOUR }],
        groups: [],
        machines: [],
        resets: [
          {
            id: "k",
            atMs: CYCLE_START + 38 * HOUR,
            kind: "keep",
            cycleStartMs: CYCLE_START,
            before: 80,
            beforeAtMs: null,
            source: "manual",
            recordedAtMs: CYCLE_START + 38 * HOUR,
          },
        ],
      },
    );
    renderWithIntl(<GroupBreakdown model={model} view={applyGroundTruth(model, null)} />);
    fireEvent.click(screen.getByRole("button", { name: /Personal/ }));
    expect(screen.getByText(/accumulated since the start of the cycle, starting again from 0 at each reset/)).toBeDefined();
  });
});
```

(`report()` in that file puts a report at hour 10 of the cycle; the second report is after the reset.)

Run: `npx vitest run tests/components/usage-chart.test.tsx tests/components/model-chart.test.tsx tests/components/group-breakdown.test.tsx`
Expected: FAIL — no marker or veil on the closed chart; no "starting again" wording.

- [ ] **Step 2: Markers, veils and wording**

Replace the value of `Widgets.group_machines_desc` in the three files (a node script that reads each file, sets the
key and writes back `JSON.stringify(messages, null, 2) + "\n"`):

- en: `{basis, select, official {The official percentage, distributed among the machines according to their measured token proportions.} measured {In percentage of the token limit, as measured by the machines.} other {The machines' measured tokens, accumulated since the start of the cycle{since, select, reset {, starting again from 0 at each reset} other {}}: without an official percentage there is no quota to compare them to.}} Next to each machine: its tokens, and its share of the group's consumption.`
- hu: `{basis, select, official {A hivatalos százalék, a gépek között a mért tokenjeik arányában elosztva.} measured {A tokenkeret százalékában, a gépek mérése szerint.} other {A gépek mért tokenjei a ciklus eleje óta összesítve{since, select, reset {, minden resetnél újra 0-ról indulva} other {}}: hivatalos százalék nélkül nincs keret, amihez viszonyítani lehetne.}} A gépek neve mellett a tokenjeik és a részesedésük a csoport fogyasztásából.`
- de: `{basis, select, official {Der offizielle Prozentsatz, verteilt auf die Maschinen im Verhältnis ihrer gemessenen Token.} measured {In Prozent des Tokenkontingents, laut Messung der Maschinen.} other {Die gemessenen Token der Maschinen, seit Beginn des Zyklus aufsummiert{since, select, reset {, bei jedem Reset wieder ab 0} other {}}: ohne offiziellen Prozentsatz gibt es kein Kontingent zum Vergleich.}} Neben jeder Maschine: ihre Token und ihr Anteil am Verbrauch der Gruppe.`

In `components/cycle-chart.tsx`, import `resetMoments` from `@/lib/dashboard` (next to the `DashboardModel` type) and
replace

```ts
  const keepMs = model.resets.filter((reset) => reset.kind === "keep").map((reset) => reset.atMs);
```

with

```ts
  const keepMs = resetMoments(model);
```

updating its comment to "Where the lines restart (an open cycle's keep resets, a closed cycle's segments): the samples
right before and at each (lib/timeline.ts) survive the thinning of a long window."

In `components/usage-chart.tsx`, import `resetMoments` from `@/lib/dashboard`, and replace the `paleSpans` and
`measured` definitions with:

```ts
  // Under an official reading, a finished segment without a figure of its own is only an estimate.
  const paleSpans = !view.calibrated
    ? []
    : model.pastSegments.length > 0
      ? model.pastSegments.flatMap((segment, index) =>
          view.segmentFigures?.[index] === null ? [{ startMs: segment.startMs, endMs: segment.endMs }] : [],
        )
      : keeps.flatMap((reset, index) =>
          reset.before === null ? [{ startMs: keeps[index - 1]?.atMs ?? model.cycle.startMs, endMs: reset.atMs }] : [],
        );
  // Right after a reset the segment has nothing measured yet, but the cycle has.
  const measured = model.total > 0 || keeps.some((reset) => (reset.tokens ?? 0) > 0);
  const restarts = resetMoments(model).length > 0;
```

and in the description `{keeps.length > 0 && t("chart_desc_resets")}` becomes `{restarts && t("chart_desc_resets")}`.

In `components/model-chart.tsx`, import `resetMoments` instead of `segmentSince` and the description becomes
`t("measured_tokens_by_group", { since: resetMoments(model).length > 0 ? "reset" : "cycle" })` (its lines restart at an
open cycle's keep resets and at a closed cycle's segments alike).

In `components/group-machines.tsx`, import `resetMoments` from `@/lib/dashboard` and pass
`since: resetMoments(model).length > 0 ? "reset" : "cycle"` to `t("group_machines_desc", { basis, since })`.

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/components/ tests/messages.test.ts`
Expected: PASS.

- [ ] **Step 4: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add components/cycle-chart.tsx components/usage-chart.tsx components/model-chart.tsx components/group-machines.tsx messages/en.json messages/hu.json messages/de.json tests/components/usage-chart.test.tsx tests/components/model-chart.test.tsx tests/components/group-breakdown.test.tsx
git commit -m "feat(resets): mark a closed cycle's segments on its charts"
```

### Task 7: The detail view of a closed cycle with keep resets

**Files:**
- Modify: `components/ground-truth-input.tsx` (`correction` prop)
- Modify: `components/dashboard-view.tsx` (`ProviderView`)
- Modify: `docs/configuration.md` ("Usage resets": past cycles)
- Test: `tests/components/correct-official.test.tsx`

**Interfaces:**
- Consumes: `useSegmentEntries`, `SegmentFigures` (Task 4); `applySegmentFigures`, `DashboardModel.pastSegments`
  (Task 5); `sumOfFigures` (Task 1); `ProviderStoreSnapshot.history` (Task 5).
- Produces: `GroundTruthInput` prop `correction?: React.ReactNode`.

- [ ] **Step 1: Write the failing test**

Append to `describe("correcting a finished cycle's official percentage", …)` in `tests/components/correct-official.test.tsx`:

```tsx
  it("in the full view: a cycle with keep resets came to the sum, and corrects one segment", async () => {
    const MID = START + 3 * 86_400_000;
    const summary: CycleSummary = {
      v: 1,
      start: START,
      end: END,
      total: 0,
      limit: null,
      official: 100,
      groups: {},
      machines: 0,
      models: {},
      subLimits: {},
      archivedAt: END,
      segments: [
        { start: START, end: MID, official: 80, total: 0, groups: {} },
        { start: MID, end: END, official: 20, total: 0, groups: {} },
      ],
    };
    const providers = buildProviderDashboards(
      new Date("2026-10-08T12:00:00Z"),
      getConfig({}),
      ["claude"],
      { eventsByProvider: {}, groups: [], machines: [], history: { claude: [summary] } },
      new Map([["claude", { raw: "100", enteredAt: END }]]),
      {
        cycle: { start: new Date(START), end: new Date(END) },
        previous: { start: new Date(START - 7 * 86_400_000), end: new Date(START) },
      },
    );
    renderWithIntl(
      <DashboardView providers={providers} historyByProvider={{ claude: [summary] }} historyContext={historyContext} pastCycle />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    expect(screen.queryByRole("textbox", { name: "Official consumption at the end of the cycle" })).toBeNull();
    const fields = screen.getAllByRole("textbox", { name: /Official percentage/ });
    expect(fields.map((field) => (field as HTMLInputElement).value)).toEqual(["80", "20"]);

    fireEvent.change(fields[1]!, { target: { value: "44" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(sent(fetchMock)).toEqual([
      {
        path: "/api/official-usage/archived",
        body: { providerId: "claude", raw: "44", cycleStartMs: START, segmentStartMs: MID },
      },
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    // The field and the meter both show the new sum.
    expect(screen.getAllByText("124%").length).toBeGreaterThanOrEqual(2);
  });
```

Run: `npx vitest run tests/components/correct-official.test.tsx`
Expected: FAIL — Correct opens the single field with "100".

- [ ] **Step 2: `GroundTruthInput` takes a per-segment correction**

In `components/ground-truth-input.tsx`, `GroundTruthInputProps` gains, after `belowField`:

```ts
  /**
   * A finished cycle with keep resets: what Correct opens instead of the
   * single field — one field per segment (components/segment-figures.tsx).
   */
  correction?: React.ReactNode;
```

and the render's `{!editable ? ( … ) : ( … )}` becomes `{!editable ? ( … ) : readOnly && props.correction ? ( … ) : ( … )}`
with this middle branch:

```tsx
        <div className="flex flex-wrap items-start justify-between gap-4">
          {props.correction}
          <button
            type="button"
            onClick={() => setCorrecting(false)}
            className="rounded-md border border-rule px-3 py-1.5 text-sm text-ink-2 transition-colors hover:border-ink-3 hover:text-ink"
          >
            {t("official_correct_done")}
          </button>
        </div>
```

(the first and last branches stay exactly as they are).

- [ ] **Step 3: The detail view restates by segment**

In `components/dashboard-view.tsx`:
- import `SegmentFigures` from `@/components/segment-figures`, `useSegmentEntries` from `@/components/use-official-entry`
  (next to `useOfficialEntry`), `applySegmentFigures` from `@/lib/ground-truth`, and `sumOfFigures` from `@/lib/history`;
- after `const { percent, invalid } = parseOfficialPercent(entry.raw);` add:

```tsx
  // A closed cycle with keep resets came to the sum of its segments' figures, each corrected on its own.
  const { pastSegments } = model;
  const segmented = pastSegments.length > 0;
  const [segmentEntries, setSegmentEntry, segmentStatuses] = useSegmentEntries(
    selected.id,
    model.cycle.startMs,
    pastSegments,
    model.cycle.endMs,
  );
  const segmentFigures = useMemo(
    () =>
      pastSegments.map(
        (segment) => parseOfficialPercent((segmentEntries.get(segment.startMs) ?? EMPTY_ENTRY).raw).percent,
      ),
    [pastSegments, segmentEntries],
  );
  const segmentSum = sumOfFigures(segmentFigures);
```

- the `view` memo becomes:

```tsx
  const view = useMemo(
    () =>
      segmented
        ? applySegmentFigures(model, segmentFigures)
        : applyGroundTruth(model, percent === null ? null : { percent, atMs: entry.enteredAt }),
    [segmented, model, segmentFigures, percent, entry.enteredAt],
  );
```

- on `GroundTruthInput`, `raw={entry.raw}` becomes `raw={segmented ? (segmentSum === null ? "" : String(segmentSum)) : entry.raw}`,
  `invalid={invalid}` becomes `invalid={segmented ? false : invalid}`, and add:

```tsx
            correction={
              segmented && (
                <SegmentFigures
                  segments={pastSegments}
                  entries={segmentEntries}
                  statuses={segmentStatuses}
                  onChange={setSegmentEntry}
                  timeZone={model.timeZone}
                />
              )
            }
```

- [ ] **Step 4: Documentation**

In `docs/configuration.md`, append to the "### Usage resets" section:

```markdown
A finished cycle with keep-type resets came to the **sum** of its segments' figures, which can pass 100%: the
previous-cycles list writes it as "124% (80% + 44%)" and splits each segment's figure between the groups by that
segment's tokens. Its own view (while its reports are kept) shows the sum, restates every group and machine
segment by segment, and marks the resets on its charts; **Correct** opens one field per segment. A cycle a
restart-type reset cut short is listed as *ended by a reset*.
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/components/`
Expected: PASS (the existing closed-cycle correction test keeps its single field: that cycle has no segments).

- [ ] **Step 6: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add components/ground-truth-input.tsx components/dashboard-view.tsx docs/configuration.md tests/components/correct-official.test.tsx
git commit -m "feat(resets): show a past cycle with resets as the sum of its segments, corrected one by one"
```

### Task 8: Demo data with a reset, and the end-to-end test

**Files:**
- Modify: `lib/demo/dataset.ts` (`DemoDataset.resets`, the official figures' tag)
- Modify: `lib/demo/seed.ts` (stores the resets)
- Modify: `e2e/demo.spec.ts`
- Test: `tests/demo-dataset.test.ts`, `tests/demo-seed.test.ts`

**Interfaces:**
- Consumes: `ProviderResets`, `ResetEvent` (`lib/resets.ts`); `saveResets(providerId, resets)` (`lib/usage-store.ts`).
- Produces: `DemoDataset.resets: { providerId: string; resets: ProviderResets }[]`.

- [ ] **Step 1: Write the failing tests**

In `tests/demo-dataset.test.ts`, replace the loop at the end of
"validates as a settings update and carries the official figures of this cycle" with:

```ts
    // Typed after the week's reset: tagged with the segment since it (lib/official-usage.ts).
    const resetAtMs = dataset.resets[0]!.resets.events[0]!.atMs;
    for (const entry of dataset.official) {
      expect(entry.cycleStartMs).toBe(resetAtMs);
      expect(entry.enteredAtMs).toBeGreaterThan(resetAtMs);
      expect(entry.enteredAtMs).toBeLessThan(NOW.getTime());
    }
```

and append inside its top-level `describe`:

```ts
  it("has one Claude keep reset on the Monday evening of the current week", () => {
    const start = dataset.cycles.current.start.getTime();
    expect(dataset.resets).toEqual([
      {
        providerId: "claude",
        resets: {
          v: 1,
          events: [
            {
              id: "demo-claude-reset",
              atMs: start + 20 * 3_600_000,
              kind: "keep",
              cycleStartMs: start,
              before: 22.4,
              beforeAtMs: start + 19 * 3_600_000,
              source: "manual",
              recordedAtMs: start + 20 * 3_600_000 + 5 * 60_000,
            },
          ],
          autoOffCycleStartMs: null,
        },
      },
    ]);
  });

  it("has no reset while the week is too young for one, and tags the figures with the cycle then", () => {
    const early = buildDemoDataset(new Date(dataset.cycles.current.start.getTime() + 10 * 3_600_000));
    expect(early.resets).toEqual([]);
    for (const entry of early.official) expect(entry.cycleStartMs).toBe(early.cycles.current.start.getTime());
  });
```

(`buildDemoDataset` and `dataset`/`NOW` are what the file already uses; add `buildDemoDataset` to its import if it
only imports the constants.)

In `tests/demo-seed.test.ts`, append to "writes the settings, every report and the official figures through the real
code paths":

```ts
    expect(indexes.resets.claude?.events.map((event) => event.id)).toEqual(["demo-claude-reset"]);
```

Append to `e2e/demo.spec.ts`:

```ts
test("the dashboard shows the week's reset under the meter, on the chart and in the reset list", async ({ page }) => {
  await page.goto("/en");

  // 22.4% before the reset and 62.5% since: 84.9% in total, both rounded to whole percents.
  await expect(page.getByText(/^Reset .+ · before it 22% · this week in total 85%$/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Resets in this cycle" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toBeVisible();
  // The usage chart's marker: its lines start again from 0 there.
  await expect(page.getByText("reset", { exact: true }).first()).toBeVisible();
});
```

Run: `npx vitest run tests/demo-dataset.test.ts tests/demo-seed.test.ts`
Expected: FAIL — `dataset.resets` is undefined.

- [ ] **Step 2: The dataset and the seed**

In `lib/demo/dataset.ts`, add `import type { ProviderResets } from "@/lib/resets";`; `DemoDataset` gains:

```ts
  /**
   * Usage resets (lib/resets.ts), stored as they are by `seedStore`: one Claude
   * keep reset on the Monday evening of the current week, once the week is far
   * enough in, so the dashboard shows the stretch since it, the line under the
   * meter, the chart's marker and the reset list.
   */
  resets: { providerId: string; resets: ProviderResets }[];
```

In `buildDemoDataset`, replace

```ts
  const cycleStartMs = current.start.getTime();
  const official: DemoOfficialEntry[] = [
    { providerId: "claude", subLimitId: null, raw: "62.5", cycleStartMs, enteredAtMs: nowMs - 2 * HOUR_MS },
    { providerId: "claude", subLimitId: "fable", raw: "48", cycleStartMs, enteredAtMs: nowMs - 2 * HOUR_MS },
  ];
```

with

```ts
  const cycleStartMs = current.start.getTime();
  // Claude's keep reset, 20 hours into the week, when the figures below were typed after it.
  const resetAtMs = cycleStartMs + 20 * HOUR_MS;
  const withReset = resetAtMs <= nowMs - 2 * HOUR_MS;
  const resets: DemoDataset["resets"] = withReset
    ? [
        {
          providerId: "claude",
          resets: {
            v: 1,
            events: [
              {
                id: "demo-claude-reset",
                atMs: resetAtMs,
                kind: "keep",
                cycleStartMs,
                before: 22.4,
                beforeAtMs: resetAtMs - HOUR_MS,
                source: "manual",
                recordedAtMs: resetAtMs + 5 * MINUTE_MS,
              },
            ],
            autoOffCycleStartMs: null,
          },
        },
      ]
    : [];
  // A figure belongs to the segment it was typed in (lib/official-usage.ts): since the reset, when there is one.
  const tagMs = withReset ? resetAtMs : cycleStartMs;
  const official: DemoOfficialEntry[] = [
    { providerId: "claude", subLimitId: null, raw: "62.5", cycleStartMs: tagMs, enteredAtMs: nowMs - 2 * HOUR_MS },
    { providerId: "claude", subLimitId: "fable", raw: "48", cycleStartMs: tagMs, enteredAtMs: nowMs - 2 * HOUR_MS },
  ];
```

and the returned object gains `resets` (`return { timeZone, reset, cycles: { current, previous }, settings, reports, official, resets, history };`).

In `lib/demo/seed.ts`, import `saveResets` from `@/lib/usage-store` (next to the other store imports) and, right after the
`for (const entry of dataset.official) { … }` loop, add:

```ts
  for (const entry of dataset.resets) {
    await saveResets(entry.providerId, entry.resets);
  }
```

- [ ] **Step 3: Run the tests**

Run: `npx vitest run tests/demo-dataset.test.ts tests/demo-seed.test.ts`
Expected: PASS.

Run: `npm run build && npm run e2e`
Expected: PASS — the new demo test included, and the existing ones unchanged (the figure still reads 62.5; the
24-hour zoom window, Tuesday 14:00 – Wednesday 14:00 at the demo's fixed time, does not reach Monday's reset).

- [ ] **Step 4: Full check and commit**

Run: `npm run format && npm run check` — Expected: PASS.

```bash
git add lib/demo/dataset.ts lib/demo/seed.ts e2e/demo.spec.ts tests/demo-dataset.test.ts tests/demo-seed.test.ts
git commit -m "feat(demo): a Claude usage reset in the demo week"
```

### Task 9: Full verification

**Files:** none changed, unless a check finds something (fix it in its own commit, named for what it fixes).

- [ ] **Step 1:** `npm run check` — Expected: PASS.
- [ ] **Step 2:** `npm run build && npm run e2e` — Expected: PASS (the screenshot specs stay skipped).
- [ ] **Step 3: By hand.** Never with the main checkout's `.env.local` (it points at the production store).
  1. **A local Redis, so a past cycle's summary can be written directly:** start an isolated Redis +
     `hiett/serverless-redis-http` pair with Docker on a free port (not 8079, which other sessions may hold), and in the
     worktree `KV_REST_API_URL=http://localhost:<port> KV_REST_API_TOKEN=<its token> DASHBOARD_PIN=… USAGE_API_TOKEN=… TOKEN_ENCRYPTION_KEY=… npx next start -p <free port in 3152–3159>`.
     Sign in, send a few `POST /api/usage` reports for `claude`, then write two summaries of older cycles straight into
     `usage:history:claude` through the REST API (`ZADD`, JSON shaped like the History example in `docs/data-model.md`):
     one with two `segments` (80% and 44%), one with `"endedByReset": true`. Check in a browser (headless Playwright
     Chromium is fine): the previous-cycles list shows "124% (80% + 44%)", the per-segment group shares and the
     "ended by a reset" label; the segmented cycle opens as a summary with the sum, and **Correct** gives one field
     per segment; a saved correction updates the list. If `POST /api/usage` accepts reports dated in the previous
     cycle, send some, archive a segmented summary for that cycle too, and open its full view: the sum on the meter,
     the markers on the charts, **Correct** with one field per segment.
  2. **The demo:** `DEMO_MODE=1 DEMO_FIXED_TIME=2026-09-23T12:00:00Z npx next start -p <another free port>`: the meter
     line ("… before it 22% · this week in total 85%"), the chart's marker and the reset list.
  3. Stop every server and container you started.

Note anything that looks wrong in the ledger and fix it before finishing.

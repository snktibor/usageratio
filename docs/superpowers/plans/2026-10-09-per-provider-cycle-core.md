# Per-provider budget cycle — core (server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every provider have its own reset moment (weekday / month day / hour / minute) over the shared period and time zone, and make every server-side cycle computation use the provider's own reset.

**Architecture:** A new `resetOverrides` settings field is resolved per provider by `resetFor(config, providerId)`; `configForProvider` returns the provider's reset, so `buildDashboard` already follows it. A small pure module `lib/provider-cycles.ts` gives each provider's current/previous cycle and the earliest start among them, which every multi-provider reader (status, dashboard page, archive, housekeeping, alerts, ingest, export, `GET /api/usage`) uses instead of one shared `getCycle(now, config.reset)`. With no override stored, every result is identical to today's.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, Upstash Redis (in-memory fake in tests via `tests/helpers/redis-fixture.ts`).

**Spec:** `docs/superpowers/specs/2026-10-09-official-usage-report-design.md` (Part 1a). Plans 2–5 (clients, UI, report endpoint, macOS app) build on this one.

## Global Constraints

- Period (`weekly` | `monthly`) and `timeZone` stay shared; only `weekday`, `monthDay`, `hour`, `minute` can be overridden per provider.
- A provider without an override behaves exactly as today; every existing test keeps passing unchanged unless a step below says otherwise.
- No data migration; no new Redis key. The override lives inside the existing `usage:settings` document.
- `PUT /api/settings` requires `resetOverrides` (an object, possibly `{}`), like every other field ("nothing is defaulted").
- Out of scope here (later plans): the past-cycle picker (`listCycleOptions` keeps the shared reset), the settings UI for editing overrides, the clients, the report endpoint.
- `npm run check` (Biome + `tsc --noEmit` + Vitest) must pass at the end of every task.
- Conventional Commits; never any AI attribution in commit messages.

---

### Task 1: `resetOverrides` in the settings model

**Files:**
- Modify: `lib/config.ts` (types `ResetOverride`, `AppConfig.resetOverrides`; `getConfig` default)
- Modify: `lib/settings.ts` (`UsageSettings`, `settingsFromConfig`, `applySettings`, `parseStoredSettings`, `parseSettingsUpdate`, `configForProvider`, new `resetFor`)
- Modify: `components/settings/draft.ts` (carry the field through unchanged)
- Modify: `lib/demo/dataset.ts:630-649` (add `resetOverrides: {}`)
- Modify: `lib/redis-keys.ts` (document the field)
- Test: `tests/settings.test.ts`, `tests/settings-draft.test.ts`

**Interfaces:**
- Produces:
  - `export interface ResetOverride { weekday: number; monthDay: number; hour: number; minute: number }` (lib/config.ts)
  - `AppConfig.resetOverrides: Record<string, ResetOverride>`
  - `UsageSettings.resetOverrides: Record<string, ResetOverride>`
  - `export function resetFor(config: AppConfig, providerId: string): ResetConfig` (lib/settings.ts)
  - `configForProvider(config, providerId)` now also returns `reset: resetFor(config, providerId)`

- [ ] **Step 1: Write the failing tests** — append to `tests/settings.test.ts`:

```ts
describe("per-provider reset", () => {
  const base = getConfig();

  it("resetFor falls back to the shared reset without an override", () => {
    const config = { ...base, resetOverrides: {} };
    expect(resetFor(config, "claude")).toEqual(config.reset);
  });

  it("resetFor lays a provider's override over the shared period and time zone", () => {
    const config = {
      ...base,
      reset: { ...base.reset, period: "weekly" as const, timeZone: "Europe/Budapest" },
      resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 15 } },
    };
    expect(resetFor(config, "claude")).toEqual({
      period: "weekly",
      timeZone: "Europe/Budapest",
      weekday: 4,
      monthDay: 1,
      hour: 9,
      minute: 15,
    });
    expect(resetFor(config, "openai")).toEqual(config.reset);
  });

  it("configForProvider carries the provider's reset", () => {
    const config = { ...base, resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } } };
    expect(configForProvider(config, "claude").reset.weekday).toBe(4);
    expect(configForProvider(config, "openai").reset).toEqual(config.reset);
  });

  it("stored overrides round-trip, and bad entries are dropped one by one", () => {
    const defaults = settingsFromConfig(base);
    const raw = JSON.stringify({
      ...defaults,
      resetOverrides: {
        Claude: { weekday: 4, monthDay: 1, hour: 9, minute: 15 },
        openai: { weekday: 9, monthDay: 1, hour: 0, minute: 0 },
        "": { weekday: 1, monthDay: 1, hour: 0, minute: 0 },
      },
    });
    expect(parseStoredSettings(raw, defaults).resetOverrides).toEqual({
      claude: { weekday: 4, monthDay: 1, hour: 9, minute: 15 },
    });
  });

  it("a document without the field keeps no override", () => {
    const defaults = settingsFromConfig(base);
    const { resetOverrides: _, ...withoutField } = defaults;
    expect(parseStoredSettings(JSON.stringify(withoutField), defaults).resetOverrides).toEqual({});
  });

  it("applySettings and settingsFromConfig carry the overrides", () => {
    const settings = {
      ...settingsFromConfig(base),
      resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
    };
    const config = applySettings(base, settings);
    expect(config.resetOverrides).toEqual(settings.resetOverrides);
    expect(settingsFromConfig(config).resetOverrides).toEqual(settings.resetOverrides);
  });
});
```

Add `resetFor` to the file's existing import from `@/lib/settings` (and `getConfig` from `@/lib/config` if not yet imported).

In the same file's `describe("parseSettingsUpdate")`, add `resetOverrides: { Claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } }` to the `valid` object, and add:

```ts
  it("normalizes the reset overrides' provider ids", () => {
    const result = parseSettingsUpdate(valid);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.update.settings.resetOverrides).toEqual({ claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } });
  });

  it("requires resetOverrides, and checks every field of every entry", () => {
    const { resetOverrides: _, ...missing } = valid;
    expect(parseSettingsUpdate(missing)).toMatchObject({ ok: false });
    const bad = parseSettingsUpdate({ ...valid, resetOverrides: { claude: { weekday: 7, monthDay: 0, hour: 24, minute: 60 } } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors).toEqual(
        expect.arrayContaining([
          "resetOverrides.claude.weekday must be 0 (Sunday) to 6 (Saturday)",
          "resetOverrides.claude.monthDay must be 1 to 31",
          "resetOverrides.claude.hour must be 0 to 23",
          "resetOverrides.claude.minute must be 0 to 59",
        ]),
      );
    }
    expect(parseSettingsUpdate({ ...valid, resetOverrides: { "!!": { weekday: 1, monthDay: 1, hour: 0, minute: 0 } } }).ok).toBe(false);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL — `resetFor` is not exported; `resetOverrides` is undefined.

- [ ] **Step 3: Implement**

`lib/config.ts` — after `interface ResetConfig`:

```ts
/** A provider's own reset moment, over the shared period and time zone (see lib/settings.ts `resetFor`). */
export interface ResetOverride {
  /** Weekly budgets: 0 = Sunday … 6 = Saturday */
  weekday: number;
  /** Monthly budgets: 1–31 */
  monthDay: number;
  hour: number;
  minute: number;
}
```

In `interface AppConfig`, after `reset: ResetConfig;`:

```ts
  /** providerId → its own reset moment; a provider without one uses `reset`. */
  resetOverrides: Record<string, ResetOverride>;
```

In `getConfig()`'s returned object (next to `reset,` around line 260) add `resetOverrides: {},`.

`lib/settings.ts`:

1. Import `ResetOverride` alongside the other `@/lib/config` type imports.
2. In `interface UsageSettings`, after `reset: {…};` add:

```ts
  /**
   * providerId → its own reset moment (weekday, month day, hour, minute) over
   * the shared period and time zone. Absent: the provider uses `reset`.
   * Set on the settings panel, or by an official report (lib/official-report.ts).
   */
  resetOverrides: Record<string, ResetOverride>;
```

3. Helpers, in the `// ── Budget ──` section:

```ts
function copyResetOverrides(overrides: Record<string, ResetOverride>): Record<string, ResetOverride> {
  return Object.fromEntries(Object.entries(overrides).map(([providerId, override]) => [providerId, { ...override }]));
}

/** One override entry: each field checked, the whole entry kept or dropped together. */
function readResetOverride(value: unknown, field: string, errors?: string[]): ResetOverride | null {
  const entry = asRecord(value);
  const problems: string[] = [];
  if (!entry) {
    problems.push(`${field} must be a JSON object`);
  } else {
    if (!isIntegerIn(entry.weekday, 0, 6)) problems.push(`${field}.weekday must be 0 (Sunday) to 6 (Saturday)`);
    if (!isIntegerIn(entry.monthDay, 1, 31)) problems.push(`${field}.monthDay must be 1 to 31`);
    if (!isIntegerIn(entry.hour, 0, 23)) problems.push(`${field}.hour must be 0 to 23`);
    if (!isIntegerIn(entry.minute, 0, 59)) problems.push(`${field}.minute must be 0 to 59`);
  }
  if (problems.length > 0) {
    errors?.push(...problems);
    return null;
  }
  const { weekday, monthDay, hour, minute } = entry as Record<string, number>;
  return { weekday: weekday!, monthDay: monthDay!, hour: hour!, minute: minute! };
}

/** The stored map, leniently: an unknown provider id or a bad entry is dropped on its own. */
function readResetOverrides(stored: Record<string, unknown>): Record<string, ResetOverride> {
  const overrides: Record<string, ResetOverride> = {};
  for (const [rawProvider, value] of Object.entries(stored).slice(0, MAX_PROVIDERS)) {
    const providerId = normalizeProviderId(rawProvider);
    const override = providerId && readResetOverride(value, rawProvider);
    if (providerId && override && !Object.hasOwn(overrides, providerId)) overrides[providerId] = override;
  }
  return overrides;
}

/** The PUT body's map: every problem is reported. */
function parseResetOverrides(value: unknown, errors: string[]): Record<string, ResetOverride> {
  const body = asRecord(value);
  if (!body || Object.keys(body).length > MAX_PROVIDERS) {
    errors.push(`resetOverrides must be a JSON object of at most ${MAX_PROVIDERS} providers`);
    return {};
  }
  const overrides: Record<string, ResetOverride> = {};
  for (const [rawProvider, entry] of Object.entries(body)) {
    const providerId = normalizeProviderId(rawProvider);
    if (!providerId) {
      errors.push(`resetOverrides.${rawProvider} has an invalid provider id`);
      continue;
    }
    if (Object.hasOwn(overrides, providerId)) {
      errors.push(`resetOverrides.${rawProvider} is listed twice after normalization`);
      continue;
    }
    const override = readResetOverride(entry, `resetOverrides.${providerId}`, errors);
    if (override) overrides[providerId] = override;
  }
  return overrides;
}
```

4. `settingsFromConfig`: add `resetOverrides: copyResetOverrides(config.resetOverrides),` after `reset: …`.
5. `applySettings`: add `resetOverrides: copyResetOverrides(settings.resetOverrides),` after `reset: …`.
6. `parseStoredSettings`: next to `const storedSubLimits = …` add `const storedOverrides = asRecord(doc.resetOverrides);`, and in the returned object after `reset: {…},`:

```ts
    // Documents saved before per-provider resets existed lack the field: every provider uses `reset`.
    resetOverrides: storedOverrides ? readResetOverrides(storedOverrides) : defaults.resetOverrides,
```

7. `parseSettingsUpdate`: after the `reset.timeZone` check add `const resetOverrides = parseResetOverrides(body.resetOverrides, errors);` and in the returned `settings` after `reset: {…},` add `resetOverrides,`.
8. Replace `configForProvider` and add `resetFor` right above it:

```ts
/** The reset one provider's cycle runs on: its override over the shared period and time zone. */
export function resetFor(config: AppConfig, providerId: string): ResetConfig {
  const override = Object.hasOwn(config.resetOverrides, providerId) ? config.resetOverrides[providerId] : undefined;
  return override ? { ...config.reset, ...override } : config.reset;
}

/** Effective configuration for one selected provider: its limit and its reset. */
export function configForProvider(config: AppConfig, providerId: string): AppConfig {
  return { ...config, limit: config.providerLimits[providerId] ?? config.limit, reset: resetFor(config, providerId) };
}
```

(`ResetConfig` must be imported as a type from `@/lib/config` if it is not already.)

`components/settings/draft.ts`: add `resetOverrides: Record<string, ResetOverride>;` to `interface Draft` and to `interface SettingsRequest`; in `draftFrom` copy `resetOverrides: view.settings.resetOverrides` (destructure it with the others); in `toRequest` add `resetOverrides: draft.resetOverrides,` to the request object. The panel only carries the stored overrides back unchanged here — editing them is plan 3.

`lib/demo/dataset.ts`: add `resetOverrides: {},` after the `reset: {…},` block of `settings` (line ~640).

`lib/redis-keys.ts`: in the `usage:settings` line's description, append `, and providers' own reset moments (resetOverrides)`.

- [ ] **Step 4: Fix the remaining fixtures** — run `npx tsc --noEmit`; every object literal typed `UsageSettings`, `AppConfig`, `Draft` or `SettingsRequest` that the compiler now flags (tests and `lib/`) gets `resetOverrides: {}`. Run `npx vitest run` and add `resetOverrides: {}` to every `PUT /api/settings` body in `tests/integration/settings.test.ts`, `tests/redis-memory.test.ts`, `tests/settings-draft.test.ts` that now fails with `resetOverrides must be a JSON object`.

- [ ] **Step 5: Run the checks**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/config.ts lib/settings.ts lib/redis-keys.ts lib/demo/dataset.ts components/settings/draft.ts tests
git commit -m "feat(settings): store a reset moment per provider"
```

---

### Task 2: `lib/provider-cycles.ts`

**Files:**
- Create: `lib/provider-cycles.ts`
- Test: `tests/provider-cycles.test.ts`

**Interfaces:**
- Consumes: `resetFor` (Task 1), `getCycle`, `getPreviousCycle`, `Cycle` (lib/cycle.ts).
- Produces:
  - `export interface ProviderCycle { cycle: Cycle; previous: Cycle }`
  - `export function providerCycle(now: Date, config: AppConfig, providerId: string): ProviderCycle`
  - `export function earliestCycle(now: Date, config: AppConfig, providerIds: string[]): ProviderCycle` — the shared reset's cycle counts too, so it is defined for no providers.
  - `export function earliestStartMs(now: Date, config: AppConfig, providerIds: string[], which: "cycle" | "previous"): number`

- [ ] **Step 1: Write the failing test** — `tests/provider-cycles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { earliestCycle, earliestStartMs, providerCycle } from "@/lib/provider-cycles";

// Wednesday 2026-09-23 12:00 UTC.
const NOW = new Date("2026-09-23T12:00:00Z");
const config = {
  ...getConfig(),
  reset: { period: "weekly" as const, weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
  resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
};

describe("providerCycle", () => {
  it("uses the shared reset for a provider without an override", () => {
    const { cycle, previous } = providerCycle(NOW, config, "openai");
    expect(cycle.start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(cycle.end.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(previous.start.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("uses the provider's own reset", () => {
    const { cycle, previous } = providerCycle(NOW, config, "claude");
    expect(cycle.start.toISOString()).toBe("2026-09-17T09:00:00.000Z");
    expect(cycle.end.toISOString()).toBe("2026-09-24T09:00:00.000Z");
    expect(previous.start.toISOString()).toBe("2026-09-10T09:00:00.000Z");
  });
});

describe("earliestCycle / earliestStartMs", () => {
  it("picks the provider whose cycle began first", () => {
    expect(earliestCycle(NOW, config, ["openai", "claude"]).cycle.start.toISOString()).toBe("2026-09-17T09:00:00.000Z");
    expect(new Date(earliestStartMs(NOW, config, ["openai", "claude"], "previous")).toISOString()).toBe(
      "2026-09-10T09:00:00.000Z",
    );
  });

  it("falls back to the shared reset with no providers", () => {
    expect(earliestCycle(NOW, config, []).cycle.start.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("counts the shared reset even when every provider has a later start", () => {
    const later = { ...config, resetOverrides: { claude: { weekday: 2, monthDay: 1, hour: 0, minute: 0 } } };
    expect(earliestStartMs(NOW, later, ["claude"], "cycle")).toBe(Date.parse("2026-09-21T00:00:00Z"));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/provider-cycles.test.ts`
Expected: FAIL — cannot resolve `@/lib/provider-cycles`.

- [ ] **Step 3: Implement** — `lib/provider-cycles.ts`:

```ts
import type { AppConfig } from "@/lib/config";
import { type Cycle, getCycle, getPreviousCycle } from "@/lib/cycle";
import { resetFor } from "@/lib/settings";

/**
 * Every provider's budget cycle, now that a provider can have its own reset
 * moment (lib/settings.ts `resetFor`). Pure.
 *
 * A reader that covers several providers at once (the status, the dashboard,
 * housekeeping, a client's `ccusage --since`) reads back to the earliest
 * start among them; the shared reset always counts as one of them, so the
 * result is defined with no provider at all and never later than today's.
 */

export interface ProviderCycle {
  cycle: Cycle;
  /** The cycle right before `cycle`: the footer's comparison, counter mode's baseline. */
  previous: Cycle;
}

function cycleWith(now: Date, reset: AppConfig["reset"]): ProviderCycle {
  const cycle = getCycle(now, reset);
  return { cycle, previous: getPreviousCycle(cycle, reset) };
}

/** The cycle `now` falls in for one provider, with the one before it. */
export function providerCycle(now: Date, config: AppConfig, providerId: string): ProviderCycle {
  return cycleWith(now, resetFor(config, providerId));
}

/** Of the providers' cycles and the shared reset's, the one that began first. */
export function earliestCycle(now: Date, config: AppConfig, providerIds: string[]): ProviderCycle {
  let earliest = cycleWith(now, config.reset);
  for (const providerId of providerIds) {
    const candidate = providerCycle(now, config, providerId);
    if (candidate.cycle.start.getTime() < earliest.cycle.start.getTime()) earliest = candidate;
  }
  return earliest;
}

/** The earliest start of the current (`"cycle"`) or the previous (`"previous"`) cycles: how far back one read must reach. */
export function earliestStartMs(
  now: Date,
  config: AppConfig,
  providerIds: string[],
  which: "cycle" | "previous",
): number {
  const startOf = (cycles: ProviderCycle) => cycles[which].start.getTime();
  let earliest = startOf(cycleWith(now, config.reset));
  for (const providerId of providerIds) earliest = Math.min(earliest, startOf(providerCycle(now, config, providerId)));
  return earliest;
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run tests/provider-cycles.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/provider-cycles.ts tests/provider-cycles.test.ts
git commit -m "feat(cycle): work out each provider's own cycle"
```

---

### Task 3: official entries per provider cycle

**Files:**
- Modify: `lib/official-usage.ts` (`currentOfficialEntries`)
- Test: `tests/official-usage.test.ts`

**Interfaces:**
- Produces: `export function providerOfOfficialField(field: string): string` (lib/official-usage.ts) — "claude" or "claude:fable" → "claude".
- Produces: `currentOfficialEntries(stored: Record<string, string>, cycleStart: number | ((providerId: string) => number)): Map<string, OfficialEntryView>` — a number keeps today's behaviour; a function gives each field its provider's cycle start.

- [ ] **Step 1: Write the failing test** — append to `tests/official-usage.test.ts`:

```ts
describe("currentOfficialEntries — per provider", () => {
  it("checks each field against its own provider's cycle start", () => {
    const CLAUDE_START = Date.parse("2026-09-17T09:00:00Z");
    const stored = {
      claude: serializeOfficialEntry({ raw: "41", enteredAt: 1, cycleStartMs: CLAUDE_START }),
      "claude:fable": serializeOfficialEntry({ raw: "12", enteredAt: 2, cycleStartMs: CLAUDE_START }),
      openai: serializeOfficialEntry({ raw: "30", enteredAt: 3, cycleStartMs: CLAUDE_START }),
    };
    const startOf = (providerId: string) => (providerId === "claude" ? CLAUDE_START : CYCLE_START);
    const entries = currentOfficialEntries(stored, startOf);
    expect([...entries.keys()].sort()).toEqual(["claude", "claude:fable"]);
  });
});

describe("providerOfOfficialField", () => {
  it("reads the provider id off a provider's or a sub-limit's field", () => {
    expect(providerOfOfficialField("claude")).toBe("claude");
    expect(providerOfOfficialField("claude:fable")).toBe("claude");
  });
});
```

Add `providerOfOfficialField` to the file's import from `@/lib/official-usage`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/official-usage.test.ts`
Expected: FAIL — `providerOfOfficialField` is not exported.

- [ ] **Step 3: Implement** — in `lib/official-usage.ts`, after `officialUsageField`, add

```ts
/** The provider a `usage:official` field belongs to: "claude" or "claude:fable" → "claude". */
export function providerOfOfficialField(field: string): string {
  const colon = field.indexOf(":");
  return colon < 0 ? field : field.slice(0, colon);
}
```

and replace `currentOfficialEntries`:

```ts
/**
 * The stored entries whose cycle still matches, by field: what every browser
 * should show right now. One typed in a cycle that has since rolled over is
 * as good as absent. `cycleStart`: the current cycle's start, or, now that a
 * provider can have its own reset, each provider's (by provider id).
 */
export function currentOfficialEntries(
  stored: Record<string, string>,
  cycleStart: number | ((providerId: string) => number),
): Map<string, OfficialEntryView> {
  const startOf = typeof cycleStart === "number" ? () => cycleStart : cycleStart;
  const entries = new Map<string, OfficialEntryView>();
  for (const [field, raw] of Object.entries(stored)) {
    const entry = parseStoredEntry(raw);
    if (entry && entry.cycleStartMs === startOf(providerOfOfficialField(field)))
      entries.set(field, { raw: entry.raw, enteredAt: entry.enteredAt });
  }
  return entries;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/official-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/official-usage.ts tests/official-usage.test.ts
git commit -m "feat(official-usage): match each figure against its provider's cycle"
```

---

### Task 4: status and the dashboard's current cycle per provider

**Files:**
- Modify: `lib/status.ts` (`StatusProvider.cycle`, `providerStatus`, `loadStatus`)
- Modify: `app/[locale]/(dashboard)/page.tsx` (`loadDashboard`: `since`, `officialUsage`)
- Modify: `app/[locale]/settings/page.tsx:44-45` (`since`)
- Test: `tests/integration/status.test.ts`

**Interfaces:**
- Consumes: `providerCycle`, `earliestStartMs` (Task 2); `currentOfficialEntries` with a function (Task 3); `configForProvider` with the provider's reset (Task 1) — `buildProviderDashboards` already calls it, so `ProviderDashboardModel.dashboard.cycle` is the provider's own.
- Produces: `StatusProvider.cycle: { start: string; end: string }` (ISO) — the macOS app (plan 5) reads it. `StatusPayload.cycle` stays the shared reset's cycle.

- [ ] **Step 1: Write the failing test** — in `tests/integration/status.test.ts`, following the file's existing setup (it seeds settings with `settingsFromConfig` and reports, then calls the route's `GET` with a read token), add a case that saves settings with `resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } }` on a weekly Monday-00:00 UTC shared reset, seeds one Claude report and one OpenAI report, freezes time at `2026-09-23T12:00:00Z` the way the file's other cases do, and asserts:

```ts
    const claude = body.providers.find((provider: { id: string }) => provider.id === "claude");
    const openai = body.providers.find((provider: { id: string }) => provider.id === "openai");
    expect(claude.cycle).toEqual({ start: "2026-09-17T09:00:00.000Z", end: "2026-09-24T09:00:00.000Z" });
    expect(openai.cycle).toEqual({ start: "2026-09-21T00:00:00.000Z", end: "2026-09-28T00:00:00.000Z" });
    expect(body.cycle.start).toBe("2026-09-21T00:00:00.000Z");
```

Also seed `usage:official` with `claude` → `{"raw":"41","enteredAt":<now>,"cycleStartMs":<2026-09-17T09:00Z>}` and assert `claude.source === "official"` and `claude.percent === 41`.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/integration/status.test.ts`
Expected: FAIL — `claude.cycle` is undefined.

- [ ] **Step 3: Implement**

`lib/status.ts`:
- In `interface StatusProvider`, after `label`, add:

```ts
  /** This provider's own cycle: its reset may differ from the shared one (lib/settings.ts `resetFor`). */
  cycle: { start: string; end: string };
```

- In `providerStatus`, after `label: provider.label,` add `cycle: { start: iso(model.cycle.startMs), end: iso(model.cycle.endMs) },`.
- In `loadStatus`, replace the block from `const cycle = getCycle(now, config.reset);` to `const officialUsage = …;` with:

```ts
  // The shared reset's cycle heads the payload; every provider carries its own below.
  const cycle = getCycle(now, config.reset);
  // The previous cycles ride along: counter mode's baseline needs them.
  const since = earliestStartMs(now, config, providerIds, "previous");
  const { eventsByProvider, groups } = await loadEvents(providerIds, indexes.groups, since);
  const officialUsage = currentOfficialEntries(indexes.officialUsage, (providerId) =>
    providerCycle(now, config, providerId).cycle.start.getTime(),
  );
```

  Drop the now-unused `getPreviousCycle` import; import `earliestStartMs, providerCycle` from `@/lib/provider-cycles`.

`app/[locale]/(dashboard)/page.tsx` `loadDashboard`: replace

```ts
  const since =
    requestedStartMs === null
      ? previousCycle.start.getTime()
      : Math.min(previousCycle.start.getTime(), now.getTime() - config.retentionDays * DAY_MS);
```

with

```ts
  const earliestPrevious = earliestStartMs(now, config, providerIds, "previous");
  const since =
    requestedStartMs === null
      ? earliestPrevious
      : Math.min(earliestPrevious, now.getTime() - config.retentionDays * DAY_MS);
```

and replace the `officialUsage` line and its comment with

```ts
  // Each provider's stored ground-truth figure applies while its own cycle runs.
  const officialUsage = currentOfficialEntries(indexes.officialUsage, (providerId) =>
    providerCycle(now, config, providerId).cycle.start.getTime(),
  );
```

(`cycle` / `previousCycle` stay: the cycle picker and the archive call still use them until Task 5 and plan 3.)

`app/[locale]/settings/page.tsx`: replace lines 44–45 with

```ts
  const since = earliestStartMs(now, config, providerIds, "previous");
```

(`providerIds` is already defined a few lines above; import `earliestStartMs` from `@/lib/provider-cycles`; drop the now unused `getCycle`/`getPreviousCycle` imports).

- [ ] **Step 4: Run the checks**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/status.ts "app/[locale]/(dashboard)/page.tsx" "app/[locale]/settings/page.tsx" tests/integration/status.test.ts
git commit -m "feat(status): give every provider its own cycle"
```

---

### Task 5: archive and housekeeping per provider

**Files:**
- Modify: `lib/archive.ts` (`ArchiveInput`, `archiveDueCycles`)
- Modify: `app/[locale]/(dashboard)/page.tsx` (the `archiveDueCycles` call)
- Modify: `lib/housekeeping.ts:124-145` (step 4 and step 5)
- Test: `tests/housekeeping.test.ts`, `tests/integration/housekeeping.test.ts`

**Interfaces:**
- Consumes: `providerCycle`, `earliestStartMs` (Task 2); `providerOfOfficialField` (Task 3).
- Produces: `ArchiveInput` = `{ providerIds: string[]; config: AppConfig; now: Date; eventsByProvider: Record<string, UsageEvent[]>; rawOfficialUsage: Record<string, string>; dryRun?: boolean }` — `cycle` and `previousCycle` are gone; each provider's come from `providerCycle(now, config, providerId)`. `eventsByProvider` must reach back to `earliestStartMs(now, config, providerIds, "previous")`.

- [ ] **Step 1: Write the failing test** — in `tests/integration/housekeeping.test.ts`, following its existing archive case (it seeds a previous cycle's reports and runs housekeeping), add a case with `resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } }` (shared reset Monday 00:00 UTC), time frozen at `2026-09-23T12:00:00Z`, a Claude report at `2026-09-12T10:00:00Z` and an OpenAI report at `2026-09-15T10:00:00Z`. Assert that `usage:history:claude` gets a summary with `start === Date.parse("2026-09-10T09:00:00Z")` and `end === Date.parse("2026-09-17T09:00:00Z")`, and `usage:history:openai` one with `start === Date.parse("2026-09-14T00:00:00Z")`. Add a second case: an official entry `claude` with `cycleStartMs` = `2026-09-17T09:00Z` survives the `official` step, one with `cycleStartMs` = `2026-09-10T09:00Z` is removed.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/integration/housekeeping.test.ts`
Expected: FAIL — Claude's summary is archived with the shared Monday boundaries, and the current Claude entry is deleted as stale.

- [ ] **Step 3: Implement**

`lib/archive.ts` — replace `ArchiveInput` and the top of `archiveDueCycles`:

```ts
export interface ArchiveInput {
  providerIds: string[];
  config: AppConfig;
  now: Date;
  /** Must reach back to the earliest previous cycle (lib/provider-cycles.ts `earliestStartMs(…, "previous")`). */
  eventsByProvider: Record<string, UsageEvent[]>;
  /** The raw `usage:official` hash, for the previous cycle's typed-in percentage. */
  rawOfficialUsage: Record<string, string>;
  /** Only report which providers are due; write nothing. */
  dryRun?: boolean;
}
```

Keep the doc comment, adding one sentence: "Each provider's cycles are its own (lib/provider-cycles.ts): the shared reset, or the provider's override." Then:

```ts
export async function archiveDueCycles({
  providerIds,
  config,
  now,
  eventsByProvider,
  rawOfficialUsage,
  dryRun = false,
}: ArchiveInput): Promise<string[]> {
  if (providerIds.length === 0) return [];
  const newestStarts = await loadNewestArchivedStarts(providerIds);
  const windowOf = (providerId: string) => {
    const { cycle, previous } = providerCycle(now, config, providerId);
    return { previousStartMs: previous.start.getTime(), cycleStartMs: cycle.start.getTime() };
  };

  const due = providerIds.filter((providerId) => {
    const { previousStartMs, cycleStartMs } = windowOf(providerId);
    const newest = newestStarts[providerId];
    if (newest !== null && newest !== undefined && newest >= previousStartMs) return false;
    return (eventsByProvider[providerId] ?? []).some((event) => event.ts >= previousStartMs && event.ts < cycleStartMs);
  });
  if (due.length === 0 || dryRun) return due;
```

and inside the `due.map(async (providerId) => {…})` body, first line `const { previousStartMs, cycleStartMs } = windowOf(providerId);` — the rest of the body is unchanged. Remove the `Cycle` import; import `providerCycle` from `@/lib/provider-cycles`.

`app/[locale]/(dashboard)/page.tsx` — the call becomes

```ts
  await archiveDueCycles({
    providerIds,
    config,
    now,
    eventsByProvider,
    rawOfficialUsage: indexes.officialUsage,
  });
```

`lib/housekeeping.ts` — replace lines 126–137 (step 4) with

```ts
  const config = resolveConfig(getConfig(), indexes.settings, providerIds);
  const { eventsByProvider } = await loadEvents(
    providerIds,
    indexes.groups,
    earliestStartMs(now, config, providerIds, "previous"),
  );
  const archived = await archiveDueCycles({
    providerIds,
    config,
    now,
    eventsByProvider,
    rawOfficialUsage: indexes.officialUsage,
    dryRun,
  });
```

and step 5's filter with

```ts
  // Step 5: official-usage entries from a cycle that has since rolled over (each provider's own), or that no longer parse.
  const staleOfficialFields = Object.entries(indexes.officialUsage)
    .filter(([field, raw]) => {
      const cycleStartMs = officialCycleStartMs(raw);
      const currentStartMs = providerCycle(now, config, providerOfOfficialField(field)).cycle.start.getTime();
      return cycleStartMs === null || cycleStartMs < currentStartMs;
    })
    .map(([field]) => field);
```

Imports: drop `getCycle`, `getPreviousCycle`; add `earliestStartMs, providerCycle` from `@/lib/provider-cycles` and `providerOfOfficialField` from `@/lib/official-usage`.

In `tests/housekeeping.test.ts`, update any direct `archiveDueCycles` / step-4 expectations that passed `cycle`/`previousCycle` to pass `now` instead (the compiler flags them).

- [ ] **Step 4: Run the checks**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/archive.ts lib/housekeeping.ts "app/[locale]/(dashboard)/page.tsx" tests
git commit -m "feat(history): archive and expire each provider's own cycle"
```

---

### Task 6: threshold alerts per provider

**Files:**
- Modify: `lib/alerts.ts` (`resetConfigOf`, `checkIngestAlerts`, `checkOfficialUsageAlerts`)
- Test: `tests/integration/alerts.test.ts`

**Interfaces:**
- Consumes: `UsageSettings.resetOverrides` (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test** — in `tests/integration/alerts.test.ts`, next to the existing official-usage alert case, add one where the settings have `useTokenLimits: false`, a webhook and `resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } }`; time frozen at `2026-09-23T12:00:00Z`; call `checkOfficialUsageAlerts({ providerId: "claude", subLimitId: null, raw: "95", cycleStartMs: Date.parse("2026-09-17T09:00:00Z") }, now)` and assert the webhook was called (the file's fetch stub) and the guard key `usage:alert:claude:<2026-09-17T09:00Z ms>:90` exists. Today the figure is skipped as typed for another cycle.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/integration/alerts.test.ts`
Expected: FAIL — no webhook call.

- [ ] **Step 3: Implement** in `lib/alerts.ts`:

```ts
/** One provider's reset: `UsageSettings` splits the period off, and keeps the providers' own moments apart. */
function resetConfigOf(
  settings: Pick<UsageSettings, "period" | "reset" | "resetOverrides">,
  providerId: string,
): ResetConfig {
  const override = Object.hasOwn(settings.resetOverrides, providerId) ? settings.resetOverrides[providerId] : undefined;
  return { ...settings.reset, ...override, period: settings.period };
}
```

`checkIngestAlerts`: delete the three lines computing `cycle`, `startMs`, `endMs` before the loop, and at the top of the loop body (after the `hiddenProviders` check) add

```ts
      const cycle = getCycle(now, resetConfigOf(settings, providerId));
      const startMs = cycle.start.getTime();
      const endMs = cycle.end.getTime();
```

`checkOfficialUsageAlerts`: `const cycle = getCycle(now, resetConfigOf(settings, update.providerId));`.

- [ ] **Step 4: Run the checks**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/alerts.ts tests/integration/alerts.test.ts
git commit -m "feat(alerts): judge each provider within its own cycle"
```

---

### Task 7: ingest checkpoints per provider

**Files:**
- Modify: `lib/days.ts` (`reportCheckpoints`)
- Modify: `lib/usage-store.ts:206-222` (`storeReport`'s `cycle` parameter)
- Modify: `lib/ingest.ts`
- Test: `tests/days.test.ts`, `tests/integration/usage.test.ts`

**Interfaces:**
- Consumes: `resetFor` (Task 1), `earliestCycle` (Task 2).
- Produces:
  - `export type CycleStart = number | ((providerId: string) => number)` (lib/days.ts)
  - `reportCheckpoints(report: UsageReport, timeZone: string, sinceMs: CycleStart): Checkpoint[]`
  - `storeReport(report, now, retentionDays, cycle: { timeZone: string; startMs: CycleStart } | null)`
  - `IngestResult.cycle` = the earliest current cycle among the report's providers (the shared one for a heartbeat).

- [ ] **Step 1: Write the failing test** — add to `describe("reportCheckpoints")` in `tests/days.test.ts` (it already defines `days`: Claude on 19, 21 and 22 September, OpenAI on the 21st; `ZONE` is Europe/Budapest, so the 19th ends at `2026-09-19T22:00Z` and the 21st at `2026-09-21T22:00Z`):

```ts
  it("bounds each provider by its own cycle start", () => {
    const startOf = (providerId: string) => (providerId === "claude" ? Date.parse("2026-09-20T00:00:00Z") : CYCLE_START);
    const checkpoints = reportCheckpoints(report("2026-09-22T11:49:28Z", days), ZONE, startOf);
    expect(checkpoints.filter((c) => c.providerId === "claude").map((c) => c.ts)).toEqual([
      Date.parse("2026-09-21T22:00:00Z"),
    ]);
    expect(checkpoints.filter((c) => c.providerId === "openai")).toHaveLength(1);
  });
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/days.test.ts`
Expected: FAIL (type error / wrong count: a function is compared as a number).

- [ ] **Step 3: Implement**

`lib/days.ts`:

```ts
/** A cycle start for every provider alike, or each provider's own (by provider id). */
export type CycleStart = number | ((providerId: string) => number);
```

Change the signature to `reportCheckpoints(report: UsageReport, timeZone: string, sinceMs: CycleStart): Checkpoint[]`, update its doc comment ("`sinceMs`: the start of the report's cycle, or each provider's own …"), and replace `keep`:

```ts
  const sinceOf = typeof sinceMs === "number" ? () => sinceMs : sinceMs;
  const keep = (checkpoint: Checkpoint) => {
    if (checkpoint.ts > sinceOf(checkpoint.providerId)) checkpoints.push(checkpoint);
  };
```

`lib/usage-store.ts` `storeReport`: parameter `cycle: { timeZone: string; startMs: CycleStart } | null` (import the type from `@/lib/days`), and

```ts
  const oldestMs = now.getTime() - retentionDays * DAY_MS;
  const startOf = cycle && (typeof cycle.startMs === "number" ? () => cycle.startMs as number : cycle.startMs);
  const checkpoints =
    cycle && startOf && !heartbeat
      ? reportCheckpoints(report, cycle.timeZone, (providerId) => Math.max(startOf(providerId), oldestMs))
      : [];
```

Update the doc comment above `storeReport` ("the start of the cycle the report falls in, or each provider's").

`lib/ingest.ts` — replace from `const rawSettings = …` to the end of the function:

```ts
  const rawSettings = await loadRawSettings().catch(() => undefined);
  const resolved = rawSettings === undefined ? null : resolveConfig(config, rawSettings);
  const timeZone = resolved?.reset.timeZone ?? config.reset.timeZone;

  const parsed = parseUsageReport(body, {
    now,
    maxClockSkewMinutes: config.maxClockSkewMinutes,
    retentionDays: config.retentionDays,
    timeZone,
  });
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  // The cycle the report falls in bounds its checkpoints (lib/days.ts): each
  // provider's own, since a provider can have its own reset. A report must
  // not fail over it: without the settings it is stored alone, and the next
  // report brings the same checkpoints along.
  const reportAt = new Date(parsed.report.timestampMs);
  const reportCycle = resolved && {
    timeZone: resolved.reset.timeZone,
    startMs: (providerId: string) => getCycle(reportAt, resetFor(resolved, providerId)).start.getTime(),
  };

  const stored = await storeReport(parsed.report, now, config.retentionDays, reportCycle);
  if (!stored.ok) return stored;

  // The earliest current cycle among the report's providers: what the client counted from.
  const cycle = resolved && earliestCycle(now, resolved, Object.keys(parsed.report.providers)).cycle;
  return { report: parsed.report, ...stored, cycle, tokenMode: config.tokenMode };
```

Update the `IngestResult.cycle` doc comment: "The earliest current cycle among the report's providers (the shared reset's for a heartbeat), when the settings could be read." Imports: `resetFor` from `@/lib/settings`, `earliestCycle` from `@/lib/provider-cycles`.

Add to `tests/integration/usage.test.ts` a case: settings with a Claude override `{ weekday: 4, monthDay: 1, hour: 9, minute: 0 }` (shared Monday 00:00 UTC), time `2026-09-23T12:00:00Z`, POST a report whose `days` cover `2026-09-16`…`2026-09-23` for `claude` and `openai`; assert no Claude checkpoint member (member JSON with `"c":1`) in `usage:events:claude:<group>` has a score `<= Date.parse("2026-09-17T09:00:00Z")`, while OpenAI checkpoints exist from `2026-09-21T00:00:00Z` on only (scores `> Date.parse("2026-09-21T00:00:00Z")`).

- [ ] **Step 4: Run the checks**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/days.ts lib/usage-store.ts lib/ingest.ts tests/days.test.ts tests/integration/usage.test.ts
git commit -m "feat(ingest): bound each provider's checkpoints by its own cycle"
```

---

### Task 8: `GET /api/usage`, export and machine moves

**Files:**
- Modify: `app/api/usage/route.ts:81-107` (GET)
- Modify: `app/api/export/route.ts`, `lib/export.ts` (per-provider window)
- Modify: `app/api/machines/[provider]/[machine]/route.ts:82` (`reset`)
- Modify: `docs/api.md`, `docs/upgrading.md`
- Test: `tests/integration/usage.test.ts`, `tests/integration/export.test.ts`, `tests/export.test.ts`

**Interfaces:**
- Consumes: `providerCycle`, `earliestCycle` (Task 2), `resetFor` (Task 1).
- Produces (plan 2 relies on it): `GET /api/usage` →
  `{ tokenMode, providers: string[], cycle: { start, end, sinceDate, timeZone, providers: { [providerId]: { start: string; end: string } } } }` — `start`/`end`/`sinceDate` are the earliest provider cycle's (shared reset included).
- Produces: `ExportProviderInput.cycle: { startMs: number; endMs: number }`; JSON export `providers[].cycle: { start, end }`.

- [ ] **Step 1: Write the failing tests**

`tests/integration/usage.test.ts` — a GET case with a Claude override `{ weekday: 4, monthDay: 1, hour: 9, minute: 0 }` (shared Monday 00:00 UTC), known providers `claude` and `openai`, time `2026-09-23T12:00:00Z`:

```ts
    expect(body.cycle.start).toBe("2026-09-17T09:00:00.000Z");
    expect(body.cycle.sinceDate).toBe("2026-09-17");
    expect(body.cycle.providers).toEqual({
      claude: { start: "2026-09-17T09:00:00.000Z", end: "2026-09-24T09:00:00.000Z" },
      openai: { start: "2026-09-21T00:00:00.000Z", end: "2026-09-28T00:00:00.000Z" },
    });
```

and assert that without an override `body.cycle.start` is `"2026-09-21T00:00:00.000Z"` (unchanged behaviour).

`tests/integration/export.test.ts` — with the same override, a JSON export (`?format=json`) lists Claude with `cycle.start === "2026-09-17T09:00:00.000Z"` and only Claude events at or after that instant, and OpenAI with `cycle.start === "2026-09-21T00:00:00.000Z"`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/integration/usage.test.ts tests/integration/export.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`app/api/usage/route.ts` GET — replace from `const cycle = getCycle(...)` to the end of the handler:

```ts
  const now = new Date();
  // One ccusage run covers every provider: it starts at the earliest provider cycle.
  const { cycle } = earliestCycle(now, effective, providerIds);
  const iso = (date: Date) => date.toISOString();
  return json(
    {
      tokenMode: effective.tokenMode,
      providers: providerIds,
      cycle: {
        start: iso(cycle.start),
        end: iso(cycle.end),
        sinceDate: dateInTimeZone(cycle.start, effective.reset.timeZone),
        timeZone: effective.reset.timeZone,
        // Each provider's own: a client trims every provider to its start (clients/shared/ccusage-providers.cjs).
        providers: Object.fromEntries(
          providerIds.map((providerId) => {
            const own = providerCycle(now, effective, providerId).cycle;
            return [providerId, { start: iso(own.start), end: iso(own.end) }];
          }),
        ),
      },
    },
    200,
  );
```

Update the route's header comment: the GET answer's `cycle` is the earliest provider cycle, with `cycle.providers` holding each provider's own. Drop the unused `getCycle` import.

`lib/export.ts` — add to `ExportProviderInput`:

```ts
  /** This provider's own window of the requested cycle (its reset may differ from the shared one). */
  cycle: { startMs: number; endMs: number };
```

and in `buildExportJsonPayload`'s providers mapping add `cycle: { start: new Date(provider.cycle.startMs).toISOString(), end: new Date(provider.cycle.endMs).toISOString() },` (and the matching field in `ExportJsonPayload`'s provider type). The top-level `cycle` stays: the earliest window.

`app/api/export/route.ts` — replace from `const cycle = getCycle(...)` down to the `input` object:

```ts
  const targetProviderIds = providerId ? [providerId] : visibleProviderIds(config, allProviderIds);
  const windowOf = (id: string) => {
    const { cycle, previous } = providerCycle(now, config, id);
    const window = cycleChoice === "previous" ? previous : cycle;
    return { startMs: window.start.getTime(), endMs: window.end.getTime() };
  };
  const earliest = earliestCycle(now, config, targetProviderIds);
  const earliestWindow = cycleChoice === "previous" ? earliest.previous : earliest.cycle;

  // One round trip covers both cycles of every provider, whichever was asked for.
  const { eventsByProvider } = await loadEvents(
    allProviderIds,
    indexes.groups,
    earliestStartMs(now, config, targetProviderIds, "previous"),
  );
  const historyByProvider = await loadHistory(targetProviderIds);

  const input: ExportInput = {
    generatedAtMs: now.getTime(),
    timeZone: config.reset.timeZone,
    cycle: { startMs: earliestWindow.start.getTime(), endMs: earliestWindow.end.getTime() },
    providers: targetProviderIds.map((id) => {
      const window = windowOf(id);
      return {
        id,
        label: providerLabel(id),
        cycle: window,
        events: (eventsByProvider[id] ?? []).filter((event) => event.ts >= window.startMs && event.ts < window.endMs),
        history: historyByProvider[id] ?? [],
      };
    }),
  };
```

Update the route comment's JSON shape (`providers: [{ id, label, cycle, events, history }]`). Fix `tests/export.test.ts` fixtures the compiler flags by adding `cycle: { startMs, endMs }` to each provider input (the same window as the fixture's top-level `cycle`).

`app/api/machines/[provider]/[machine]/route.ts` line 82: `reset: resetFor(config, segments.providerId),` (import `resetFor`).

`docs/api.md`: document `cycle.providers` on `GET /api/usage`, `providers[].cycle` on `GET /api/status` and on the JSON export. `docs/upgrading.md`: a new section "Per-provider reset (vX.Y)": once any provider has its own reset, re-run the installer on every machine — an older client counts every provider from the earliest cycle start (see plan 2); until then nothing changes.

- [ ] **Step 4: Run the checks**

Run: `npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/usage/route.ts app/api/export/route.ts lib/export.ts "app/api/machines/[provider]/[machine]/route.ts" docs/api.md docs/upgrading.md tests
git commit -m "feat(api): expose each provider's own cycle to clients and exports"
```

---

### Task 9: final verification

- [ ] **Step 1:** `npm run check` — PASS.
- [ ] **Step 2:** `npm run build && npm run e2e` — PASS (demo mode has no override: the dashboard must look exactly as before). Delete `.next/types` afterwards if a `next dev` is running (it breaks `tsc` with duplicate route types).
- [ ] **Step 3:** `grep -rn "getCycle(now, config.reset)\|getCycle(new Date(), effective.reset)" lib app` — only `lib/status.ts` (the payload's shared header) and `app/[locale]/(dashboard)/page.tsx` (the past-cycle picker, plan 3) remain.
- [ ] **Step 4:** Open the PR for this plan (branch `feat/official-report`), title `feat: per-provider budget cycle (server core)`.

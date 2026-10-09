# Official report endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client with an `official` token upload a provider's own weekly usage percentage; the server decides whether it fits the provider's cycle, moves that provider's reset to match the provider's window when it does not, and stores the figure as the dashboard's official reading.

**Architecture:** A third token scope, `official`, may read the status and call one new endpoint, `POST /api/official-usage/report`. Its decision is pure (`lib/official-report.ts`: parse the body, then decide — refuse a monthly dashboard, refuse a reading from a window already over, move the provider's reset when its cycle end is more than 15 minutes off the window's reset, skip a reading no newer than the stored one, else save). The route only loads, calls the decision, and writes: the provider's `resetOverrides` entry (with `source: "report"`) and the existing `usage:official` field (`enteredAt` = when the reading was taken).

**Tech Stack:** Next.js 16 route handlers, TypeScript, Vitest (in-memory Redis via `tests/helpers/redis-fixture.ts`), next-intl messages.

**Spec:** `docs/superpowers/specs/2026-10-09-official-usage-report-design.md` (Part 2). Builds on plans 1–3 (per-provider `resetOverrides` with `source?: "report"`, `resetFor`, `providerCycle`).

## Global Constraints

- Token scopes: `ingest | read | official`. `official` may `GET /api/status` and `POST /api/official-usage/report`; `POST /api/usage` refuses it with 403 `read_only_token`, like `read`. An `official` token is never bound to a machine. Only an `official` token may call the report endpoint (the shared `USAGE_API_TOKEN` and `ingest`/`read` tokens get 403 `official_scope_required`).
- Body: `{ "providerId": "claude", "usedPercent": 41.2, "resetsAtMs": <ms>, "observedAtMs": <ms> }`, at most 1 KB.
- Decision, in order: (1) dashboard period monthly → 409 `period_not_weekly`, nothing saved; (2) `resetsAtMs <= now` → 409 `stale_reading` (that window is over); (3) the provider's current cycle end differs from `resetsAtMs` by more than 15 minutes → set `resetOverrides[providerId]` to the weekday/hour/minute of `resetsAtMs` (rounded to the minute) in the dashboard's time zone, `source: "report"`, `cycleChanged: true`; (4) `observedAtMs` before the (possibly new) current cycle's start → 409 `stale_reading`; (5) the stored provider figure for that cycle has `enteredAt >= observedAtMs` → no write, `saved: false`; (6) else write `usage:official` field `providerId`: `raw` = `usedPercent` rounded to one decimal, `enteredAt` = `observedAtMs`, `cycleStartMs` = the current cycle's start; then the official-usage threshold alerts run as for a typed value.
- Responses: 200 `{ ok: true, saved, cycleChanged, reset: { weekday, hour, minute } | null }` · 400 `invalid_payload` · 401 · 403 `official_scope_required` · 409 `period_not_weekly` | `stale_reading` · 413/415/503 via `lib/api.ts` · `demo_read_only` in demo mode · 429 rate limit (`OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN` = 120/hour per token).
- Never an AI attribution in commit messages; Conventional Commits; `npm run check` green at the end of every task. UI text only through `messages/*.json` (en/hu/de parity).

---

### Task 1: the `official` token scope

**Files:**
- Modify: `lib/tokens.ts` (`TokenScope`, `TOKEN_SCOPES`, `parseStored`, `createToken`)
- Modify: `app/api/usage/route.ts:127` (refuse every scope but `ingest`)
- Modify: `app/api/tokens/route.ts` (doc comment; the scope check already uses `TOKEN_SCOPES`)
- Modify: `components/settings/sections/tokens-section.tsx` (scope type, option, list label, machine field disabled), `messages/en.json`, `hu.json`, `de.json`
- Modify: `lib/redis-keys.ts`, `docs/api.md`, `docs/clients.md`
- Test: `tests/tokens.test.ts`, `tests/integration/tokens.test.ts`, `tests/integration/usage.test.ts`

**Interfaces:**
- Produces: `TokenScope = "ingest" | "read" | "official"`; `BearerAuth.scope` can be `"official"` (Task 3 checks it).

- [ ] **Step 1: Write the failing tests**

`tests/tokens.test.ts` (follow its existing create/verify cases): creating a token with scope `"official"` stores `scope: "official"` and `machineId: null` even when a machine id is passed; verifying it returns `scope: "official"`; a stored entry with `scope: "official"` parses back as `"official"`.

`tests/integration/tokens.test.ts`: `POST /api/tokens` with `{ label: "Mac menu bar", scope: "official" }` → 201; the `GET` listing shows `scope: "official"`.

`tests/integration/usage.test.ts`: a `POST /api/usage` with a valid report and an `official` token's Bearer → 403 `read_only_token`; `GET /api/status` with it → 200 (in `tests/integration/status.test.ts` if that is where status auth is tested).

- [ ] **Step 2: Run them to see them fail** — `npx vitest run tests/tokens.test.ts tests/integration/tokens.test.ts tests/integration/usage.test.ts`: FAIL.

- [ ] **Step 3: Implement**

`lib/tokens.ts`:

```ts
/**
 * "ingest" reports usage; "read" only reads (the menu bar app's status);
 * "official" reads too, and uploads a provider's own usage percentage
 * (POST /api/official-usage/report). Neither of the last two may report tokens.
 */
export type TokenScope = "ingest" | "read" | "official";
export const TOKEN_SCOPES: readonly TokenScope[] = ["ingest", "read", "official"];
```

`parseStored`: `scope: entry.scope === "read" || entry.scope === "official" ? entry.scope : "ingest",`. `createToken`: `machineId: scope === "ingest" ? machineId : null,`.

`app/api/usage/route.ts` POST: `if (auth.scope !== "ingest") return apiError("read_only_token", 403);` and the header comment: "read_only_token (a "read" or "official" token, which may not report tokens)".

`tokens-section.tsx`: `type Scope = "ingest" | "read" | "official";` (update its comment); the machine field is disabled and empty for any scope but `"ingest"` (`scope !== "ingest"` where it now tests `scope === "read"`, also in `performCreate`'s call); a third `<option value="official">{t("tokens_scope_official")}</option>`; the list label shows `t("tokens_scope_official")` for `token.scope === "official"` (before the machine branches).

Messages (`Settings` namespace, next to `tokens_scope_read`):
- en: `"tokens_scope_official": "Read and upload official usage (menu bar app)"`
- hu: `"tokens_scope_official": "Olvasás és hivatalos % feltöltése (menüsáv app)"`
- de: `"tokens_scope_official": "Lesen und offizielle Nutzung hochladen (Menüleisten-App)"`

Docs: `lib/redis-keys.ts` (`"scope" is "ingest" (absent in older entries), "read" or "official"`); `docs/api.md` per-machine tokens section and the `read_only_token` row ("A "read" or "official" token tried to report"); `docs/clients.md` next to the read-only paragraph: an **official** token is what the menu bar app needs to upload the providers' own percentages.

- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(tokens): add an official scope for uploading providers' own usage"`

---

### Task 2: the pure decision — `lib/official-report.ts`

**Files:**
- Modify: `lib/cycle.ts` (export `wallClockOf`)
- Create: `lib/official-report.ts`
- Test: `tests/official-report.test.ts`, `tests/cycle.test.ts`

**Interfaces:**
- Consumes: `providerCycle` (lib/provider-cycles.ts), `AppConfig`, `ResetOverride`, `OfficialEntryView` (lib/official-usage.ts).
- Produces:
  - `export function wallClockOf(date: Date, timeZone: string): { weekday: number; day: number; hour: number; minute: number }` (lib/cycle.ts)
  - `export interface OfficialReport { providerId: string; usedPercent: number; resetsAtMs: number; observedAtMs: number }`
  - `export function parseOfficialReport(input: unknown, now: Date): { ok: true; report: OfficialReport } | { ok: false; errors: string[] }`
  - `export type OfficialReportDecision = { kind: "period_not_weekly" } | { kind: "stale_reading" } | { kind: "accept"; save: boolean; override: ResetOverride | null; cycleStartMs: number; raw: string }`
  - `export function decideOfficialReport(report: OfficialReport, config: AppConfig, now: Date, stored: OfficialEntryView | null, storedCycleStartMs: number | null): OfficialReportDecision` — `override` is the new entry when the reset moves, else null; `stored`/`storedCycleStartMs` are the provider's current `usage:official` entry and the cycle it was saved for (null when none).
  - `export const RESET_TOLERANCE_MS = 15 * 60_000`

- [ ] **Step 1: Write the failing tests**

`tests/cycle.test.ts`:

```ts
describe("wallClockOf", () => {
  it("reads the wall clock in a time zone", () => {
    expect(wallClockOf(new Date("2026-09-24T07:00:00Z"), "Europe/Budapest")).toEqual({
      weekday: 4,
      day: 24,
      hour: 9,
      minute: 0,
    });
  });
});
```

`tests/official-report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getConfig } from "@/lib/config";
import { decideOfficialReport, parseOfficialReport } from "@/lib/official-report";

// Wednesday 2026-09-23 12:00 UTC; shared reset Monday 00:00 UTC.
const NOW = new Date("2026-09-23T12:00:00Z");
const base = {
  ...getConfig(),
  reset: { period: "weekly" as const, weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
  resetOverrides: {},
};
const report = (overrides: Partial<Record<string, unknown>> = {}) => ({
  providerId: "claude",
  usedPercent: 41.24,
  resetsAtMs: Date.parse("2026-09-24T09:00:00Z"),
  observedAtMs: Date.parse("2026-09-23T11:50:00Z"),
  ...overrides,
});
const parsed = (overrides = {}) => {
  const result = parseOfficialReport(report(overrides), NOW);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.report;
};

describe("parseOfficialReport", () => {
  it("accepts a well-formed report", () => {
    expect(parsed()).toEqual(report());
  });

  it("rejects bad fields", () => {
    const result = parseOfficialReport(
      { providerId: "!!", usedPercent: -1, resetsAtMs: "x", observedAtMs: NOW.getTime() + 10 * 60_000 },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toHaveLength(4);
  });

  it("rejects a window that resets before the reading or more than a week after it", () => {
    expect(parseOfficialReport(report({ resetsAtMs: Date.parse("2026-09-23T11:00:00Z") }), NOW).ok).toBe(false);
    expect(parseOfficialReport(report({ resetsAtMs: Date.parse("2026-10-01T12:00:00Z") }), NOW).ok).toBe(false);
  });
});

describe("decideOfficialReport", () => {
  it("refuses a monthly dashboard", () => {
    const monthly = { ...base, reset: { ...base.reset, period: "monthly" as const } };
    expect(decideOfficialReport(parsed(), monthly, NOW, null, null)).toEqual({ kind: "period_not_weekly" });
  });

  it("moves the provider's reset to the window's, and saves for the new cycle", () => {
    expect(decideOfficialReport(parsed(), base, NOW, null, null)).toEqual({
      kind: "accept",
      save: true,
      override: { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" },
      cycleStartMs: Date.parse("2026-09-17T09:00:00Z"),
      raw: "41.2",
    });
  });

  it("keeps the reset within the tolerance", () => {
    const aligned = { ...base, resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } } };
    const decision = decideOfficialReport(
      parsed({ resetsAtMs: Date.parse("2026-09-24T09:10:00Z") }),
      aligned,
      NOW,
      null,
      null,
    );
    expect(decision).toMatchObject({ kind: "accept", save: true, override: null });
  });

  it("rounds the window's reset to the minute", () => {
    const decision = decideOfficialReport(
      parsed({ resetsAtMs: Date.parse("2026-09-24T08:59:59.600Z") }),
      base,
      NOW,
      null,
      null,
    );
    expect(decision).toMatchObject({ override: { weekday: 4, hour: 9, minute: 0 } });
  });

  it("refuses a reading taken before the current cycle began", () => {
    const aligned = { ...base, resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } } };
    // Taken five minutes before this cycle began (still within a week of the window's reset).
    const old = parsed({ observedAtMs: Date.parse("2026-09-17T08:55:00Z") });
    expect(decideOfficialReport(old, aligned, NOW, null, null)).toEqual({ kind: "stale_reading" });
  });

  it("does not overwrite a figure at least as recent", () => {
    const aligned = { ...base, resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } } };
    const cycleStartMs = Date.parse("2026-09-17T09:00:00Z");
    const stored = { raw: "50", enteredAt: Date.parse("2026-09-23T11:55:00Z") };
    expect(decideOfficialReport(parsed(), aligned, NOW, stored, cycleStartMs)).toMatchObject({ save: false });
    const older = { raw: "30", enteredAt: Date.parse("2026-09-23T10:00:00Z") };
    expect(decideOfficialReport(parsed(), aligned, NOW, older, cycleStartMs)).toMatchObject({ save: true });
    // A figure stored for another cycle does not count.
    expect(decideOfficialReport(parsed(), aligned, NOW, stored, cycleStartMs - 7 * 86_400_000)).toMatchObject({
      save: true,
    });
  });

  it("keeps the provider's month day when it moves a weekly reset", () => {
    const withMonthDay = { ...base, resetOverrides: { claude: { weekday: 1, monthDay: 15, hour: 0, minute: 0 } } };
    expect(decideOfficialReport(parsed(), withMonthDay, NOW, null, null)).toMatchObject({
      override: { weekday: 4, monthDay: 15, hour: 9, minute: 0, source: "report" },
    });
  });
});
```

(The "stale" case: with `resetsAtMs` in the future step 2 passes; the aligned cycle is 09-17T09:00 → 09-24T09:00 and the reading at 09-17T08:55 is before its start → step 4; it is 7 days 5 minutes before the window's reset, inside the parser's week-plus-tolerance.)

- [ ] **Step 2: Run them to see them fail** — `npx vitest run tests/official-report.test.ts tests/cycle.test.ts`: FAIL.

- [ ] **Step 3: Implement**

`lib/cycle.ts`, after `dateInTimeZone`:

```ts
/** The wall clock `date` shows in `timeZone`: what a reset moment is stored as. */
export function wallClockOf(date: Date, timeZone: string): { weekday: number; day: number; hour: number; minute: number } {
  const { weekday, day, hour, minute } = zonedParts(date, timeZone);
  return { weekday, day, hour, minute };
}
```

`lib/official-report.ts`:

```ts
import type { AppConfig, ResetOverride } from "@/lib/config";
import { wallClockOf } from "@/lib/cycle";
import type { OfficialEntryView } from "@/lib/official-usage";
import { providerCycle } from "@/lib/provider-cycles";
import { normalizeProviderId } from "@/lib/providers";
import { resetFor } from "@/lib/settings";

/**
 * A provider's own usage percentage, as a client read it on its machine (the
 * macOS menu bar app: Claude Code's status line, Codex's session logs), and
 * what the server does with it (POST /api/official-usage/report). Pure.
 *
 * The figure is the provider's weekly window; the dashboard's cycle for that
 * provider must be the same week for it to mean anything. So the window's
 * own reset decides: a provider whose cycle ends elsewhere gets its reset
 * moved to the window's (lib/settings.ts `resetOverrides`, marked as set by a
 * report), and the figure is then stored for that cycle.
 */

export const RESET_TOLERANCE_MS = 15 * 60_000;
const WEEK_MS = 7 * 86_400_000;
/** A reading's clock may run a little ahead of the server's. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_PERCENT = 1000;

export interface OfficialReport {
  providerId: string;
  /** 0–1000: a provider may report more than 100 once the limit is passed. */
  usedPercent: number;
  /** When the provider's weekly window resets (epoch ms). */
  resetsAtMs: number;
  /** When the client read the figure (epoch ms). */
  observedAtMs: number;
}

export type OfficialReportParseResult = { ok: true; report: OfficialReport } | { ok: false; errors: string[] };

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function parseOfficialReport(input: unknown, now: Date): OfficialReportParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const { providerId: rawProviderId, usedPercent, resetsAtMs, observedAtMs } = input as Record<string, unknown>;
  const errors: string[] = [];
  const providerId = normalizeProviderId(rawProviderId);
  if (!providerId) errors.push("providerId must be a valid provider id");
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > MAX_PERCENT) {
    errors.push(`usedPercent must be a number from 0 to ${MAX_PERCENT}`);
  }
  if (!isTime(resetsAtMs)) errors.push("resetsAtMs must be epoch milliseconds");
  if (!isTime(observedAtMs) || observedAtMs > now.getTime() + MAX_CLOCK_SKEW_MS) {
    errors.push("observedAtMs must be epoch milliseconds, not in the future");
  }
  if (errors.length === 0) {
    const ahead = (resetsAtMs as number) - (observedAtMs as number);
    if (ahead <= 0 || ahead > WEEK_MS + RESET_TOLERANCE_MS) {
      errors.push("resetsAtMs must be within a week after observedAtMs");
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    report: {
      providerId: providerId!,
      usedPercent: usedPercent as number,
      resetsAtMs: resetsAtMs as number,
      observedAtMs: observedAtMs as number,
    },
  };
}

export type OfficialReportDecision =
  | { kind: "period_not_weekly" }
  | { kind: "stale_reading" }
  | {
      kind: "accept";
      /** False: a figure at least as recent is already stored for this cycle. */
      save: boolean;
      /** The provider's new reset, when it moves to the window's; null when it already matches. */
      override: ResetOverride | null;
      cycleStartMs: number;
      /** `usedPercent` as the dashboard's ground-truth field stores it. */
      raw: string;
    };

/**
 * What to do with `report` (see the module comment). `stored` is the
 * provider's current `usage:official` entry, `storedCycleStartMs` the cycle
 * it was saved for; both null when there is none.
 */
export function decideOfficialReport(
  report: OfficialReport,
  config: AppConfig,
  now: Date,
  stored: OfficialEntryView | null,
  storedCycleStartMs: number | null,
): OfficialReportDecision {
  if (config.reset.period !== "weekly") return { kind: "period_not_weekly" };
  if (report.resetsAtMs <= now.getTime()) return { kind: "stale_reading" };

  let effective = config;
  let override: ResetOverride | null = null;
  const current = providerCycle(now, config, report.providerId).cycle;
  if (Math.abs(current.end.getTime() - report.resetsAtMs) > RESET_TOLERANCE_MS) {
    const resetAt = new Date(Math.round(report.resetsAtMs / 60_000) * 60_000);
    const { weekday, hour, minute } = wallClockOf(resetAt, config.reset.timeZone);
    override = { weekday, monthDay: resetFor(config, report.providerId).monthDay, hour, minute, source: "report" };
    effective = { ...config, resetOverrides: { ...config.resetOverrides, [report.providerId]: override } };
  }

  const cycleStartMs = providerCycle(now, effective, report.providerId).cycle.start.getTime();
  if (report.observedAtMs < cycleStartMs) return { kind: "stale_reading" };

  const raw = String(Math.round(report.usedPercent * 10) / 10);
  const newer = stored === null || storedCycleStartMs !== cycleStartMs || stored.enteredAt < report.observedAtMs;
  return { kind: "accept", save: newer, override, cycleStartMs, raw };
}
```

(If importing `lib/settings.ts` here creates an import cycle, read the provider's current month day as `config.resetOverrides[providerId]?.monthDay ?? config.reset.monthDay` instead of `resetFor`.)

- [ ] **Step 4: Run** the two test files, then `npm run check` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(official-usage): decide what to do with a provider's own usage report"`

---

### Task 3: the route

**Files:**
- Modify: `lib/usage-store.ts` (new `saveResetOverride`, `loadOfficialEntryRaw` or reuse `loadIndexes`)
- Modify: `lib/api.ts` (error codes `official_scope_required`, `period_not_weekly`, `stale_reading`)
- Modify: `lib/config.ts` (`OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN = 120`)
- Create: `app/api/official-usage/report/route.ts`
- Modify: `docs/api.md` (new endpoint, the three error codes)
- Test: `tests/integration/official-report.test.ts` (new)

**Interfaces:**
- Consumes: `parseOfficialReport`, `decideOfficialReport` (Task 2); `BearerAuth.scope === "official"` (Task 1); `saveOfficialUsage(update, now)` (existing: `now` becomes `enteredAt`); `checkOfficialUsageAlerts(update, now)` (existing).
- Produces (plan 5 relies on it): the endpoint and its responses exactly as in Global Constraints.

- [ ] **Step 1: Write the failing test** — `tests/integration/official-report.test.ts`, following `tests/integration/official-usage.test.ts` and `tests/integration/tokens.test.ts` for setup (`useRedis()`, creating tokens with `createToken`, freezing time the way `tests/integration/status.test.ts` does). Shared reset weekly Monday 00:00 UTC (save settings with `saveSettings` or write the document as other tests do); time `2026-09-23T12:00:00Z`; body as in Task 2's `report()`.

Cases:
1. no token → 401; an `ingest` token and a `read` token → 403 `official_scope_required`.
2. an `official` token, monthly settings → 409 `period_not_weekly`, nothing written to `usage:official`.
3. an `official` token, weekly settings, first report → 200 `{ ok: true, saved: true, cycleChanged: true, reset: { weekday: 4, hour: 9, minute: 0 } }`; the stored settings now have `resetOverrides.claude` = `{ weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" }`; `usage:official` field `claude` = `{"raw":"41.2","enteredAt":<observedAtMs>,"cycleStartMs":<2026-09-17T09:00Z>}`; and `GET /api/status` with the same token shows Claude `percent: 41.2`, `source: "official"`, `cycle.start: "2026-09-17T09:00:00.000Z"`.
4. the same report again → 200 `{ saved: false, cycleChanged: false, reset: null }`.
5. `resetsAtMs` in the past → 409 `stale_reading`.
6. a malformed body → 400 `invalid_payload` with `details`.
7. demo mode (`vi.stubEnv("DEMO_MODE", "1")`, as `tests/integration/demo-mode.test.ts` does) → `demo_read_only`.

- [ ] **Step 2: Run it to see it fail** — `npx vitest run tests/integration/official-report.test.ts`: FAIL (route missing).

- [ ] **Step 3: Implement**

`lib/config.ts`, next to `STATUS_RATE_LIMIT_PER_TOKEN`: `/** POST /api/official-usage/report calls per token per hour. */ export const OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN = 120;`

`lib/api.ts`: add `"official_scope_required" | "period_not_weekly" | "stale_reading"` to the error-code union.

`lib/usage-store.ts`:

```ts
/**
 * Sets one provider's own reset in the stored settings (an official report
 * moving it to the provider's window; lib/official-report.ts). Read, change,
 * write: a settings save racing it wins or loses as a whole, like two panel saves.
 */
export async function saveResetOverride(providerId: string, override: ResetOverride, now: Date, providerIds: string[]): Promise<void> {
  const config = getConfig();
  const settings = parseStoredSettings(await loadRawSettings(), settingsFromConfig(config, providerIds));
  settings.resetOverrides = { ...settings.resetOverrides, [providerId]: override };
  await getRedis().set(KEYS.settings, serializeSettings(settings, now));
}
```

(Import what is missing; follow how `saveSettings` writes `KEYS.settings`.)

`app/api/official-usage/report/route.ts`:

```ts
import { checkOfficialUsageAlerts } from "@/lib/alerts";
import { apiError, json, readJsonBody, requireBearerThrottled, withApiHandler } from "@/lib/api";
import { currentTime } from "@/lib/clock";
import { getConfig, OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN } from "@/lib/config";
import { demoReadOnly } from "@/lib/demo/mode";
import { decideOfficialReport, parseOfficialReport } from "@/lib/official-report";
import { officialUsageField } from "@/lib/official-usage";
import { mergeProviderIds } from "@/lib/providers";
import { hit } from "@/lib/rate-limit";
import { defer } from "@/lib/request-context";
import { resolveConfig, storedProviderIds } from "@/lib/settings";
import { loadIndexes, saveOfficialUsage, saveResetOverride } from "@/lib/usage-store";
// plus: import { parseStoredOfficialEntry } from "@/lib/official-usage" (merged with the officialUsageField import)

/**
 * POST /api/official-usage/report — a provider's own weekly usage percentage,
 * read on a machine (the macOS menu bar app), as the dashboard's official
 * reading. Only an "official" token (lib/tokens.ts) may send it.
 *
 *   { "providerId": "claude", "usedPercent": 41.2, "resetsAtMs": …, "observedAtMs": … }
 *
 * The server decides (lib/official-report.ts): a monthly dashboard refuses it;
 * a provider whose cycle ends elsewhere than the window gets its reset moved
 * to the window's; a reading no newer than the stored one is not written.
 *
 * 200 { ok, saved, cycleChanged, reset } · 400 bad payload · 401 bad token ·
 * 403 official_scope_required · 409 period_not_weekly | stale_reading ·
 * 413 body too large · 415 not JSON · 429 rate limited · 503 Redis down
 */

const MAX_BODY_BYTES = 1_024;

export const POST = withApiHandler("api/official-usage/report", async ({ request }) => {
  const readOnly = demoReadOnly();
  if (readOnly) return readOnly;

  const auth = await requireBearerThrottled(request);
  if (auth instanceof Response) return auth;
  if (auth.scope !== "official") return apiError("official_scope_required", 403);

  const limit = await hit(`usage:rl:official:${auth.tokenId}`, OFFICIAL_REPORT_RATE_LIMIT_PER_TOKEN, 3600);
  if (!limit.allowed) return apiError("rate_limited", 429, { retryAfterSeconds: limit.retryAfterSeconds });

  const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
  if (!body.ok) return body.response;

  const now = currentTime();
  const parsed = parseOfficialReport(body.value, now);
  if (!parsed.ok) return apiError("invalid_payload", 400, { details: parsed.errors });
  const { report } = parsed;

  const indexes = await loadIndexes();
  const providerIds = mergeProviderIds(
    indexes.providers.map((provider) => provider.providerId),
    storedProviderIds(indexes.settings),
  );
  const config = resolveConfig(getConfig(), indexes.settings, providerIds);
  const storedRaw = indexes.officialUsage[officialUsageField(report.providerId, null)];
  const stored = storedRaw ? parseStoredOfficialEntry(storedRaw) : null;

  const decision = decideOfficialReport(report, config, now, stored?.view ?? null, stored?.cycleStartMs ?? null);
  if (decision.kind !== "accept") return apiError(decision.kind, 409);

  if (decision.override) await saveResetOverride(report.providerId, decision.override, now, providerIds);
  if (decision.save) {
    const update = { providerId: report.providerId, subLimitId: null, raw: decision.raw, cycleStartMs: decision.cycleStartMs };
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
    },
    200,
  );
});
```

`parseStoredOfficialEntry` does not exist yet: in `lib/official-usage.ts` export a small reader next to `currentOfficialEntries`:

```ts
/** One stored entry, with the cycle it was saved for; null when it does not parse. */
export function parseStoredOfficialEntry(raw: string): { view: OfficialEntryView; cycleStartMs: number } | null {
  const entry = parseStoredEntry(raw);
  return entry && { view: { raw: entry.raw, enteredAt: entry.enteredAt }, cycleStartMs: entry.cycleStartMs };
}
```

(import it in the route; use `currentTime` only if the existing routes do — `app/api/official-usage/route.ts` uses `Date.now()`; tests freeze time through `lib/clock.ts`, so prefer `currentTime()`.)

`docs/api.md`: a section for the endpoint (body, decision order, responses) next to `PUT /api/official-usage`, and rows for the three error codes in the error table.

- [ ] **Step 4: Run** `npx vitest run tests/integration/official-report.test.ts` then `npm run check` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(api): accept a provider's own usage percentage from an official token"`

---

### Task 4: final verification

- [ ] **Step 1:** `npm run check` — PASS.
- [ ] **Step 2:** `npm run build && npm run e2e` — PASS; delete `.next/types` afterwards if `tsc` complains.
- [ ] **Step 3:** By hand against a local real store (as in plan 3 Task 5: `npm run redis:up`, `npx next dev -p 3170` with inline env; if another `next dev` holds the repo, run from a scratch copy of the tree): create an `official` token on the settings page, `curl -X POST …/api/official-usage/report` with it and the Task 3 body (with `resetsAtMs`/`observedAtMs` around the real now), then open the dashboard — Claude shows the official percentage with the reading's time, and Settings shows Claude's own reset with "Set by the menu bar app". Stop the server, `npm run redis:down` if you started it. No push, no PR.

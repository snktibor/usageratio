# Per-provider budget cycle — dashboard and settings UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user see and set each provider's own reset on the settings page, and make the dashboard's past-cycle navigation follow the selected provider's own cycles.

**Architecture:** `ResetOverride` gains an optional `source: "report"` marker (written later by the official-report endpoint, plan 4; dropped when the panel edits the entry). The settings draft keeps each override as editable text (`DraftOwnReset`) with pure helpers to switch it on/off and patch it; the reset section lists every provider under the shared reset with an "own" checkbox, a day picker and a time field. On the dashboard, the server picks the selected provider (cookie, else the first visible one), lists that provider's cycles (its own reset, its own archive) via a new pure `providerCycleOptions`, and while a past cycle is shown, switching provider goes back to the current cycle.

**Tech Stack:** Next.js 16 App Router, React 19, next-intl (`messages/en.json`, `hu.json`, `de.json`), Tailwind v4, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-09-official-usage-report-design.md` (Part 1c). Builds on plan 1 (settings model `resetOverrides`, `resetFor`, `lib/provider-cycles.ts`).

## Global Constraints

- Layout chosen by the user (settings → reset section, under the shared reset):

  ```
  Szolgáltatónként
  Claude   [x] saját   [Csütörtök ▾] [09:00]
           ↳ a Mac app állította be
  OpenAI   [ ] saját   (közös: hétfő 00:00)
  ```

  Weekly period: a weekday picker; monthly: a month-day picker (1–31), like the shared reset. The "set by the app" note shows only while the entry still has `source: "report"`; any edit of that provider's row drops it.
- UI text only through `messages/*.json`, en/hu/de in parity (`tests/messages.test.ts` checks parity, ICU consistency and that every key is used).
- Turning "own" on starts from the shared reset's current day and time; turning it off removes the provider's entry.
- Past cycles: the picker lists the selected provider's cycles; `?cycle=` names a start of the selected provider; switching provider while a past cycle (detail or summary) is shown navigates to `/` (the current cycle) after writing the provider cookie.
- No chart library, no new dependency. Match the existing components' classes (`FIELD`, `QUIET_BUTTON`, `text-ink-3` …).
- `npm run check` passes at the end of every task; Conventional Commits; never any AI attribution in commit messages.

---

### Task 1: `source` on a reset override

**Files:**
- Modify: `lib/config.ts` (`ResetOverride`), `lib/settings.ts` (`readResetOverride`, `copyResetOverrides`)
- Modify: `lib/redis-keys.ts`, `docs/data-model.md`, `docs/api.md` (one line each: the optional `source`)
- Test: `tests/settings.test.ts`

**Interfaces:**
- Produces: `ResetOverride.source?: "report"` — plan 4's endpoint writes `"report"`; the panel shows a note for it and drops it on edit.

- [ ] **Step 1: Write the failing tests** — in `tests/settings.test.ts`, in `describe("per-provider reset")`:

```ts
  it("keeps a report's source marker, and drops anything else in that field", () => {
    const defaults = settingsFromConfig(getConfig());
    const raw = JSON.stringify({
      ...defaults,
      resetOverrides: {
        claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" },
        openai: { weekday: 1, monthDay: 1, hour: 0, minute: 0, source: "someone" },
      },
    });
    expect(parseStoredSettings(raw, defaults).resetOverrides).toEqual({
      claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" },
      openai: { weekday: 1, monthDay: 1, hour: 0, minute: 0 },
    });
  });
```

and in `describe("parseSettingsUpdate")`:

```ts
  it("accepts a report's source marker on an override, and nothing else there", () => {
    const withSource = parseSettingsUpdate({
      ...valid,
      resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "report" } },
    });
    if (!withSource.ok) throw new Error(withSource.errors.join("; "));
    expect(withSource.update.settings.resetOverrides.claude).toEqual({
      weekday: 4,
      monthDay: 1,
      hour: 9,
      minute: 0,
      source: "report",
    });
    const bad = parseSettingsUpdate({
      ...valid,
      resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0, source: "panel" } },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors).toContain('resetOverrides.claude.source must be "report", or absent');
  });
```

- [ ] **Step 2: Run them to see them fail** — `npx vitest run tests/settings.test.ts`: FAIL (`source` is dropped).

- [ ] **Step 3: Implement**

`lib/config.ts`, in `ResetOverride` after `minute`:

```ts
  /** "report": set by an official report (lib/official-report.ts), not on the panel; the panel drops it on edit. */
  source?: "report";
```

`lib/settings.ts` `readResetOverride`: the stored reader is lenient about `source` (anything but `"report"` is ignored), the PUT parser strict. Add a parameter `strict: boolean` is not needed: the stored reader passes no `errors`, the PUT parser does. Inside the `else` branch add

```ts
    if (entry.source !== undefined && entry.source !== "report" && errors) {
      problems.push(`${field}.source must be "report", or absent`);
    }
```

and build the result as

```ts
  const { weekday, monthDay, hour, minute, source } = entry as Record<string, unknown>;
  const override: ResetOverride = {
    weekday: weekday as number,
    monthDay: monthDay as number,
    hour: hour as number,
    minute: minute as number,
  };
  if (source === "report") override.source = "report";
  return override;
```

`copyResetOverrides` already spreads each entry, so it carries `source`.

Docs: in `lib/redis-keys.ts`, `docs/data-model.md` and the `PUT /api/settings` part of `docs/api.md`, add to the override shape: `source?: "report"` — set by an official report; the panel drops it when the entry is edited.

- [ ] **Step 4: Run** `npm run check` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(settings): remember when a report set a provider's reset"`

---

### Task 2: the draft edits per-provider resets

**Files:**
- Modify: `components/settings/draft.ts`, `components/settings/problem-text.ts`, `messages/en.json`, `messages/hu.json`, `messages/de.json`
- Test: `tests/settings-draft.test.ts`

**Interfaces:**
- Produces:
  - `export interface DraftOwnReset { weekday: number; monthDay: number; /** "HH:MM" as typed */ time: string; source?: "report" }`
  - `Draft.resetOverrides: Record<string, DraftOwnReset>` (replaces the pass-through `Record<string, ResetOverride>`)
  - `export function withOwnReset(draft: Draft, providerId: string, own: boolean): Draft`
  - `export function patchOwnReset(draft: Draft, providerId: string, changes: Partial<Omit<DraftOwnReset, "source">>): Draft`
  - `DraftProblem` gains `{ code: "invalid_own_reset_time"; label: string }`
  - `toRequest` sends `resetOverrides: Record<string, ResetOverride>` (hour/minute from `time`, `source` kept when present).

- [ ] **Step 1: Write the failing tests** — append to `tests/settings-draft.test.ts` (it already builds drafts from a `SettingsView` fixture; reuse that helper — look at the file's existing `draftFrom` / `toRequest` cases and use the same view builder, giving it providers `claude` and `openai` and `resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 5, source: "report" } }`):

```ts
describe("per-provider resets", () => {
  it("draftFrom turns an override into editable text, keeping its source", () => {
    expect(draft.resetOverrides).toEqual({ claude: { weekday: 4, monthDay: 1, time: "09:05", source: "report" } });
  });

  it("switching one on starts from the shared reset; switching it off removes it", () => {
    const on = withOwnReset(draft, "openai", true);
    expect(on.resetOverrides.openai).toEqual({ weekday: draft.weekday, monthDay: draft.monthDay, time: draft.time });
    expect(withOwnReset(on, "openai", false).resetOverrides).not.toHaveProperty("openai");
  });

  it("an edit drops the report's source marker", () => {
    const edited = patchOwnReset(draft, "claude", { time: "10:00" });
    expect(edited.resetOverrides.claude).toEqual({ weekday: 4, monthDay: 1, time: "10:00" });
  });

  it("toRequest sends hour and minute, with the source while it is still there", () => {
    const result = toRequest(draft);
    if (!("request" in result)) throw new Error(JSON.stringify(result.problem));
    expect(result.request.resetOverrides).toEqual({
      claude: { weekday: 4, monthDay: 1, hour: 9, minute: 5, source: "report" },
    });
  });

  it("refuses an own reset whose time is not HH:MM", () => {
    expect(toRequest(patchOwnReset(draft, "claude", { time: "9" }))).toEqual({
      problem: { code: "invalid_own_reset_time", label: "Claude" },
    });
  });
});
```

(`draft` is `draftFrom(view)` of that fixture; `Claude` is `providerLabel("claude")`.)

- [ ] **Step 2: Run them to see them fail** — `npx vitest run tests/settings-draft.test.ts`: FAIL (helpers missing).

- [ ] **Step 3: Implement** in `components/settings/draft.ts`:

```ts
/** A provider's own reset on the form: its moment as typed; `source` only while a report's value is untouched. */
export interface DraftOwnReset {
  weekday: number;
  monthDay: number;
  /** "HH:MM", as typed. */
  time: string;
  source?: "report";
}
```

- `Draft.resetOverrides: Record<string, DraftOwnReset>;` with the comment "providerId → its own reset; absent: the shared one."
- In `draftFrom`, replace `resetOverrides,` with

```ts
    resetOverrides: Object.fromEntries(
      Object.entries(resetOverrides).map(([providerId, override]) => [
        providerId,
        {
          weekday: override.weekday,
          monthDay: override.monthDay,
          time: `${twoDigits(override.hour)}:${twoDigits(override.minute)}`,
          ...(override.source ? { source: override.source } : {}),
        },
      ]),
    ),
```

- New helpers (after `withNewGroup`):

```ts
/** Gives `providerId` its own reset, starting from the shared one, or takes it away. */
export function withOwnReset(draft: Draft, providerId: string, own: boolean): Draft {
  const { [providerId]: _, ...others } = draft.resetOverrides;
  if (!own) return { ...draft, resetOverrides: others };
  return {
    ...draft,
    resetOverrides: { ...others, [providerId]: { weekday: draft.weekday, monthDay: draft.monthDay, time: draft.time } },
  };
}

/** Edits a provider's own reset; an edit makes it the panel's own, so a report's marker goes. */
export function patchOwnReset(
  draft: Draft,
  providerId: string,
  changes: Partial<Omit<DraftOwnReset, "source">>,
): Draft {
  const current = draft.resetOverrides[providerId];
  if (!current) return draft;
  const { source: _, ...rest } = current;
  return { ...draft, resetOverrides: { ...draft.resetOverrides, [providerId]: { ...rest, ...changes } } };
}
```

- `DraftProblem`: add `| { code: "invalid_own_reset_time"; label: string }`.
- In `toRequest`, after the shared time check:

```ts
  const resetOverrides: Record<string, ResetOverride> = {};
  for (const [providerId, own] of Object.entries(draft.resetOverrides)) {
    const ownTime = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(own.time);
    if (!ownTime) {
      const label = draft.providers.find((provider) => provider.id === providerId)?.label ?? providerId;
      return { problem: { code: "invalid_own_reset_time", label } };
    }
    resetOverrides[providerId] = {
      weekday: own.weekday,
      monthDay: own.monthDay,
      hour: Number(ownTime[1]),
      minute: Number(ownTime[2]),
      ...(own.source ? { source: own.source } : {}),
    };
  }
```

  and send `resetOverrides,` in the request.
- `problem-text.ts`: `case "invalid_own_reset_time": return t("invalid_own_reset_time", { label: problem.label });` (follow the file's existing pattern for codes with a label).
- Messages (`Settings` namespace, same place as `reset_time_format_error`):
  - en: `"invalid_own_reset_time": "Give {label}'s own reset time as hour:minute, e.g. 09:00."`
  - hu: `"invalid_own_reset_time": "{label} saját nullázási idejét óra:perc alakban add meg, pl. 09:00."`
  - de: `"invalid_own_reset_time": "Gib die eigene Rücksetzzeit von {label} als Stunde:Minute an, z. B. 09:00."`

- [ ] **Step 4: Run** `npm run check` — PASS (the messages test also checks the new key is used: it is, in `problem-text.ts`).
- [ ] **Step 5: Commit** — `git commit -m "feat(settings): edit each provider's own reset in the draft"`

---

### Task 3: the reset section lists the providers

**Files:**
- Modify: `components/settings/sections/reset-section.tsx`, `components/settings/use-settings-form.ts` (actions), `components/settings/settings-page.tsx:185`, `messages/en.json`, `hu.json`, `de.json`
- Test: `tests/components/reset-section.test.tsx` (new)

**Interfaces:**
- Consumes: `withOwnReset`, `patchOwnReset` (Task 2).
- Produces: `ResetSection` props gain `onOwnReset: (providerId: string, own: boolean) => void` and `onPatchOwnReset: (providerId: string, changes: Partial<Omit<DraftOwnReset, "source">>) => void`.

- [ ] **Step 1: Write the failing test** — `tests/components/reset-section.test.tsx`:

```tsx
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Draft } from "@/components/settings/draft";
import { ResetSection } from "@/components/settings/sections/reset-section";
import { renderWithIntl } from "../helpers/render";

function draftWith(overrides: Draft["resetOverrides"]): Draft {
  return {
    period: "weekly",
    useTokenLimits: false,
    providers: [
      { id: "claude", label: "Claude", models: [], visible: true, limitText: "1", savedLimit: 1, subLimits: [] },
      { id: "openai", label: "OpenAI", models: [], visible: true, limitText: "1", savedLimit: 1, subLimits: [] },
    ],
    weekday: 1,
    monthDay: 1,
    time: "00:00",
    timeZone: "Europe/Budapest",
    resetOverrides: overrides,
    showRemaining: true,
    groups: [],
    removed: [],
    newGroupName: "",
    apiToken: "",
    alerts: { webhookUrl: "", thresholds: [80], newThreshold: "", perProvider: false, format: "generic", locale: "en" },
  };
}

function renderSection(overrides: Draft["resetOverrides"]) {
  const handlers = { onPatch: vi.fn(), onOwnReset: vi.fn(), onPatchOwnReset: vi.fn() };
  renderWithIntl(<ResetSection titleId="s" draft={draftWith(overrides)} {...handlers} />);
  return handlers;
}

describe("ResetSection — per provider", () => {
  it("lists every provider, with its own reset or the shared one", () => {
    renderSection({ claude: { weekday: 4, monthDay: 1, time: "09:00", source: "report" } });
    expect(screen.getByRole("checkbox", { name: /Claude/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /OpenAI/ })).not.toBeChecked();
    expect(screen.getByText("Set by the menu bar app")).toBeInTheDocument();
    expect(screen.getByText("shared: Monday 00:00")).toBeInTheDocument();
  });

  it("switches a provider's own reset on and edits it", () => {
    const handlers = renderSection({ claude: { weekday: 4, monthDay: 1, time: "09:00" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /OpenAI/ }));
    expect(handlers.onOwnReset).toHaveBeenCalledWith("openai", true);
    fireEvent.change(screen.getByLabelText("Claude: time"), { target: { value: "10:30" } });
    expect(handlers.onPatchOwnReset).toHaveBeenCalledWith("claude", { time: "10:30" });
  });
});
```

(If `Draft` has fields this literal misses, the compiler says so: add them with neutral values.)

- [ ] **Step 2: Run it to see it fail** — `npx vitest run tests/components/reset-section.test.tsx`: FAIL.

- [ ] **Step 3: Implement**

Messages (`Settings` namespace):

| key | en | hu | de |
|---|---|---|---|
| `reset_per_provider_heading` | `Per provider` | `Szolgáltatónként` | `Pro Anbieter` |
| `reset_own` | `{label}: own reset` | `{label}: saját nullázás` | `{label}: eigene Rücksetzung` |
| `reset_own_short` | `own` | `saját` | `eigene` |
| `reset_shared_hint` | `shared: {when}` | `közös: {when}` | `gemeinsam: {when}` |
| `reset_own_day` | `{label}: day` | `{label}: nap` | `{label}: Tag` |
| `reset_own_time` | `{label}: time` | `{label}: idő` | `{label}: Uhrzeit` |
| `reset_set_by_report` | `Set by the menu bar app` | `A menüsáv-app állította be` | `Von der Menüleisten-App gesetzt` |

`reset-section.tsx`: add the two props, and after the `<p>{t("cycle_start_explanation", …)}</p>`, when `draft.providers.length > 0`:

```tsx
      <fieldset className="space-y-3">
        <legend className="text-sm text-ink-3">{t("reset_per_provider_heading")}</legend>
        {draft.providers.map((provider) => {
          const own = Object.hasOwn(draft.resetOverrides, provider.id) ? draft.resetOverrides[provider.id] : undefined;
          const when =
            draft.period === "weekly"
              ? `${weekdayLong(draft.weekday, locale)} ${draft.time}`
              : `${formatMonthDay(draft.monthDay, locale)} ${draft.time}`;
          return (
            <div key={provider.id} className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex w-40 items-center gap-2">
                <input
                  type="checkbox"
                  checked={own !== undefined}
                  onChange={(event) => onOwnReset(provider.id, event.target.checked)}
                  aria-label={t("reset_own", { label: provider.label })}
                />
                <span className="truncate">{provider.label}</span>
                <span className="text-sm text-ink-3">{t("reset_own_short")}</span>
              </label>
              {own ? (
                <>
                  {draft.period === "weekly" ? (
                    <select
                      aria-label={t("reset_own_day", { label: provider.label })}
                      value={own.weekday}
                      onChange={(event) => onPatchOwnReset(provider.id, { weekday: Number(event.target.value) })}
                      className={`w-40 ${FIELD}`}
                    >
                      {weekdayOrder(locale).map((weekday) => (
                        <option key={weekday} value={weekday}>
                          {weekdayLong(weekday, locale)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <select
                      aria-label={t("reset_own_day", { label: provider.label })}
                      value={own.monthDay}
                      onChange={(event) => onPatchOwnReset(provider.id, { monthDay: Number(event.target.value) })}
                      className={`w-40 tabular-nums ${FIELD}`}
                    >
                      {MONTH_DAYS.map((day) => (
                        <option key={day} value={day}>
                          {formatMonthDay(day, locale)}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    type="time"
                    step={60}
                    required
                    aria-label={t("reset_own_time", { label: provider.label })}
                    value={own.time}
                    onChange={(event) => onPatchOwnReset(provider.id, { time: event.target.value })}
                    className={`w-32 tabular-nums ${FIELD}`}
                  />
                  {own.source === "report" && (
                    <span className="basis-full text-sm text-ink-3 sm:pl-40">↳ {t("reset_set_by_report")}</span>
                  )}
                </>
              ) : (
                <span className="text-sm text-ink-3">{t("reset_shared_hint", { when })}</span>
              )}
            </div>
          );
        })}
      </fieldset>
```

(The checkbox's accessible name comes from `aria-label`, so the test's `getByRole("checkbox", { name: /Claude/ })` finds it; the visible label stays "Claude own". Adjust the `label` wrapper so the name is not doubled: an `aria-label` on the input wins over the wrapping label.)

`use-settings-form.ts`: add `ownReset: (providerId, own) => setDraft((d) => withOwnReset(d, providerId, own))` and `patchOwnReset: (providerId, changes) => setDraft((d) => patchOwnReset(d, providerId, changes))` to the returned `actions`, in the same style as the file's existing actions (look how `patch` is built and mirror it).

`settings-page.tsx:185`: `<ResetSection titleId={titleId} draft={draft} onPatch={actions.patch} onOwnReset={actions.ownReset} onPatchOwnReset={actions.patchOwnReset} />`.

- [ ] **Step 4: Run** `npx vitest run tests/components/reset-section.test.tsx` then `npm run check` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(settings): set each provider's own reset on the panel"`

---

### Task 4: past cycles follow the selected provider

**Files:**
- Modify: `lib/cycle-options.ts` (new `providerCycleOptions`)
- Modify: `app/[locale]/(dashboard)/page.tsx` (`loadDashboard`, `Page`)
- Modify: `components/dashboard.tsx`, `components/dashboard-view.tsx`, `components/archived-cycle-view.tsx` (a `pastCycle` prop)
- Test: `tests/cycle-options.test.ts`

**Interfaces:**
- Consumes: `resetFor` (lib/settings.ts), `providerCycle` (lib/provider-cycles.ts).
- Produces: `export function providerCycleOptions(input: { now: Date; config: AppConfig; providerId: string; history: { start: number; end: number }[]; oldestReportMs: number | null }): CycleOption[]` — `listCycleOptions` with the provider's reset and only its archive.

- [ ] **Step 1: Write the failing test** — append to `tests/cycle-options.test.ts`:

```ts
describe("providerCycleOptions", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const config = {
    ...getConfig(),
    reset: { period: "weekly" as const, weekday: 1, monthDay: 1, hour: 0, minute: 0, timeZone: "UTC" },
    resetOverrides: { claude: { weekday: 4, monthDay: 1, hour: 9, minute: 0 } },
    retentionDays: 30,
  };

  it("lists the provider's own cycles", () => {
    const options = providerCycleOptions({
      now,
      config,
      providerId: "claude",
      history: [],
      oldestReportMs: Date.parse("2026-09-01T00:00:00Z"),
    });
    expect(options[0]).toMatchObject({ kind: "current", startMs: Date.parse("2026-09-17T09:00:00Z") });
    expect(options[1]).toMatchObject({ kind: "detail", startMs: Date.parse("2026-09-10T09:00:00Z") });
  });

  it("uses the shared reset for a provider without its own", () => {
    const options = providerCycleOptions({ now, config, providerId: "openai", history: [], oldestReportMs: null });
    expect(options[0]!.startMs).toBe(Date.parse("2026-09-21T00:00:00Z"));
  });
});
```

(Import `getConfig` and `providerCycleOptions`.)

- [ ] **Step 2: Run it to see it fail** — `npx vitest run tests/cycle-options.test.ts`: FAIL.

- [ ] **Step 3: Implement**

`lib/cycle-options.ts` (import `type AppConfig` from `@/lib/config` and `resetFor` from `@/lib/settings`):

```ts
/** One provider's cycles: its own reset, its own archive. The dashboard offers the selected provider's. */
export function providerCycleOptions({
  now,
  config,
  providerId,
  history,
  oldestReportMs,
}: {
  now: Date;
  config: AppConfig;
  providerId: string;
  history: { start: number; end: number }[];
  oldestReportMs: number | null;
}): CycleOption[] {
  return listCycleOptions({
    now,
    reset: resetFor(config, providerId),
    archived: history,
    retentionDays: config.retentionDays,
    oldestReportMs,
  });
}
```

If importing `lib/settings.ts` from `lib/cycle-options.ts` creates an import cycle, pass `reset: ResetConfig` in instead of `config`/`providerId` and compute `resetFor` in the page.

`app/[locale]/(dashboard)/page.tsx`:
- `loadDashboard(requestedStartMs, cookieProviderId: string | undefined)`. After `config`:

```ts
  // The past cycles on offer are the selected provider's: its own reset, its own archive.
  const visible = visibleProviderIds(config, providerIds);
  const selectedId = cookieProviderId && visible.includes(cookieProviderId) ? cookieProviderId : visible[0];
  const own = selectedId ? providerCycle(now, config, selectedId) : null;
  const previousCycle = own?.previous ?? getPreviousCycle(getCycle(now, config.reset), config.reset);
```

  replacing today's `previousCycle` line;
- `options = selectedId ? providerCycleOptions({ now, config, providerId: selectedId, history: historyByProvider[selectedId] ?? [], oldestReportMs }) : listCycleOptions({ …as today… })`;
- the detail window's fallback previous: `getPreviousCycle(asCycle(selected), selectedId ? resetFor(config, selectedId) : config.reset)`;
- `Page`: read the cookie before `loadDashboard` and pass it in (`const selectedProviderId = (await cookies()).get(PROVIDER_COOKIE)?.value;` moves up; the later use stays).

`components/dashboard.tsx`: pass `pastCycle={selected.kind !== "current"}` to `DashboardView` and `ArchivedCycleView`.

`components/dashboard-view.tsx` `DashboardView` and `components/archived-cycle-view.tsx` `ArchivedCycleView`: a `pastCycle: boolean` prop; `const router = useRouter();` (from `@/i18n/routing`); in `selectProvider`:

```ts
    writeProviderCookie(providerId);
    // A past cycle is the selected provider's own: another provider's would be a different week.
    if (pastCycle) router.push("/");
    else setSelectedId(providerId);
```

(dependencies `[pastCycle, router]`).

- [ ] **Step 4: Run** `npm run check` — PASS; then `npm run build && npm run e2e` — PASS (demo mode has no override: the dashboard behaves as before). Delete `.next/types` afterwards if `tsc` then complains.
- [ ] **Step 5: Commit** — `git commit -m "feat(dashboard): offer the selected provider's own past cycles"`

---

### Task 5: try it like the user

- [ ] **Step 1:** Start a local server with a real store (not demo mode, which refuses writes), following the repo's dev docs: `npm run redis:up`, then `npx next dev -p 3170` with `USAGE_API_TOKEN`, a 5-digit `DASHBOARD_PIN`, `KV_REST_API_URL=http://localhost:8079`, `KV_REST_API_TOKEN=local_dev_token` set inline (no `.env.local`). Seed two providers with `POST /api/usage` (Bearer `USAGE_API_TOKEN`) reports spread over two weeks for `claude` and `openai`.
- [ ] **Step 2:** With Playwright (`require("<repo>/node_modules/@playwright/test").chromium`, headless), log in through the PIN form and:
  1. Settings → reset section: turn Claude's own reset on, set Thursday 09:00, save, reload — the row is still on with Thursday 09:00; OpenAI shows "shared: Monday 00:00". Screenshot the section in hu and en (`/hu/settings`, `/en/settings`) at desktop and 390 px width.
  2. Dashboard with Claude selected: the history list's past cycles start on Thursdays 09:00; open one (`?cycle=`), the cycle bar shows a Thursday–Thursday range; switch to OpenAI — it lands on the current cycle (`/`).
  3. Write `resetOverrides.claude.source = "report"` straight into the stored settings (`PUT /api/settings` with the session cookie, or the Redis document) and check the "Set by the menu bar app" / "A menüsáv-app állította be" note; change the time on the panel and save — the note is gone after reload.
- [ ] **Step 3:** Look at every screenshot (layout on 390 px: no overflow, the note under the row). Fix what is off in a follow-up commit (`fix(settings): …`), re-run `npm run check`.
- [ ] **Step 4:** Stop the dev server and `npm run redis:down`. No push, no PR.

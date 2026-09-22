"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { ApiTokenSettings } from "@/components/api-token-settings";
import { PlusIcon, SlidersIcon, StopCircleIcon, XIcon } from "@/components/icons";
import type { BudgetPeriod } from "@/lib/config";
import { formatTokens, weekdayLong } from "@/lib/format";
import {
  MAX_GROUPS,
  MAX_LIMIT,
  normalizeHexColor,
  PRESET_COLORS,
  suggestGroupColor,
  type SettingsView,
} from "@/lib/settings";
import { parseId } from "@/lib/validation";

interface DraftGroup {
  id: string;
  /** The last valid colour: what is shown and saved. */
  color: string;
  /** The HEX field exactly as typed; may be half-written. */
  colorText: string;
  hasReports: boolean;
}

interface DraftLimit {
  id: string;
  label: string;
  value: string;
  /** The stored limit: saved again while the limits are off and the field holds no valid number. */
  saved: number;
}

/** The form's state: strings as typed, validated only when saving. */
interface Draft {
  period: BudgetPeriod;
  useTokenLimits: boolean;
  limits: DraftLimit[];
  weekday: number;
  monthDay: number;
  time: string;
  showRemaining: boolean;
  groups: DraftGroup[];
  /** Taken off the list in this session; kept whole so a refused removal can be put back. */
  removed: DraftGroup[];
  newGroupName: string;
  /** The API-token field: saved by its own button, never with the rest. */
  apiToken: string;
}

interface SettingsRequest {
  period: BudgetPeriod;
  useTokenLimits: boolean;
  limits: Record<string, number>;
  reset: { weekday: number; monthDay: number; hour: number; minute: number };
  showRemaining: boolean;
  groups: { id: string; color: string }[];
  removedGroups: string[];
}

// Monday first, as the week goes in Hungary.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => index + 1);

const FIELD =
  "rounded-md border border-rule bg-page px-3 py-2 text-ink placeholder:text-ink-3 disabled:opacity-50";
const QUIET_BUTTON =
  "rounded-md border border-rule px-3 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40";

function draftFrom(view: SettingsView): Draft {
  const { period, useTokenLimits, limits, reset, showRemaining } = view.settings;
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  return {
    period,
    useTokenLimits,
    limits: view.providers.map((provider) => ({
      ...provider,
      value: String(limits[provider.id]),
      saved: limits[provider.id]!,
    })),
    weekday: reset.weekday,
    monthDay: reset.monthDay,
    time: `${twoDigits(reset.hour)}:${twoDigits(reset.minute)}`,
    showRemaining,
    groups: view.groups.map((group) => ({ ...group, colorText: group.color })),
    removed: [],
    newGroupName: "",
    apiToken: "",
  };
}

/** "500 000" → 500000; null unless a positive integer within bounds. */
function parseLimit(text: string): number | null {
  const digits = text.replace(/[\s_.,]/g, "");
  if (!/^\d{1,13}$/.test(digits)) return null;
  const limit = Number(digits);
  return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

/** Why `name` cannot be added as a group; null when it can. */
function groupNameProblem(name: string, groups: DraftGroup[]): string | null {
  const errors: string[] = [];
  const id = parseId(name, "id", errors);
  if (errors.length > 0) {
    return (
      "A csoportnév 1–64 karakter lehet: betű, szám, szóköz, pont, kötőjel és aláhúzás, " +
      "az elején betűvel vagy számmal."
    );
  }
  if (groups.some((group) => group.id === id)) return `Már van „${id}” nevű csoport.`;
  if (groups.length >= MAX_GROUPS) return `Legfeljebb ${MAX_GROUPS} csoport vehető fel.`;
  return null;
}

/** The draft with the name in the "new group" field added to the list. */
function withNewGroup(draft: Draft): Draft {
  const id = draft.newGroupName.trim();
  const restored = draft.removed.find((group) => group.id === id);
  const color = restored?.color ?? suggestGroupColor(draft.groups.map((group) => group.color));
  return {
    ...draft,
    groups: [
      ...draft.groups,
      { id, color, colorText: color, hasReports: restored?.hasReports ?? false },
    ],
    removed: draft.removed.filter((group) => group.id !== id),
    newGroupName: "",
  };
}

function toRequest(draft: Draft): { request: SettingsRequest } | { problem: string } {
  const parsedLimits = draft.limits.map((limit) => ({
    ...limit,
    // Hidden while the limits are off: a half-typed value left there must not block the save.
    parsed: parseLimit(limit.value) ?? (draft.useTokenLimits ? null : limit.saved),
  }));
  const badLimit = parsedLimits.find((limit) => limit.parsed === null);
  if (badLimit) {
    return {
      problem: `A(z) ${badLimit.label} kerete pozitív egész szám legyen, például 500 000.`,
    };
  }

  const time = /^([01]\d|2[0-3]):([0-5]\d)/.exec(draft.time);
  if (!time) return { problem: "Add meg a reset időpontját óra:perc formában, például 00:00." };

  const invalid = draft.groups.find((group) => normalizeHexColor(group.colorText) === null);
  if (invalid) {
    return { problem: `A(z) „${invalid.id}” csoport színe nem érvényes HEX kód (ilyen például a #3987e5).` };
  }

  return {
    request: {
      period: draft.period,
      useTokenLimits: draft.useTokenLimits,
      limits: Object.fromEntries(parsedLimits.map((limit) => [limit.id, limit.parsed as number])),
      reset: {
        weekday: draft.weekday,
        monthDay: draft.monthDay,
        hour: Number(time[1]),
        minute: Number(time[2]),
      },
      showRemaining: draft.showRemaining,
      groups: draft.groups.map(({ id, color }) => ({ id, color })),
      removedGroups: draft.removed.map((group) => group.id),
    },
  };
}

function SettingsForm({ view, titleId, onClose }: { view: SettingsView; titleId: string; onClose: () => void }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(view));
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const presetsId = useId();

  const patch = (changes: Partial<Draft>) => setDraft((current) => ({ ...current, ...changes }));
  const patchGroup = (id: string, changes: Partial<DraftGroup>) =>
    setDraft((current) => ({
      ...current,
      groups: current.groups.map((group) => (group.id === id ? { ...group, ...changes } : group)),
    }));
  const patchLimit = (id: string, value: string) =>
    setDraft((current) => ({
      ...current,
      limits: current.limits.map((limit) => (limit.id === id ? { ...limit, value } : limit)),
    }));

  function addGroup() {
    const nameProblem = groupNameProblem(draft.newGroupName, draft.groups);
    setProblem(nameProblem);
    if (!nameProblem) setDraft(withNewGroup);
  }

  function removeGroup(group: DraftGroup) {
    setDraft((current) => ({
      ...current,
      groups: current.groups.filter((other) => other.id !== group.id),
      // A group that was only ever in this draft has nothing to remove on the server.
      removed: view.groups.some((saved) => saved.id === group.id)
        ? [...current.removed, group]
        : current.removed,
    }));
  }

  async function save() {
    // The token has its own save, with its own confirmation: typed but not saved, it would be lost.
    if (draft.apiToken.trim() !== "") {
      return setProblem(
        "Az API-token mezőjében mentetlen érték van: mentsd a mellette lévő gombbal, vagy ürítsd ki a mezőt.",
      );
    }

    // A name left in the field was meant to be added: do not lose it silently.
    let pending = draft;
    if (draft.newGroupName.trim() !== "") {
      const nameProblem = groupNameProblem(draft.newGroupName, draft.groups);
      if (nameProblem) return setProblem(nameProblem);
      pending = withNewGroup(draft);
      setDraft(pending);
    }

    const result = toRequest(pending);
    if ("problem" in result) return setProblem(result.problem);

    setSaving(true);
    setProblem(null);
    try {
      const response = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.request),
      });
      if (response.ok) {
        router.refresh();
        onClose();
        return;
      }

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.status === 401) {
        setProblem("A munkamenet lejárt. Lépj be újra a PIN-kóddal, utána ments újra.");
        router.refresh();
      } else if (response.status === 409 && Array.isArray(payload?.groups)) {
        const refused = payload.groups.map(String);
        setDraft((current) => ({
          ...current,
          groups: [
            ...current.groups,
            ...current.removed
              .filter((group) => refused.includes(group.id))
              .map((group) => ({ ...group, hasReports: true })),
          ],
          removed: current.removed.filter((group) => !refused.includes(group.id)),
        }));
        setProblem(
          `Időközben jelentés érkezett ide: ${refused.join(", ")}. Az ilyen csoport nem törölhető, ` +
            "ezért visszakerült a listára. Semmi nem lett elmentve: ments újra.",
        );
      } else if (response.status === 400 && Array.isArray(payload?.details)) {
        setProblem(`A szerver elutasította a beállításokat: ${payload.details.join("; ")}.`);
      } else {
        setProblem("A mentés nem sikerült, az adattár most nem érhető el. Próbáld újra kicsit később.");
      }
    } catch {
      setProblem("A mentés nem sikerült: a szerver nem válaszolt. Ellenőrizd a kapcsolatot, és próbáld újra.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header className="flex items-center justify-between gap-4 px-6 pt-5">
        <h2 id={titleId} className="text-xl font-medium">
          Beállítások
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Bezárás"
          className="-mr-2 rounded-md p-2 text-ink-3 transition-colors hover:text-ink"
        >
          <XIcon />
        </button>
      </header>

      <div className="space-y-9 px-6 pb-7 pt-6">
        <section aria-labelledby={`${titleId}-budget`} className="space-y-4">
          <h3 id={`${titleId}-budget`} className="font-medium">
            Keret
          </h3>

          <fieldset>
            <legend className="text-sm text-ink-3">Típus</legend>
            <div className="mt-1.5 inline-flex rounded-md border border-rule p-0.5">
              {(["weekly", "monthly"] as const).map((period) => (
                <label
                  key={period}
                  className="cursor-pointer rounded-[5px] px-5 py-1.5 text-ink-2 transition-colors has-[:checked]:bg-ink has-[:checked]:text-page has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink"
                >
                  <input
                    type="radio"
                    name="period"
                    value={period}
                    checked={draft.period === period}
                    onChange={() => patch({ period })}
                    className="sr-only"
                  />
                  {period === "weekly" ? "Heti" : "Havi"}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              checked={draft.useTokenLimits}
              onChange={(event) => patch({ useTokenLimits: event.target.checked })}
              className="mt-1 size-4 shrink-0 cursor-pointer accent-ink"
            />
            <span>
              Tokenkeret használata
              <span className="mt-0.5 block text-sm text-ink-3">
                Kikapcsolva a dashboard csak a gépek mért tokenjeiből és a beírt hivatalos százalékból számol: a
                százalék a mért arányok szerint oszlik meg a csoportok és a gépek között. Bekapcsolva egy
                szolgáltatónként megadott tokenkerethez is viszonyít, és kiírhatja a maradék tokeneket.
              </span>
            </span>
          </label>

          {/* Hidden while off, yet kept in the draft: switching back on restores the limits as they were. */}
          {draft.useTokenLimits && (
            <div className="space-y-4 border-l border-hairline pl-4 sm:pl-7">
              <fieldset>
                <legend className="text-sm text-ink-3">Szolgáltatónkénti keret (token)</legend>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {draft.limits.map((provider) => {
                    const limit = parseLimit(provider.value);
                    return (
                      <label key={provider.id} className="rounded-lg border border-hairline bg-page/40 p-3">
                        <span className="font-medium text-ink">{provider.label}</span>
                        <span className="mt-2 flex items-center gap-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            value={provider.value}
                            onChange={(event) => patchLimit(provider.id, event.target.value)}
                            aria-invalid={limit === null || undefined}
                            aria-label={`${provider.label} tokenkerete`}
                            className={`min-w-0 grow tabular-nums ${FIELD}`}
                          />
                        </span>
                        <span className="mt-1.5 block text-sm text-ink-3">
                          {limit === null
                            ? "Pozitív egész szám."
                            : `${formatTokens(limit)} token ${draft.period === "weekly" ? "hetente" : "havonta"}.`}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={draft.showRemaining}
                  onChange={(event) => patch({ showRemaining: event.target.checked })}
                  className="mt-1 size-4 shrink-0 cursor-pointer accent-ink"
                />
                <span>
                  Maradék tokenek mutatása
                  <span className="mt-0.5 block text-sm text-ink-3">
                    Kikapcsolva a dashboard sehol nem írja ki, mennyi token maradt a keretből, és a túllépés
                    mértékét sem. A százalék, az elfogyott mennyiség és a reset ideje megmarad.
                  </span>
                </span>
              </label>
            </div>
          )}
        </section>

        <section aria-labelledby={`${titleId}-reset`} className="space-y-4">
          <h3 id={`${titleId}-reset`} className="font-medium">
            Reset
          </h3>

          <div className="flex flex-wrap gap-x-5 gap-y-4">
            {draft.period === "weekly" ? (
              <label className="block">
                <span className="text-sm text-ink-3">A hét napja</span>
                <select
                  value={draft.weekday}
                  onChange={(event) => patch({ weekday: Number(event.target.value) })}
                  className={`mt-1.5 block w-40 ${FIELD}`}
                >
                  {WEEKDAY_ORDER.map((weekday) => (
                    <option key={weekday} value={weekday}>
                      {weekdayLong(weekday)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="block">
                <span className="text-sm text-ink-3">A hónap napja</span>
                <select
                  value={draft.monthDay}
                  onChange={(event) => patch({ monthDay: Number(event.target.value) })}
                  className={`mt-1.5 block w-40 tabular-nums ${FIELD}`}
                >
                  {MONTH_DAYS.map((day) => (
                    <option key={day} value={day}>
                      {day}.
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="block">
              <span className="text-sm text-ink-3">Időpont</span>
              <input
                type="time"
                step={60}
                required
                value={draft.time}
                onChange={(event) => patch({ time: event.target.value })}
                className={`mt-1.5 block w-32 tabular-nums ${FIELD}`}
              />
            </label>
          </div>

          <p className="text-sm text-ink-3">
            Ekkor indul az új számlálási ciklus, {view.timeZone} idő szerint.
            {draft.period === "monthly" && draft.monthDay > 28 && (
              <> Ha egy hónapban nincs {draft.monthDay}. nap, a hónap utolsó napja számít.</>
            )}
          </p>
        </section>

        <section aria-labelledby={`${titleId}-groups`}>
          <h3 id={`${titleId}-groups`} className="font-medium">
            Csoportok
          </h3>

          {draft.groups.length > 0 && (
            <ul className="mt-3 border-t border-hairline">
              {draft.groups.map((group) => (
                <li key={group.id} className="flex items-center gap-3 border-b border-hairline py-2.5">
                  <input
                    type="color"
                    list={presetsId}
                    value={group.color}
                    onChange={(event) =>
                      patchGroup(group.id, { color: event.target.value, colorText: event.target.value })
                    }
                    aria-label={`„${group.id}” színe`}
                    className="color-well"
                  />
                  <span className="min-w-0 grow wrap-anywhere">{group.id}</span>
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={7}
                    value={group.colorText}
                    onChange={(event) => {
                      const color = normalizeHexColor(event.target.value);
                      patchGroup(group.id, { colorText: event.target.value, ...(color && { color }) });
                    }}
                    onBlur={() => patchGroup(group.id, { colorText: group.color })}
                    aria-label={`„${group.id}” színének HEX kódja`}
                    aria-invalid={normalizeHexColor(group.colorText) === null || undefined}
                    className={`w-[6.5rem] font-mono text-sm ${FIELD}`}
                  />
                  <button
                    type="button"
                    onClick={() => removeGroup(group)}
                    disabled={group.hasReports}
                    aria-label={`„${group.id}” törlése`}
                    title={group.hasReports ? "Van tárolt jelentése, ezért nem törölhető" : "Törlés"}
                    className="rounded-md p-2 text-ink-3 transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-30"
                  >
                    <XIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <datalist id={presetsId}>
            {PRESET_COLORS.map((color) => (
              <option key={color} value={color} />
            ))}
          </datalist>

          <div className="mt-4 flex gap-3">
            <input
              type="text"
              autoComplete="off"
              maxLength={64}
              placeholder="Új csoport neve, például Work"
              value={draft.newGroupName}
              onChange={(event) => patch({ newGroupName: event.target.value })}
              onKeyDown={(event) => {
                // Enter adds the group; it must not submit the whole form.
                if (event.key !== "Enter") return;
                event.preventDefault();
                addGroup();
              }}
              aria-label="Új csoport neve"
              className={`min-w-0 grow ${FIELD}`}
            />
            <button type="button" onClick={addGroup} className={`flex shrink-0 items-center gap-2 ${QUIET_BUTTON}`}>
              <PlusIcon />
              Hozzáadás
            </button>
          </div>

          <p className="mt-4 text-sm text-ink-3">
            A név az, amit a gép <code className="text-ink-2">groupId</code>-ként küld. Ha egy gép a listán nem
            szereplő csoportot jelent, az magától felkerül ide, véletlen színnel. Törölni csak olyan csoportot
            lehet, amelynek nincs tárolt jelentése.
          </p>
        </section>

        <ApiTokenSettings
          headingId={`${titleId}-token`}
          value={draft.apiToken}
          onChange={(apiToken) => patch({ apiToken })}
          timeZone={view.timeZone}
        />
      </div>

      <footer className="sticky bottom-0 border-t border-hairline bg-raised px-6 py-4">
        {problem && (
          <p role="alert" className="mb-4 flex items-start gap-2.5 text-sm text-ink">
            <StopCircleIcon className="mt-0.5 shrink-0 text-critical" />
            <span>{problem}</span>
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className={QUIET_BUTTON}>
            Mégse
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-ink px-5 py-1.5 font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {saving ? "Mentés…" : "Mentés"}
          </button>
        </div>
      </footer>
    </form>
  );
}

/**
 * The header's settings button and the modal it opens. The form only exists
 * while the dialog is open, so every opening starts from the freshly rendered
 * settings, and a background refresh never overwrites what is being typed.
 */
export function SettingsDialog({ view }: { view: SettingsView }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const titleId = useId();

  // Opened after the form has rendered, so the browser finds its first control to focus.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) dialog.showModal();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className="flex items-center gap-2 rounded-md border border-rule px-2.5 py-1.5 text-ink-2 transition-colors hover:border-ink-3 hover:text-ink sm:px-3"
      >
        <SlidersIcon />
        <span className="sr-only sm:not-sr-only">Beállítások</span>
      </button>

      <dialog
        ref={dialogRef}
        // The token section's own dialogs sit inside this one, and React bubbles their close events here.
        onClose={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        aria-labelledby={titleId}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-rule bg-raised text-base text-ink shadow-2xl backdrop:bg-black/60"
      >
        {open && <SettingsForm view={view} titleId={titleId} onClose={() => dialogRef.current?.close()} />}
      </dialog>
    </>
  );
}

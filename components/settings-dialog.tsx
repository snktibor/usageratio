"use client";

import { useRouter } from "@/i18n/routing";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { ApiTokenSettings } from "@/components/api-token-settings";
import { CheckIcon, PlusIcon, SlidersIcon, StopCircleIcon, XIcon } from "@/components/icons";
import type { BudgetPeriod } from "@/lib/config";
import { formatTokens, weekdayLong } from "@/lib/format";
import { modelLabel } from "@/lib/models";
import {
  MAX_GROUPS,
  MAX_LIMIT,
  normalizeHexColor,
  PRESET_COLORS,
  suggestGroupColor,
  type SettingsView,
} from "@/lib/settings";
import {
  MAX_SUB_LIMIT_MODELS,
  MAX_SUB_LIMIT_NAME_LENGTH,
  MAX_SUB_LIMITS,
  normalizeModelPart,
  normalizeSubLimitName,
  subLimitIdFor,
  type SubLimit,
  type SubLimitMode,
} from "@/lib/sub-limits";
import { parseId } from "@/lib/validation";

interface DraftGroup {
  id: string;
  /** The last valid colour: what is shown and saved. */
  color: string;
  /** The HEX field exactly as typed; may be half-written. */
  colorText: string;
  hasReports: boolean;
  /** The providers whose usage in this group does not count. */
  excluded: string[];
}

interface DraftSubLimit {
  /** Null until it is first saved: then it gets one from its name, and keeps it through renames. */
  id: string | null;
  /** Keys its row: the id may not exist yet. */
  key: string;
  name: string;
  /** The model-id parts, comma-separated, as typed. */
  modelsText: string;
  mode: SubLimitMode;
  shareText: string;
  limitText: string;
  /** Saved again while their fields are hidden and hold no valid number. */
  savedShare: number;
  savedLimit: number;
}

interface DraftProvider {
  id: string;
  label: string;
  /** This cycle's model ids (without their dates), to match a sub-limit's parts against. */
  models: string[];
  /** False: hidden from the dashboard. */
  visible: boolean;
  /** The token-limit field exactly as typed. */
  limitText: string;
  /** The stored limit: saved again while its field is hidden and holds no valid number. */
  savedLimit: number;
  subLimits: DraftSubLimit[];
}

/** The form's state: strings as typed, validated only when saving. */
interface Draft {
  period: BudgetPeriod;
  useTokenLimits: boolean;
  providers: DraftProvider[];
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
  hiddenProviders: string[];
  excludedProviders: Record<string, string[]>;
  subLimits: Record<string, SubLimit[]>;
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

/** A pill that switches something on (filled, with a tick) or off (outlined). */
function ToggleChip({
  checked,
  onChange,
  disabled = false,
  title,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <label title={title} className="relative">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span className="flex cursor-pointer items-center gap-1.5 rounded-full border border-rule px-3 py-1 text-sm text-ink-3 transition-colors hover:border-ink-3 hover:text-ink peer-checked:border-ink peer-checked:bg-ink peer-checked:text-page peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink peer-disabled:cursor-not-allowed peer-disabled:hover:border-ink">
        {checked && <CheckIcon className="-ml-0.5 size-3.5 shrink-0" />}
        {children}
      </span>
    </label>
  );
}

function draftFrom(view: SettingsView): Draft {
  const { period, useTokenLimits, limits, reset, showRemaining, hiddenProviders, excludedProviders, subLimits } =
    view.settings;
  const twoDigits = (value: number) => String(value).padStart(2, "0");
  return {
    period,
    useTokenLimits,
    providers: view.providers.map((provider) => ({
      ...provider,
      visible: !hiddenProviders.includes(provider.id),
      limitText: String(limits[provider.id]),
      savedLimit: limits[provider.id]!,
      subLimits: (Object.hasOwn(subLimits, provider.id) ? subLimits[provider.id]! : []).map((sub) => ({
        id: sub.id,
        key: sub.id,
        name: sub.name,
        modelsText: sub.models.join(", "),
        mode: sub.mode,
        shareText: String(sub.sharePercent),
        limitText: String(sub.limit),
        savedShare: sub.sharePercent,
        savedLimit: sub.limit,
      })),
    })),
    weekday: reset.weekday,
    monthDay: reset.monthDay,
    time: `${twoDigits(reset.hour)}:${twoDigits(reset.minute)}`,
    showRemaining,
    groups: view.groups.map((group) => ({
      ...group,
      colorText: group.color,
      // A group id such as "constructor" must not find the object's prototype.
      excluded: Object.hasOwn(excludedProviders, group.id) ? [...excludedProviders[group.id]!] : [],
    })),
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

/** "30", "30 %" → 30; null unless a whole percentage from 1 to 100. */
function parseSharePercent(text: string): number | null {
  const digits = text.trim().replace(/\s*%$/, "");
  if (!/^\d{1,3}$/.test(digits)) return null;
  const percent = Number(digits);
  return percent >= 1 && percent <= 100 ? percent : null;
}

/** "fable, Opus-5" → ["fable", "opus-5"]; null when a part is no valid one, or there are none. */
function parseModelParts(text: string): string[] | null {
  const parts: string[] = [];
  for (const raw of text.split(/[,;\s]+/).filter(Boolean)) {
    const part = normalizeModelPart(raw);
    if (!part) return null;
    if (!parts.includes(part)) parts.push(part);
  }
  return parts.length >= 1 && parts.length <= MAX_SUB_LIMIT_MODELS ? parts : null;
}

/** A provider's sub-limits as the PUT body wants them, or what is wrong with one. */
function subLimitsRequest(provider: DraftProvider, useTokenLimits: boolean): { list: SubLimit[] } | { problem: string } {
  const list: SubLimit[] = [];
  for (const draft of provider.subLimits) {
    const name = normalizeSubLimitName(draft.name);
    if (name === null) {
      return {
        problem: `A(z) ${provider.label} egyik alkeretének adj nevet (legfeljebb ${MAX_SUB_LIMIT_NAME_LENGTH} karakter).`,
      };
    }
    if (list.some((other) => other.name.toLowerCase() === name.toLowerCase())) {
      return { problem: `A(z) ${provider.label} két alkeretének ugyanaz a neve: „${name}”.` };
    }
    const models = parseModelParts(draft.modelsText);
    if (models === null) {
      return {
        problem:
          `A(z) „${name}” alkeret modelljei: a modellazonosítók egy-egy része (betű, szám, pont, kötőjel), ` +
          `vesszővel elválasztva, legfeljebb ${MAX_SUB_LIMIT_MODELS}, például fable.`,
      };
    }
    // Hidden fields must not block the save: they keep what was saved.
    const share = parseSharePercent(draft.shareText) ?? (draft.mode === "share" ? null : draft.savedShare);
    if (share === null) return { problem: `A(z) „${name}” alkeret aránya 1 és 100 közötti egész szám legyen.` };
    const limit =
      parseLimit(draft.limitText) ?? (draft.mode === "separate" && useTokenLimits ? null : draft.savedLimit);
    if (limit === null) return { problem: `A(z) „${name}” alkeret tokenkerete pozitív egész szám legyen.` };

    const taken = [...provider.subLimits.flatMap((other) => (other.id ? [other.id] : [])), ...list.map((sub) => sub.id)];
    list.push({ id: draft.id ?? subLimitIdFor(name, taken), name, models, mode: draft.mode, sharePercent: share, limit });
  }
  return { list };
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
      {
        id,
        color,
        colorText: color,
        hasReports: restored?.hasReports ?? false,
        excluded: restored?.excluded ?? [],
      },
    ],
    removed: draft.removed.filter((group) => group.id !== id),
    newGroupName: "",
  };
}

function toRequest(draft: Draft): { request: SettingsRequest } | { problem: string } {
  if (!draft.providers.some((provider) => provider.visible)) {
    return { problem: "Legalább egy AI-fióknak látszania kell a dashboardon." };
  }

  const parsedLimits = draft.providers.map((provider) => ({
    ...provider,
    // Hidden while the limits or the provider are off: a half-typed value left there must not block the save.
    parsed: parseLimit(provider.limitText) ?? (draft.useTokenLimits && provider.visible ? null : provider.savedLimit),
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

  const subLimits: Record<string, SubLimit[]> = {};
  for (const provider of draft.providers) {
    const result = subLimitsRequest(provider, draft.useTokenLimits);
    if ("problem" in result) return result;
    if (result.list.length > 0) subLimits[provider.id] = result.list;
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
      hiddenProviders: draft.providers.filter((provider) => !provider.visible).map((provider) => provider.id),
      // Only the groups on the list: a removed group takes its exclusions with it.
      excludedProviders: Object.fromEntries(
        draft.groups.filter((group) => group.excluded.length > 0).map((group) => [group.id, group.excluded]),
      ),
      subLimits,
      groups: draft.groups.map(({ id, color }) => ({ id, color })),
      removedGroups: draft.removed.map((group) => group.id),
    },
  };
}

/** Which of the provider's models this cycle a sub-limit takes, as its parts are typed. */
function matchNote(sub: DraftSubLimit, provider: DraftProvider): string {
  const parts = parseModelParts(sub.modelsText);
  if (parts === null) {
    const known = provider.models.slice(0, 6).join(", ");
    return known === "" ? "A modellazonosító része, vesszővel több is." : `A modellazonosító része, például: ${known}.`;
  }
  // A model an earlier sub-limit takes stays there: the first match wins (lib/sub-limits.ts).
  const earlier = provider.subLimits
    .slice(0, provider.subLimits.indexOf(sub))
    .flatMap((other) => parseModelParts(other.modelsText) ?? []);
  const takes = (model: string, list: string[]) => list.some((part) => model.includes(part));
  const matches = provider.models.filter((model) => takes(model, parts) && !takes(model, earlier));
  if (matches.length === 0) return "Ebben a ciklusban még nem jelentett egyező modellt egy gép sem.";
  return `Egyező modellek: ${matches.map(modelLabel).join(", ")}.`;
}

function SubLimitEditor({
  sub,
  provider,
  useTokenLimits,
  onChange,
  onRemove,
}: {
  sub: DraftSubLimit;
  provider: DraftProvider;
  useTokenLimits: boolean;
  onChange: (changes: Partial<DraftSubLimit>) => void;
  onRemove: () => void;
}) {
  const t = useTranslations("Settings");
  const modeName = useId();
  const label = sub.name.trim() || "Új alkeret";
  const share = parseSharePercent(sub.shareText);
  const limit = parseLimit(sub.limitText);

  return (
    <li className="rounded-lg border border-hairline bg-page/40 p-3">
      <div className="flex items-center gap-2">
        <input
          type="text"
          autoComplete="off"
          maxLength={MAX_SUB_LIMIT_NAME_LENGTH}
          placeholder="Neve, például Fable"
          value={sub.name}
          onChange={(event) => onChange({ name: event.target.value })}
          aria-label={`${provider.label} alkeretének neve`}
          className={`min-w-0 grow font-medium ${FIELD}`}
        />
        <button
          type="button"
          onClick={onRemove}
          aria-label={`„${label}” alkeret törlése`}
          title={t("delete")}
          className="rounded-md p-2 text-ink-3 transition-colors hover:text-ink"
        >
          <XIcon />
        </button>
      </div>

      <label className="mt-3 block">
        <span className="text-sm text-ink-3">Modellek</span>
        <input
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="fable"
          value={sub.modelsText}
          onChange={(event) => onChange({ modelsText: event.target.value })}
          className={`mt-1 block w-full font-mono text-sm ${FIELD}`}
        />
        <span className="mt-1 block text-sm text-ink-3">{matchNote(sub, provider)}</span>
      </label>

      <fieldset className="mt-3">
        <legend className="sr-only">„{label}” fajtája</legend>
        <div className="inline-flex flex-wrap rounded-md border border-rule p-0.5">
          {(["separate", "share"] as const).map((mode) => (
            <label
              key={mode}
              className="cursor-pointer rounded-[5px] px-3 py-1 text-sm text-ink-2 transition-colors has-[:checked]:bg-ink has-[:checked]:text-page has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink"
            >
              <input
                type="radio"
                name={modeName}
                value={mode}
                checked={sub.mode === mode}
                onChange={() => onChange({ mode })}
                className="sr-only"
              />
              {mode === "separate" ? "Önálló keret" : "A keret része"}
            </label>
          ))}
        </div>
      </fieldset>

      {sub.mode === "share" ? (
        <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-3">
          Legfeljebb
          <span className="relative">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              maxLength={4}
              value={sub.shareText}
              onChange={(event) => onChange({ shareText: event.target.value })}
              aria-invalid={share === null || undefined}
              className={`w-20 pr-7 text-base tabular-nums ${FIELD}`}
            />
            <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
              %
            </span>
          </span>
          a(z) {provider.label} keretéből
        </label>
      ) : (
        <>
          {useTokenLimits && (
            <label className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-3">
              Tokenkeret
              <input
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={sub.limitText}
                onChange={(event) => onChange({ limitText: event.target.value })}
                aria-invalid={limit === null || undefined}
                className={`w-36 text-base tabular-nums ${FIELD}`}
              />
              {limit !== null && <span>{formatTokens(limit)} token</span>}
            </label>
          )}
          <p className="mt-2 text-sm text-ink-3">A modelljei nem számítanak bele a(z) {provider.label} keretébe.</p>
        </>
      )}
    </li>
  );
}

function SettingsForm({ view, titleId, onClose }: { view: SettingsView; titleId: string; onClose: () => void }) {
  const t = useTranslations("Settings");
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
  const patchProvider = (id: string, changes: Partial<DraftProvider>) =>
    setDraft((current) => ({
      ...current,
      providers: current.providers.map((provider) => (provider.id === id ? { ...provider, ...changes } : provider)),
    }));
  const setCounted = (groupId: string, providerId: string, counted: boolean) =>
    setDraft((current) => ({
      ...current,
      groups: current.groups.map((group) =>
        group.id === groupId
          ? {
              ...group,
              excluded: counted
                ? group.excluded.filter((id) => id !== providerId)
                : [...group.excluded.filter((id) => id !== providerId), providerId],
            }
          : group,
      ),
    }));
  const visibleProviders = draft.providers.filter((provider) => provider.visible);

  const newSubLimitKey = useRef(0);
  const patchSubLimits = (providerId: string, change: (list: DraftSubLimit[]) => DraftSubLimit[]) =>
    setDraft((current) => ({
      ...current,
      providers: current.providers.map((provider) =>
        provider.id === providerId ? { ...provider, subLimits: change(provider.subLimits) } : provider,
      ),
    }));
  const patchSubLimit = (providerId: string, key: string, changes: Partial<DraftSubLimit>) =>
    patchSubLimits(providerId, (list) => list.map((sub) => (sub.key === key ? { ...sub, ...changes } : sub)));
  const addSubLimit = (provider: DraftProvider) =>
    patchSubLimits(provider.id, (list) => [
      ...list,
      {
        id: null,
        key: `new-${(newSubLimitKey.current += 1)}`,
        name: "",
        modelsText: "",
        mode: "separate",
        shareText: "50",
        limitText: provider.limitText,
        savedShare: 50,
        savedLimit: parseLimit(provider.limitText) ?? provider.savedLimit,
      },
    ]);

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
        <h2 id={titleId} className="text-xl font-medium">{t("settings_title")}</h2>
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
        <section aria-labelledby={`${titleId}-providers`}>
          <h3 id={`${titleId}-providers`} className="font-medium">
            AI-fiókok
          </h3>
          <div role="group" aria-label="Látható AI-fiókok" className="mt-3 flex flex-wrap gap-2">
            {draft.providers.map((provider) => {
              const isLastVisible = provider.visible && visibleProviders.length === 1;
              return (
                <ToggleChip
                  key={provider.id}
                  checked={provider.visible}
                  onChange={(visible) => patchProvider(provider.id, { visible })}
                  disabled={isLastVisible}
                  title={isLastVisible ? "Legalább egy AI-fióknak látszania kell" : undefined}
                >
                  {provider.label}
                </ToggleChip>
              );
            })}
          </div>
          <p className="mt-3 text-sm text-ink-3">
            A kikapcsolt fiók eltűnik a dashboardról és az AI-fiók választóból. A gépek jelentéseit a szerver
            továbbra is tárolja: visszakapcsolva az előzményekkel együtt tér vissza.
          </p>
        </section>

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
                  {visibleProviders.map((provider) => {
                    const limit = parseLimit(provider.limitText);
                    return (
                      <label key={provider.id} className="rounded-lg border border-hairline bg-page/40 p-3">
                        <span className="font-medium text-ink">{provider.label}</span>
                        <span className="mt-2 flex items-center gap-2">
                          <input
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            value={provider.limitText}
                            onChange={(event) => patchProvider(provider.id, { limitText: event.target.value })}
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

        <section aria-labelledby={`${titleId}-sub-limits`}>
          <h3 id={`${titleId}-sub-limits`} className="font-medium">
            Alkeretek
          </h3>
          <p className="mt-1.5 text-sm text-ink-3">
            Egy fiókon belül külön mért keret, például a Claude-nál a Fable: a dashboardon a fő csúszka alatt
            saját, kisebb csúszkát kap. Az <strong className="font-medium text-ink-2">önálló keret</strong>{" "}
            modelljei nem számítanak bele a fiók keretébe; <strong className="font-medium text-ink-2">a keret
            része</strong> a fiók keretéből legfeljebb a megadott arányt használhatja.
          </p>

          <div className="mt-4 space-y-4">
            {visibleProviders.map((provider) => (
              <div key={provider.id}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-ink-2">{provider.label}</span>
                  <button
                    type="button"
                    onClick={() => addSubLimit(provider)}
                    disabled={provider.subLimits.length >= MAX_SUB_LIMITS}
                    aria-label={`Alkeret hozzáadása: ${provider.label}`}
                    className={`flex shrink-0 items-center gap-2 text-sm ${QUIET_BUTTON}`}
                  >
                    <PlusIcon />
                    Alkeret
                  </button>
                </div>

                {provider.subLimits.length > 0 && (
                  <ul className="mt-2.5 space-y-3">
                    {provider.subLimits.map((sub) => (
                      <SubLimitEditor
                        key={sub.key}
                        sub={sub}
                        provider={provider}
                        useTokenLimits={draft.useTokenLimits}
                        onChange={(changes) => patchSubLimit(provider.id, sub.key, changes)}
                        onRemove={() => patchSubLimits(provider.id, (list) => list.filter((other) => other.key !== sub.key))}
                      />
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby={`${titleId}-reset`} className="space-y-4">
          <h3 id={`${titleId}-reset`} className="font-medium">{t("reset")}</h3>

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
          <h3 id={`${titleId}-groups`} className="font-medium">{t("groups")}</h3>

          {draft.groups.length > 0 && (
            <ul className="mt-3 border-t border-hairline">
              {draft.groups.map((group) => (
                <li key={group.id} className="border-b border-hairline py-2.5">
                  <div className="flex items-center gap-3">
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
                      title={group.hasReports ? t("group_has_reports_cannot_delete") : t("delete")}
                      className="rounded-md p-2 text-ink-3 transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-30"
                    >
                      <XIcon />
                    </button>
                  </div>
                  {/* Aligned with the name: the colour well is 2rem wide, the gap 0.75rem. */}
                  <div
                    role="group"
                    aria-label={`AI-fiókok, amelyekbe a(z) „${group.id}” csoport beszámít`}
                    className="mt-2 flex flex-wrap items-center gap-1.5 pl-11"
                  >
                    <span className="mr-1 text-sm text-ink-3" aria-hidden="true">{t("counts_towards")}</span>
                    {visibleProviders.map((provider) => (
                      <ToggleChip
                        key={provider.id}
                        checked={!group.excluded.includes(provider.id)}
                        onChange={(counted) => setCounted(group.id, provider.id, counted)}
                      >
                        {provider.label}
                      </ToggleChip>
                    ))}
                    {visibleProviders.every((provider) => group.excluded.includes(provider.id)) && (
                      <span className="ml-1 text-sm text-ink-3">{t("no_visible_account")}</span>
                    )}
                  </div>
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
              placeholder={t("new_group_placeholder")}
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
              <PlusIcon />{t("add")}</button>
          </div>

          <p className="mt-4 text-sm text-ink-3">
            A név az, amit a gép <code className="text-ink-2">groupId</code>-ként küld. Ha egy gép a listán nem
            szereplő csoportot jelent, az magától felkerül ide, véletlen színnel, és minden fiókba beszámít.
            Egy kikapcsolt fiók dashboardján a csoport tokenjei és gépei nem látszanak, a jelentéseik viszont
            tárolva maradnak. Törölni csak olyan csoportot lehet, amelynek nincs tárolt jelentése.
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
          <button type="button" onClick={onClose} className={QUIET_BUTTON}>{t("cancel")}</button>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-ink px-5 py-1.5 font-medium text-page transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {saving ? t("saving") : t("save")}
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
  const t = useTranslations("Settings");
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
        <span className="sr-only sm:not-sr-only">{t("settings_title")}</span>
      </button>

      <dialog
        ref={dialogRef}
        // The token section's own dialogs sit inside this one, and React bubbles their close events here.
        onClose={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        aria-labelledby={titleId}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-xl border border-rule bg-raised text-base text-ink shadow-2xl backdrop:bg-black/60"
      >
        {open && <SettingsForm view={view} titleId={titleId} onClose={() => dialogRef.current?.close()} />}
      </dialog>
    </>
  );
}

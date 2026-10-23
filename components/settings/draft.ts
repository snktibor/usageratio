import {
  type AlertsFormat,
  type BudgetPeriod,
  isValidTimeZone,
  type ResetMode,
  type ResetOverride,
} from "@/lib/config";
import {
  MAX_ALERT_THRESHOLDS,
  MAX_GROUPS,
  MAX_LIMIT,
  normalizeHexColor,
  type SettingsView,
  suggestGroupColor,
} from "@/lib/settings";
import {
  MAX_SUB_LIMIT_MODELS,
  normalizeModelPart,
  normalizeSubLimitName,
  type SubLimit,
  type SubLimitMode,
  subLimitIdFor,
} from "@/lib/sub-limits";
import { parseId } from "@/lib/validation";
import { isAllowedWebhookUrl } from "@/lib/webhook";

/**
 * The settings form's draft: its state, and the pure parsing/validation that
 * turns it into the PUT body. Problems are reported as `DraftProblem` codes,
 * never translated text — `problem-text.ts` turns a code into the sentence a
 * `Settings` translator shows, so this module stays free of `next-intl`.
 */

export interface DraftGroup {
  id: string;
  /** The last valid colour: what is shown and saved. */
  color: string;
  /** The HEX field exactly as typed; may be half-written. */
  colorText: string;
  hasReports: boolean;
  /** The providers whose usage in this group does not count. */
  excluded: string[];
}

/** A provider's own reset on the form: its moment as typed; `source` only while a report's value is untouched. */
export interface DraftOwnReset {
  weekday: number;
  monthDay: number;
  /** "HH:MM", as typed. */
  time: string;
  source?: "report" | "reset";
}

export interface DraftSubLimit {
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

export interface DraftProvider {
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

/** The alerts section's draft: the webhook URL as typed; empty means alerts are off. */
export interface AlertsDraft {
  webhookUrl: string;
  /** Sorted, each value once. */
  thresholds: number[];
  /** The "add a threshold" field, as typed. */
  newThreshold: string;
  perProvider: boolean;
  format: AlertsFormat;
  locale: string;
}

/** The form's state: strings as typed, validated only when saving. */
export interface Draft {
  period: BudgetPeriod;
  useTokenLimits: boolean;
  providers: DraftProvider[];
  weekday: number;
  monthDay: number;
  time: string;
  /** IANA name; the cycle's reset and the clients' day split both use it. */
  timeZone: string;
  /** providerId → its own reset; absent: the shared one. */
  resetOverrides: Record<string, DraftOwnReset>;
  /** providerId → how it resets early; only the stored entries (lib/settings.ts `resetModeOf` fills in defaults). */
  resetModes: Record<string, ResetMode>;
  showRemaining: boolean;
  costEstimate: boolean;
  groups: DraftGroup[];
  /** Taken off the list in this session; kept whole so a refused removal can be put back. */
  removed: DraftGroup[];
  newGroupName: string;
  /** The API-token field: saved by its own button, never with the rest. */
  apiToken: string;
  alerts: AlertsDraft;
}

export interface SettingsRequest {
  period: BudgetPeriod;
  useTokenLimits: boolean;
  limits: Record<string, number>;
  reset: { weekday: number; monthDay: number; hour: number; minute: number; timeZone: string };
  resetOverrides: Record<string, ResetOverride>;
  resetModes: Record<string, ResetMode>;
  showRemaining: boolean;
  costEstimate: boolean;
  hiddenProviders: string[];
  excludedProviders: Record<string, string[]>;
  subLimits: Record<string, SubLimit[]>;
  alerts: {
    webhookUrl: string | null;
    thresholds: number[];
    perProvider: boolean;
    format: AlertsFormat;
    locale: string;
  };
  groups: { id: string; color: string }[];
  removedGroups: string[];
}

/**
 * Why a draft cannot be saved, as a code plus whatever `problem-text.ts` needs
 * to fill the message's placeholders. Constants such as `maxLength` are not
 * carried: `problem-text.ts` imports them itself.
 */
export type DraftProblem =
  | { code: "at_least_one_visible_account" }
  | { code: "invalid_provider_limit"; label: string }
  | { code: "reset_time_format_error" }
  | { code: "invalid_own_reset_time"; label: string }
  | { code: "invalid_time_zone" }
  | { code: "invalid_group_color"; id: string }
  | { code: "missing_sublimit_name"; label: string }
  | { code: "duplicate_sublimit_name"; label: string; name: string }
  | { code: "invalid_sublimit_models"; name: string }
  | { code: "invalid_sublimit_share"; name: string }
  | { code: "invalid_sublimit_limit"; name: string }
  | { code: "group_name_rules" }
  | { code: "group_already_exists"; id: string }
  | { code: "max_groups_reached" }
  | { code: "invalid_alert_webhook" }
  | { code: "invalid_alert_threshold" }
  | { code: "max_alert_thresholds_reached" }
  | { code: "alerts_need_at_least_one_threshold" };

export function draftFrom(view: SettingsView): Draft {
  const {
    period,
    useTokenLimits,
    limits,
    reset,
    resetOverrides,
    resetModes,
    showRemaining,
    costEstimate,
    hiddenProviders,
    excludedProviders,
    subLimits,
  } = view.settings;
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
    timeZone: reset.timeZone,
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
    resetModes: { ...resetModes },
    showRemaining,
    costEstimate,
    groups: view.groups.map((group) => ({
      ...group,
      colorText: group.color,
      // A group id such as "constructor" must not find the object's prototype.
      excluded: Object.hasOwn(excludedProviders, group.id) ? [...excludedProviders[group.id]!] : [],
    })),
    removed: [],
    newGroupName: "",
    apiToken: "",
    alerts: {
      webhookUrl: view.settings.alerts.webhookUrl ?? "",
      thresholds: [...view.settings.alerts.thresholds],
      newThreshold: "",
      perProvider: view.settings.alerts.perProvider,
      format: view.settings.alerts.format,
      locale: view.settings.alerts.locale,
    },
  };
}

/** "500 000" → 500000; null unless a positive integer within bounds. */
export function parseLimit(text: string): number | null {
  const digits = text.replace(/[\s_.,]/g, "");
  if (!/^\d{1,13}$/.test(digits)) return null;
  const limit = Number(digits);
  return limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

/** " europe/budapest" → "Europe/Budapest"; null unless Intl knows the zone, the same check the server makes. */
export function parseTimeZone(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "" || !isValidTimeZone(trimmed)) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
}

/** "30", "30 %" → 30; null unless a whole percentage from 1 to 100. */
export function parseSharePercent(text: string): number | null {
  const digits = text.trim().replace(/\s*%$/, "");
  if (!/^\d{1,3}$/.test(digits)) return null;
  const percent = Number(digits);
  return percent >= 1 && percent <= 100 ? percent : null;
}

/** "fable, Opus-5" → ["fable", "opus-5"]; null when a part is no valid one, or there are none. */
export function parseModelParts(text: string): string[] | null {
  const parts: string[] = [];
  for (const raw of text.split(/[,;\s]+/).filter(Boolean)) {
    const part = normalizeModelPart(raw);
    if (!part) return null;
    if (!parts.includes(part)) parts.push(part);
  }
  return parts.length >= 1 && parts.length <= MAX_SUB_LIMIT_MODELS ? parts : null;
}

/** A provider's sub-limits as the PUT body wants them, or what is wrong with one. */
export function subLimitsRequest(
  provider: DraftProvider,
  useTokenLimits: boolean,
): { list: SubLimit[] } | { problem: DraftProblem } {
  const list: SubLimit[] = [];
  for (const draft of provider.subLimits) {
    const name = normalizeSubLimitName(draft.name);
    if (name === null) {
      return { problem: { code: "missing_sublimit_name", label: provider.label } };
    }
    if (list.some((other) => other.name.toLowerCase() === name.toLowerCase())) {
      return { problem: { code: "duplicate_sublimit_name", label: provider.label, name } };
    }
    const models = parseModelParts(draft.modelsText);
    if (models === null) {
      return { problem: { code: "invalid_sublimit_models", name } };
    }
    // Hidden fields must not block the save: they keep what was saved.
    const share = parseSharePercent(draft.shareText) ?? (draft.mode === "share" ? null : draft.savedShare);
    if (share === null) return { problem: { code: "invalid_sublimit_share", name } };
    const limit =
      parseLimit(draft.limitText) ?? (draft.mode === "separate" && useTokenLimits ? null : draft.savedLimit);
    if (limit === null) return { problem: { code: "invalid_sublimit_limit", name } };

    const taken = [
      ...provider.subLimits.flatMap((other) => (other.id ? [other.id] : [])),
      ...list.map((sub) => sub.id),
    ];
    list.push({
      id: draft.id ?? subLimitIdFor(name, taken),
      name,
      models,
      mode: draft.mode,
      sharePercent: share,
      limit,
    });
  }
  return { list };
}

/**
 * The threshold list with the typed percentage added, kept sorted; a value
 * already on it is dropped rather than repeated. A problem when the text is no
 * whole number from 1 to 100, or the list already holds MAX_ALERT_THRESHOLDS.
 */
export function withAlertThreshold(
  thresholds: number[],
  text: string,
): { thresholds: number[] } | { problem: DraftProblem } {
  const value = parseSharePercent(text);
  if (value === null) return { problem: { code: "invalid_alert_threshold" } };
  if (thresholds.includes(value)) return { thresholds };
  if (thresholds.length >= MAX_ALERT_THRESHOLDS) return { problem: { code: "max_alert_thresholds_reached" } };
  return { thresholds: [...thresholds, value].sort((a, b) => a - b) };
}

/** Why `name` cannot be added as a group; null when it can. */
export function groupNameProblem(name: string, groups: DraftGroup[]): DraftProblem | null {
  const errors: string[] = [];
  const id = parseId(name, "id", errors);
  if (errors.length > 0) {
    return { code: "group_name_rules" };
  }
  if (groups.some((group) => group.id === id)) return { code: "group_already_exists", id };
  if (groups.length >= MAX_GROUPS) return { code: "max_groups_reached" };
  return null;
}

/** The draft with the name in the "new group" field added to the list. */
export function withNewGroup(draft: Draft): Draft {
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

export function toRequest(draft: Draft): { request: SettingsRequest } | { problem: DraftProblem } {
  // A fresh install knows no provider yet: its reset, time zone and groups can still be saved.
  if (draft.providers.length > 0 && !draft.providers.some((provider) => provider.visible)) {
    return { problem: { code: "at_least_one_visible_account" } };
  }

  const parsedLimits = draft.providers.map((provider) => ({
    ...provider,
    // Hidden while the limits or the provider are off: a half-typed value left there must not block the save.
    parsed: parseLimit(provider.limitText) ?? (draft.useTokenLimits && provider.visible ? null : provider.savedLimit),
  }));
  const badLimit = parsedLimits.find((limit) => limit.parsed === null);
  if (badLimit) {
    return { problem: { code: "invalid_provider_limit", label: badLimit.label } };
  }

  const time = /^([01]\d|2[0-3]):([0-5]\d)/.exec(draft.time);
  if (!time) return { problem: { code: "reset_time_format_error" } };

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

  const timeZone = parseTimeZone(draft.timeZone);
  if (timeZone === null) return { problem: { code: "invalid_time_zone" } };

  const invalid = draft.groups.find((group) => normalizeHexColor(group.colorText) === null);
  if (invalid) {
    return { problem: { code: "invalid_group_color", id: invalid.id } };
  }

  const subLimits: Record<string, SubLimit[]> = {};
  for (const provider of draft.providers) {
    const result = subLimitsRequest(provider, draft.useTokenLimits);
    if ("problem" in result) return result;
    if (result.list.length > 0) subLimits[provider.id] = result.list;
  }

  // An empty field turns alerts off; a non-empty one must pass the same allow-list the server enforces.
  const trimmedWebhook = draft.alerts.webhookUrl.trim();
  const webhookUrl = trimmedWebhook === "" ? null : trimmedWebhook;
  if (webhookUrl !== null && !isAllowedWebhookUrl(webhookUrl)) {
    return { problem: { code: "invalid_alert_webhook" } };
  }
  // A value left in the "add" field was meant to be added: do not lose it silently.
  let thresholds = draft.alerts.thresholds;
  if (draft.alerts.newThreshold.trim() !== "") {
    const added = withAlertThreshold(thresholds, draft.alerts.newThreshold);
    if ("problem" in added) return added;
    thresholds = added.thresholds;
  }
  if (thresholds.length === 0) {
    return { problem: { code: "alerts_need_at_least_one_threshold" } };
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
        timeZone,
      },
      resetOverrides,
      resetModes: { ...draft.resetModes },
      showRemaining: draft.showRemaining,
      costEstimate: draft.costEstimate,
      hiddenProviders: draft.providers.filter((provider) => !provider.visible).map((provider) => provider.id),
      // Only the groups on the list: a removed group takes its exclusions with it.
      excludedProviders: Object.fromEntries(
        draft.groups.filter((group) => group.excluded.length > 0).map((group) => [group.id, group.excluded]),
      ),
      subLimits,
      alerts: {
        webhookUrl,
        thresholds: [...thresholds].sort((a, b) => a - b),
        perProvider: draft.alerts.perProvider,
        format: draft.alerts.format,
        locale: draft.alerts.locale,
      },
      groups: draft.groups.map(({ id, color }) => ({ id, color })),
      removedGroups: draft.removed.map((group) => group.id),
    },
  };
}

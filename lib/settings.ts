import type { AppConfig, BudgetPeriod } from "@/lib/config";
import {
  DEFAULT_PROVIDER_ID,
  MAX_PROVIDERS,
  mergeProviderIds,
  normalizeProviderId,
  providerLabel,
} from "@/lib/providers";
import { parseId } from "@/lib/validation";

/**
 * Everything the settings panel edits: the budget, the providers shown and
 * the groups. Pure: the Redis side is in lib/usage-store.ts, and the panel
 * imports this file too.
 */

/** The budget and which provider counts where, as stored under `usage:settings`. */
export interface UsageSettings {
  period: BudgetPeriod;
  /**
   * False: the dashboard uses no token limit at all, only the measured tokens
   * and the official percentage. `limits` are kept for switching it back on.
   */
  useTokenLimits: boolean;
  /** Token budget of one cycle, independently for every provider/account. */
  limits: Record<string, number>;
  /**
   * Both days are always kept, so switching the period back restores the
   * earlier choice. The time zone is deploy-time configuration (lib/config.ts).
   */
  reset: {
    /** Weekly budgets: 0 = Sunday … 6 = Saturday */
    weekday: number;
    /** Monthly budgets: 1–31; in a shorter month its last day stands in. */
    monthDay: number;
    hour: number;
    minute: number;
  };
  /**
   * False: the dashboard never states the tokens left, nor the overage. Only
   * matters with the token limits on: without a limit nothing is left to count.
   */
  showRemaining: boolean;
  /**
   * Providers the dashboard does not show, not even in its account picker.
   * Their reports are still stored: shown again, a provider has its history.
   */
  hiddenProviders: string[];
  /**
   * groupId → the providers whose usage in that group does not count: those
   * reports are left out of the provider's dashboard. Kept as exclusions, so a
   * group or a provider that reports for the first time always counts.
   */
  excludedProviders: Record<string, string[]>;
}

export interface GroupDefinition {
  id: string;
  /** "#rrggbb" */
  color: string;
}

/** A group as indexed in Redis. `color` is null for entries written before colours existed. */
export interface IndexedGroup {
  groupId: string;
  color: string | null;
  firstSeenAt: number;
}

/** An indexed group, plus whether any of its reports are still stored. */
export interface KnownGroup extends IndexedGroup {
  hasReports: boolean;
}

/** The body of PUT /api/settings. */
export interface SettingsUpdate {
  settings: UsageSettings;
  /** Groups to create or recolour. Groups that are not listed stay as they are. */
  groups: GroupDefinition[];
  /** Groups to take off the list: only possible while none of their reports are stored. */
  removedGroups: string[];
}

/** What the settings panel renders, and what GET /api/settings returns. */
export interface SettingsView {
  settings: UsageSettings;
  timeZone: string;
  providers: { id: string; label: string }[];
  /** In order of first appearance. */
  groups: (GroupDefinition & { hasReports: boolean })[];
}

export type SettingsParseResult =
  | { ok: true; update: SettingsUpdate }
  | { ok: false; errors: string[] };

export const MAX_LIMIT = 1_000_000_000_000;
export const MAX_GROUPS = 50;

/**
 * Suggested group colours, validated on #1a1a19 for colour-vision deficiency
 * and contrast. Entries without a stored colour get them in order of first
 * appearance; NEUTRAL_COLOR stands in once the eight are taken.
 */
export const PRESET_COLORS = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#008300",
  "#9085e9",
  "#e66767",
] as const;
export const NEUTRAL_COLOR = "#6b6a65";

const PERIODS: readonly BudgetPeriod[] = ["weekly", "monthly"];

function isPeriod(value: unknown): value is BudgetPeriod {
  return (PERIODS as readonly unknown[]).includes(value);
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// ── Budget ───────────────────────────────────────────────────────────────────

/** The budget part of a configuration: the defaults while nothing is saved. */
export function settingsFromConfig(
  config: AppConfig,
  providerIds: string[] = [DEFAULT_PROVIDER_ID],
): UsageSettings {
  const { period, weekday, monthDay, hour, minute } = config.reset;
  const providers = mergeProviderIds(providerIds, Object.keys(config.providerLimits));
  return {
    period,
    useTokenLimits: config.useTokenLimits,
    limits: Object.fromEntries(
      providers.map((providerId) => [providerId, config.providerLimits[providerId] ?? config.limit]),
    ),
    reset: { weekday, monthDay, hour, minute },
    showRemaining: config.showRemaining,
    hiddenProviders: [...config.hiddenProviders],
    excludedProviders: copyExclusions(config.excludedProviders),
  };
}

export function applySettings(config: AppConfig, settings: UsageSettings): AppConfig {
  return {
    ...config,
    useTokenLimits: settings.useTokenLimits,
    providerLimits: { ...settings.limits },
    reset: { ...config.reset, period: settings.period, ...settings.reset },
    showRemaining: settings.showRemaining,
    hiddenProviders: [...settings.hiddenProviders],
    excludedProviders: copyExclusions(settings.excludedProviders),
  };
}

/**
 * Reads the stored settings document leniently: a missing document, or any
 * field that does not hold up, falls back to `defaults` instead of failing.
 */
export function parseStoredSettings(raw: string | null, defaults: UsageSettings): UsageSettings {
  if (!raw) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  const doc = asRecord(parsed);
  if (!doc) return defaults;
  const reset = asRecord(doc.reset) ?? {};
  const storedExclusions = asRecord(doc.excludedProviders);
  const limits = { ...defaults.limits };
  const storedLimits = asRecord(doc.limits);
  if (storedLimits) {
    for (const [rawProvider, rawLimit] of Object.entries(storedLimits).slice(0, MAX_PROVIDERS)) {
      const providerId = normalizeProviderId(rawProvider);
      if (providerId && isIntegerIn(rawLimit, 1, MAX_LIMIT)) limits[providerId] = rawLimit;
    }
  } else if (isIntegerIn(doc.limit, 1, MAX_LIMIT)) {
    // v1 had one global limit. Apply it to every provider currently known;
    // with no index yet the legacy provider is DeepSeek.
    for (const providerId of mergeProviderIds(Object.keys(limits))) limits[providerId] = doc.limit;
  }

  return {
    period: isPeriod(doc.period) ? doc.period : defaults.period,
    // Documents saved before this switch existed lack the field: they get the default (off).
    useTokenLimits:
      typeof doc.useTokenLimits === "boolean" ? doc.useTokenLimits : defaults.useTokenLimits,
    limits,
    reset: {
      weekday: isIntegerIn(reset.weekday, 0, 6) ? reset.weekday : defaults.reset.weekday,
      monthDay: isIntegerIn(reset.monthDay, 1, 31) ? reset.monthDay : defaults.reset.monthDay,
      hour: isIntegerIn(reset.hour, 0, 23) ? reset.hour : defaults.reset.hour,
      minute: isIntegerIn(reset.minute, 0, 59) ? reset.minute : defaults.reset.minute,
    },
    // Documents saved before the switch existed lack the field: they keep the default.
    showRemaining: typeof doc.showRemaining === "boolean" ? doc.showRemaining : defaults.showRemaining,
    // Documents saved before these existed lack them: every provider shows, and counts everywhere.
    hiddenProviders: Array.isArray(doc.hiddenProviders)
      ? readProviderList(doc.hiddenProviders)
      : defaults.hiddenProviders,
    excludedProviders: storedExclusions ? readExclusions(storedExclusions) : defaults.excludedProviders,
  };
}

export function serializeSettings(settings: UsageSettings, now: Date): string {
  return JSON.stringify({ v: 2, ...settings, updatedAt: now.getTime() });
}

/** The effective configuration: deploy-time `config` under the stored settings document. */
export function resolveConfig(
  config: AppConfig,
  rawSettings: string | null,
  providerIds: string[] = [DEFAULT_PROVIDER_ID],
): AppConfig {
  return applySettings(
    config,
    parseStoredSettings(rawSettings, settingsFromConfig(config, providerIds)),
  );
}

/** Provider ids retained in a v2 settings document, even while they have no stored reports. */
export function storedProviderIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const document = asRecord(JSON.parse(raw));
    const limits = asRecord(document?.limits);
    if (limits) {
      return Object.keys(limits).slice(0, MAX_PROVIDERS).flatMap((key) => {
        const id = normalizeProviderId(key);
        return id ? [id] : [];
      });
    }
    return isIntegerIn(document?.limit, 1, MAX_LIMIT) ? [DEFAULT_PROVIDER_ID] : [];
  } catch {
    return [];
  }
}

/** Effective configuration for one selected provider. */
export function configForProvider(config: AppConfig, providerId: string): AppConfig {
  return { ...config, limit: config.providerLimits[providerId] ?? config.limit };
}

// ── Providers on the dashboard ───────────────────────────────────────────────

/**
 * The providers the dashboard shows, in the order of `providerIds`. Never
 * none: the panel always keeps one visible, and should a document edited by
 * hand hide them all, they all show.
 */
export function visibleProviderIds(config: AppConfig, providerIds: string[]): string[] {
  const visible = providerIds.filter((providerId) => !config.hiddenProviders.includes(providerId));
  return visible.length > 0 ? visible : providerIds;
}

/** Whether a group's reports of a provider count on that provider's dashboard. */
export function countsForProvider(
  exclusions: Record<string, string[]>,
  groupId: string,
  providerId: string,
): boolean {
  // Group ids such as "constructor" are valid: only own keys are exclusions.
  return !(Object.hasOwn(exclusions, groupId) && exclusions[groupId]!.includes(providerId));
}

function copyExclusions(exclusions: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(exclusions).map(([groupId, providers]) => [groupId, [...providers]]));
}

/** A stored provider list: the valid ids, each once, invalid ones skipped. */
function readProviderList(values: unknown[]): string[] {
  const providers: string[] = [];
  for (const value of values) {
    const providerId = normalizeProviderId(value);
    if (providerId && !providers.includes(providerId)) providers.push(providerId);
    if (providers.length === MAX_PROVIDERS) break;
  }
  return providers;
}

/** The stored exclusions: groups with a valid id and at least one valid provider. */
function readExclusions(stored: Record<string, unknown>): Record<string, string[]> {
  const exclusions: Record<string, string[]> = {};
  for (const [rawGroup, rawProviders] of Object.entries(stored).slice(0, MAX_GROUPS)) {
    const errors: string[] = [];
    const groupId = parseId(rawGroup, "group", errors);
    const providers = Array.isArray(rawProviders) ? readProviderList(rawProviders) : [];
    if (errors.length === 0 && providers.length > 0) exclusions[groupId] = providers;
  }
  return exclusions;
}

/** A provider list of the PUT body: every entry must be a valid id. Duplicates collapse. */
function parseProviderList(value: unknown, field: string, errors: string[]): string[] {
  if (!Array.isArray(value) || value.length > MAX_PROVIDERS) {
    errors.push(`${field} must be an array of at most ${MAX_PROVIDERS} provider ids`);
    return [];
  }
  const providers: string[] = [];
  value.forEach((item, index) => {
    const providerId = normalizeProviderId(item);
    if (!providerId) errors.push(`${field}[${index}] is not a valid provider id`);
    else if (!providers.includes(providerId)) providers.push(providerId);
  });
  return providers;
}

function parseExclusions(value: unknown, errors: string[]): Record<string, string[]> {
  const body = asRecord(value);
  const entries = body ? Object.entries(body) : [];
  if (!body || entries.length > MAX_GROUPS) {
    errors.push(`excludedProviders must be a JSON object of at most ${MAX_GROUPS} groups`);
    return {};
  }
  const exclusions: Record<string, string[]> = {};
  for (const [rawGroup, rawProviders] of entries) {
    const groupId = parseId(rawGroup, `excludedProviders key ${JSON.stringify(rawGroup)}`, errors);
    if (Object.hasOwn(exclusions, groupId)) {
      errors.push(`excludedProviders.${rawGroup} is listed twice after trimming`);
      continue;
    }
    const providers = parseProviderList(rawProviders, `excludedProviders.${rawGroup}`, errors);
    // An empty list excludes nothing: it is simply not stored.
    if (providers.length > 0) exclusions[groupId] = providers;
  }
  return exclusions;
}

/** Validates the JSON body of PUT /api/settings. Unlike stored settings, nothing is defaulted. */
export function parseSettingsUpdate(input: unknown): SettingsParseResult {
  const body = asRecord(input);
  if (!body) return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];

  if (!isPeriod(body.period)) errors.push('period must be "weekly" or "monthly"');
  if (typeof body.useTokenLimits !== "boolean") errors.push("useTokenLimits must be true or false");
  const limits: Record<string, number> = {};
  const rawLimits = asRecord(body.limits);
  if (!rawLimits) {
    errors.push("limits must be a JSON object");
  } else {
    const entries = Object.entries(rawLimits);
    if (entries.length < 1 || entries.length > MAX_PROVIDERS) {
      errors.push(`limits must contain between 1 and ${MAX_PROVIDERS} providers`);
    }
    for (const [rawProvider, rawLimit] of entries) {
      const providerId = normalizeProviderId(rawProvider);
      if (!providerId) {
        errors.push(`limits.${rawProvider} has an invalid provider id`);
      } else if (Object.hasOwn(limits, providerId)) {
        errors.push(`limits.${rawProvider} is listed twice after normalization`);
      } else if (!isIntegerIn(rawLimit, 1, MAX_LIMIT)) {
        errors.push(`limits.${rawProvider} must be an integer between 1 and ${MAX_LIMIT}`);
      } else {
        limits[providerId] = rawLimit;
      }
    }
  }

  const reset = asRecord(body.reset) ?? {};
  if (!isIntegerIn(reset.weekday, 0, 6)) errors.push("reset.weekday must be 0 (Sunday) to 6 (Saturday)");
  if (!isIntegerIn(reset.monthDay, 1, 31)) errors.push("reset.monthDay must be 1 to 31");
  if (!isIntegerIn(reset.hour, 0, 23)) errors.push("reset.hour must be 0 to 23");
  if (!isIntegerIn(reset.minute, 0, 59)) errors.push("reset.minute must be 0 to 59");
  if (typeof body.showRemaining !== "boolean") errors.push("showRemaining must be true or false");
  const hiddenProviders = parseProviderList(body.hiddenProviders, "hiddenProviders", errors);
  const excludedProviders = parseExclusions(body.excludedProviders, errors);

  const groups: GroupDefinition[] = [];
  const rawGroups = body.groups ?? [];
  if (!Array.isArray(rawGroups) || rawGroups.length > MAX_GROUPS) {
    errors.push(`groups must be an array of at most ${MAX_GROUPS} items`);
  } else {
    rawGroups.forEach((item, index) => {
      const entry = asRecord(item) ?? {};
      const id = parseId(entry.id, `groups[${index}].id`, errors);
      const color = normalizeHexColor(entry.color);
      if (!color) errors.push(`groups[${index}].color must be a hex colour such as "#3987e5"`);
      if (groups.some((group) => group.id === id)) errors.push(`groups[${index}].id is listed twice`);
      groups.push({ id, color: color ?? NEUTRAL_COLOR });
    });
  }

  const removedGroups: string[] = [];
  const rawRemoved = body.removedGroups ?? [];
  if (!Array.isArray(rawRemoved) || rawRemoved.length > MAX_GROUPS) {
    errors.push(`removedGroups must be an array of at most ${MAX_GROUPS} items`);
  } else {
    rawRemoved.forEach((item, index) => {
      const id = parseId(item, `removedGroups[${index}]`, errors);
      if (groups.some((group) => group.id === id)) {
        errors.push(`removedGroups[${index}] is also listed in groups`);
      }
      if (!removedGroups.includes(id)) removedGroups.push(id);
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    update: {
      settings: {
        period: body.period as BudgetPeriod,
        useTokenLimits: body.useTokenLimits as boolean,
        limits,
        reset: {
          weekday: reset.weekday as number,
          monthDay: reset.monthDay as number,
          hour: reset.hour as number,
          minute: reset.minute as number,
        },
        showRemaining: body.showRemaining as boolean,
        hiddenProviders,
        excludedProviders,
      },
      groups,
      removedGroups,
    },
  };
}

// ── Group colours ────────────────────────────────────────────────────────────

/** "#ABC" or "#AABBCC" → "#aabbcc"; anything else → null. */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match?.[1]) return null;
  const hex = match[1].toLowerCase();
  return `#${hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex}`;
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const amplitude = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number): string => {
    const k = (n + hue / 30) % 12;
    const value = lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/**
 * The colour of a group nobody defined in advance: any hue, with saturation
 * and lightness held in the band that stays legible on the dark page.
 */
export function randomGroupColor(random: () => number = Math.random): string {
  return hslToHex(Math.floor(random() * 360), 0.55 + random() * 0.2, 0.6 + random() * 0.08);
}

/** One field of the `usage:groups` hash. A bare number is the pre-colour format: the first-seen time. */
export function parseGroupEntry(groupId: string, raw: string): IndexedGroup {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "number") return { groupId, color: null, firstSeenAt: value };
    const entry = asRecord(value);
    if (entry) {
      return {
        groupId,
        color: normalizeHexColor(entry.color),
        firstSeenAt: typeof entry.ts === "number" && Number.isFinite(entry.ts) ? entry.ts : 0,
      };
    }
  } catch {
    // Edited by hand into something unreadable: keep the group, lose the details.
  }
  return { groupId, color: null, firstSeenAt: 0 };
}

export function serializeGroupEntry(color: string, firstSeenAt: number): string {
  return JSON.stringify({ color, ts: firstSeenAt });
}

function byFirstAppearance(a: IndexedGroup, b: IndexedGroup): number {
  return a.firstSeenAt - b.firstSeenAt || a.groupId.localeCompare(b.groupId);
}

/**
 * The colour of every group. A stored colour always wins. Groups without one
 * (pre-colour entries, and `unindexedIds` that only occur in reports) take the
 * free presets in order of first appearance, so their colour never depends on rank.
 */
export function resolveGroupColors(
  groups: IndexedGroup[],
  unindexedIds: string[] = [],
): Map<string, string> {
  const colors = new Map<string, string>();
  for (const group of groups) {
    if (group.color) colors.set(group.groupId, group.color);
  }

  const stored = [...colors.values()];
  const free: string[] = PRESET_COLORS.filter((preset) => !stored.includes(preset));
  const inOrder = [
    ...[...groups].sort(byFirstAppearance).map((group) => group.groupId),
    ...[...unindexedIds].sort((a, b) => a.localeCompare(b)),
  ];
  for (const groupId of inOrder) {
    if (!colors.has(groupId)) colors.set(groupId, free.shift() ?? NEUTRAL_COLOR);
  }
  return colors;
}

/** A colour for a group being added on the panel: the first preset not in use, else a random one. */
export function suggestGroupColor(usedColors: string[], random: () => number = Math.random): string {
  return PRESET_COLORS.find((color) => !usedColors.includes(color)) ?? randomGroupColor(random);
}

export function buildSettingsView(
  config: AppConfig,
  groups: KnownGroup[],
  providerIds: string[] = Object.keys(config.providerLimits),
): SettingsView {
  const colors = resolveGroupColors(groups);
  const providers = mergeProviderIds(providerIds, Object.keys(config.providerLimits));
  return {
    settings: settingsFromConfig(config, providers),
    timeZone: config.reset.timeZone,
    providers: providers.map((id) => ({ id, label: providerLabel(id) })),
    groups: [...groups].sort(byFirstAppearance).map((group) => ({
      id: group.groupId,
      color: colors.get(group.groupId) ?? NEUTRAL_COLOR,
      hasReports: group.hasReports,
    })),
  };
}

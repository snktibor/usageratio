import { hasLocale } from "next-intl";
import { routing } from "@/i18n/routing";
import {
  type AlertsConfig,
  type AlertsFormat,
  type AppConfig,
  type BudgetPeriod,
  DEFAULT_ALERTS,
  isValidTimeZone,
  type ResetConfig,
  type ResetOverride,
} from "@/lib/config";
import { MAX_PROVIDERS, mergeProviderIds, normalizeProviderId, providerLabel } from "@/lib/providers";
import {
  isSubLimitId,
  MAX_SUB_LIMIT_MODELS,
  MAX_SUB_LIMITS,
  normalizeModelPart,
  normalizeSubLimitName,
  type SubLimit,
  type SubLimitMode,
} from "@/lib/sub-limits";
import { parseId } from "@/lib/validation";
import { isAllowedWebhookUrl, MAX_WEBHOOK_URL_LENGTH } from "@/lib/webhook";

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
   * earlier choice. `timeZone` is a setting too: `resolveConfig` lays it over
   * the deploy-time default (lib/config.ts) whenever the document holds a
   * valid one. Changing it mid-cycle leaves the day (and hour) checkpoints
   * already written under the old zone (see lib/days.ts); snapshot mode
   * tolerates that fine, since it always takes the largest total of the
   * cycle rather than trusting any one checkpoint's boundaries.
   */
  reset: {
    /** Weekly budgets: 0 = Sunday … 6 = Saturday */
    weekday: number;
    /** Monthly budgets: 1–31; in a shorter month its last day stands in. */
    monthDay: number;
    hour: number;
    minute: number;
    /** IANA time zone; validated on save, see `parseSettingsUpdate`. */
    timeZone: string;
  };
  /**
   * providerId → its own reset moment (weekday, month day, hour, minute) over
   * the shared period and time zone. Absent: the provider uses `reset`.
   * Set on the settings panel, or by an official report (lib/official-report.ts).
   */
  resetOverrides: Record<string, ResetOverride>;
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
  /**
   * providerId → its sub-limits, such as Claude's Fable, in the order the
   * dashboard lists them. See lib/sub-limits.ts.
   */
  subLimits: Record<string, SubLimit[]>;
  /**
   * Threshold webhook alerts. `webhookUrl: null` is off; a document saved
   * before this field existed parses to that. See lib/alerts.ts.
   */
  alerts: AlertsConfig;
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
  /** `models`: this cycle's model ids of the provider (without their dates), for picking a sub-limit's. */
  providers: { id: string; label: string; models: string[] }[];
  /** In order of first appearance. */
  groups: (GroupDefinition & { hasReports: boolean })[];
}

export type SettingsParseResult = { ok: true; update: SettingsUpdate } | { ok: false; errors: string[] };

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

/** The budget part of a configuration: the defaults while nothing is saved. */
export function settingsFromConfig(config: AppConfig, providerIds: string[] = []): UsageSettings {
  const { period, weekday, monthDay, hour, minute, timeZone } = config.reset;
  const providers = mergeProviderIds(providerIds, Object.keys(config.providerLimits));
  return {
    period,
    useTokenLimits: config.useTokenLimits,
    limits: Object.fromEntries(
      providers.map((providerId) => [providerId, config.providerLimits[providerId] ?? config.limit]),
    ),
    reset: { weekday, monthDay, hour, minute, timeZone },
    resetOverrides: copyResetOverrides(config.resetOverrides),
    showRemaining: config.showRemaining,
    hiddenProviders: [...config.hiddenProviders],
    excludedProviders: copyExclusions(config.excludedProviders),
    subLimits: copySubLimits(config.subLimits),
    alerts: copyAlerts(config.alerts),
  };
}

export function applySettings(config: AppConfig, settings: UsageSettings): AppConfig {
  return {
    ...config,
    useTokenLimits: settings.useTokenLimits,
    providerLimits: { ...settings.limits },
    reset: { ...config.reset, period: settings.period, ...settings.reset },
    resetOverrides: copyResetOverrides(settings.resetOverrides),
    showRemaining: settings.showRemaining,
    hiddenProviders: [...settings.hiddenProviders],
    excludedProviders: copyExclusions(settings.excludedProviders),
    subLimits: copySubLimits(settings.subLimits),
    alerts: copyAlerts(settings.alerts),
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
  const storedSubLimits = asRecord(doc.subLimits);
  const storedOverrides = asRecord(doc.resetOverrides);
  const storedAlerts = asRecord(doc.alerts);
  const limits = { ...defaults.limits };
  const storedLimits = asRecord(doc.limits);
  if (storedLimits) {
    for (const [rawProvider, rawLimit] of Object.entries(storedLimits).slice(0, MAX_PROVIDERS)) {
      const providerId = normalizeProviderId(rawProvider);
      if (providerId && isIntegerIn(rawLimit, 1, MAX_LIMIT)) limits[providerId] = rawLimit;
    }
  } else if (isIntegerIn(doc.limit, 1, MAX_LIMIT)) {
    // v1 had one global limit. Apply it to every provider already known; with
    // none known yet (a fresh install) there is nothing to seed it onto.
    for (const providerId of mergeProviderIds(Object.keys(limits))) limits[providerId] = doc.limit;
  }

  return {
    period: isPeriod(doc.period) ? doc.period : defaults.period,
    // Documents saved before this switch existed lack the field: they get the default (off).
    useTokenLimits: typeof doc.useTokenLimits === "boolean" ? doc.useTokenLimits : defaults.useTokenLimits,
    limits,
    reset: {
      weekday: isIntegerIn(reset.weekday, 0, 6) ? reset.weekday : defaults.reset.weekday,
      monthDay: isIntegerIn(reset.monthDay, 1, 31) ? reset.monthDay : defaults.reset.monthDay,
      hour: isIntegerIn(reset.hour, 0, 23) ? reset.hour : defaults.reset.hour,
      minute: isIntegerIn(reset.minute, 0, 59) ? reset.minute : defaults.reset.minute,
      // A v2 document has none: it keeps the deploy-time zone (env RESET_TIMEZONE, else UTC).
      timeZone:
        typeof reset.timeZone === "string" && isValidTimeZone(reset.timeZone)
          ? reset.timeZone
          : defaults.reset.timeZone,
    },
    // Documents saved before per-provider resets existed lack the field: every provider uses `reset`.
    resetOverrides: storedOverrides ? readResetOverrides(storedOverrides) : defaults.resetOverrides,
    // Documents saved before the switch existed lack the field: they keep the default.
    showRemaining: typeof doc.showRemaining === "boolean" ? doc.showRemaining : defaults.showRemaining,
    // Documents saved before these existed lack them: every provider shows, and counts everywhere.
    hiddenProviders: Array.isArray(doc.hiddenProviders)
      ? readProviderList(doc.hiddenProviders)
      : defaults.hiddenProviders,
    excludedProviders: storedExclusions ? readExclusions(storedExclusions) : defaults.excludedProviders,
    subLimits: storedSubLimits ? readSubLimits(storedSubLimits) : defaults.subLimits,
    // Documents saved before alerts existed lack the field: they parse to off (webhookUrl: null).
    alerts: storedAlerts ? readAlerts(storedAlerts, defaults.alerts) : defaults.alerts,
  };
}

export function serializeSettings(settings: UsageSettings, now: Date): string {
  return JSON.stringify({ v: 3, ...settings, updatedAt: now.getTime() });
}

/** The effective configuration: deploy-time `config` under the stored settings document. */
export function resolveConfig(config: AppConfig, rawSettings: string | null, providerIds: string[] = []): AppConfig {
  return applySettings(config, parseStoredSettings(rawSettings, settingsFromConfig(config, providerIds)));
}

/** Provider ids retained in a v2 settings document, even while they have no stored reports. */
export function storedProviderIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const document = asRecord(JSON.parse(raw));
    const limits = asRecord(document?.limits);
    if (limits) {
      return Object.keys(limits)
        .slice(0, MAX_PROVIDERS)
        .flatMap((key) => {
          const id = normalizeProviderId(key);
          return id ? [id] : [];
        });
    }
    // v1's global `limit` named no provider explicitly: nothing to retain here.
    return [];
  } catch {
    return [];
  }
}

/** The reset one provider's cycle runs on: its override over the shared period and time zone. */
export function resetFor(config: AppConfig, providerId: string): ResetConfig {
  const override = Object.hasOwn(config.resetOverrides, providerId) ? config.resetOverrides[providerId] : undefined;
  return override ? { ...config.reset, ...override } : config.reset;
}

/** Effective configuration for one selected provider: its limit and its reset. */
export function configForProvider(config: AppConfig, providerId: string): AppConfig {
  return { ...config, limit: config.providerLimits[providerId] ?? config.limit, reset: resetFor(config, providerId) };
}

// ── Providers on the dashboard ───────────────────────────────────────────────

/** A provider's sub-limits; none for a provider without any. */
export function subLimitsOf(config: AppConfig, providerId: string): SubLimit[] {
  return Object.hasOwn(config.subLimits, providerId) ? config.subLimits[providerId]! : [];
}

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
export function countsForProvider(exclusions: Record<string, string[]>, groupId: string, providerId: string): boolean {
  // Group ids such as "constructor" are valid: only own keys are exclusions.
  return !(Object.hasOwn(exclusions, groupId) && exclusions[groupId]!.includes(providerId));
}

function copySubLimits(subLimits: Record<string, SubLimit[]>): Record<string, SubLimit[]> {
  return Object.fromEntries(
    Object.entries(subLimits).map(([providerId, list]) => [
      providerId,
      list.map((sub) => ({ ...sub, models: [...sub.models] })),
    ]),
  );
}

function copyExclusions(exclusions: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(exclusions).map(([groupId, providers]) => [groupId, [...providers]]));
}

function copyAlerts(alerts: AlertsConfig): AlertsConfig {
  return { ...alerts, thresholds: [...alerts.thresholds] };
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

// ── Sub-limits ───────────────────────────────────────────────────────────────

const SUB_LIMIT_MODES: readonly SubLimitMode[] = ["separate", "share"];

/**
 * One sub-limit. `field` names it in the errors; without `errors` a problem
 * just makes it null (the stored document is read leniently).
 */
function parseSubLimit(input: unknown, field: string, errors?: string[]): SubLimit | null {
  const problems: string[] = [];
  const entry = asRecord(input) ?? {};
  if (!isSubLimitId(entry.id)) problems.push(`${field}.id must be 1-32 lower-case letters, digits or dashes`);
  const name = normalizeSubLimitName(entry.name);
  if (name === null) problems.push(`${field}.name must be 1-40 characters`);

  const models: string[] = [];
  if (!Array.isArray(entry.models) || entry.models.length < 1 || entry.models.length > MAX_SUB_LIMIT_MODELS) {
    problems.push(`${field}.models must list 1-${MAX_SUB_LIMIT_MODELS} parts of model ids`);
  } else {
    entry.models.forEach((value, index) => {
      const part = normalizeModelPart(value);
      if (!part) problems.push(`${field}.models[${index}] must be letters, digits, dots, dashes or underscores`);
      else if (!models.includes(part)) models.push(part);
    });
  }
  if (!(SUB_LIMIT_MODES as readonly unknown[]).includes(entry.mode)) {
    problems.push(`${field}.mode must be "separate" or "share"`);
  }
  if (!isIntegerIn(entry.sharePercent, 1, 100)) problems.push(`${field}.sharePercent must be an integer from 1 to 100`);
  if (!isIntegerIn(entry.limit, 1, MAX_LIMIT))
    problems.push(`${field}.limit must be an integer between 1 and ${MAX_LIMIT}`);

  if (problems.length > 0) {
    errors?.push(...problems);
    return null;
  }
  return {
    id: entry.id as string,
    name: name!,
    models,
    mode: entry.mode as SubLimitMode,
    sharePercent: entry.sharePercent as number,
    limit: entry.limit as number,
  };
}

/** The stored sub-limits: the valid ones of valid providers, each id once. */
function readSubLimits(stored: Record<string, unknown>): Record<string, SubLimit[]> {
  const subLimits: Record<string, SubLimit[]> = {};
  for (const [rawProvider, rawList] of Object.entries(stored).slice(0, MAX_PROVIDERS)) {
    const providerId = normalizeProviderId(rawProvider);
    if (!providerId || !Array.isArray(rawList) || Object.hasOwn(subLimits, providerId)) continue;
    const list: SubLimit[] = [];
    for (const item of rawList.slice(0, MAX_SUB_LIMITS)) {
      const sub = parseSubLimit(item, "subLimit");
      if (sub && !list.some((other) => other.id === sub.id)) list.push(sub);
    }
    if (list.length > 0) subLimits[providerId] = list;
  }
  return subLimits;
}

function parseSubLimits(value: unknown, errors: string[]): Record<string, SubLimit[]> {
  const body = asRecord(value);
  const entries = body ? Object.entries(body) : [];
  if (!body || entries.length > MAX_PROVIDERS) {
    errors.push(`subLimits must be a JSON object of at most ${MAX_PROVIDERS} providers`);
    return {};
  }
  const subLimits: Record<string, SubLimit[]> = {};
  for (const [rawProvider, rawList] of entries) {
    const providerId = normalizeProviderId(rawProvider);
    if (!providerId) {
      errors.push(`subLimits.${rawProvider} has an invalid provider id`);
      continue;
    }
    if (Object.hasOwn(subLimits, providerId)) {
      errors.push(`subLimits.${rawProvider} is listed twice after normalization`);
      continue;
    }
    if (!Array.isArray(rawList) || rawList.length > MAX_SUB_LIMITS) {
      errors.push(`subLimits.${rawProvider} must be an array of at most ${MAX_SUB_LIMITS} sub-limits`);
      continue;
    }
    const list: SubLimit[] = [];
    rawList.forEach((item, index) => {
      const sub = parseSubLimit(item, `subLimits.${rawProvider}[${index}]`, errors);
      if (sub && list.some((other) => other.id === sub.id)) {
        errors.push(`subLimits.${rawProvider}[${index}].id is listed twice`);
      } else if (sub) {
        list.push(sub);
      }
    });
    if (list.length > 0) subLimits[providerId] = list;
  }
  return subLimits;
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export const MAX_ALERT_THRESHOLDS = 20;
export const ALERT_FORMATS: readonly AlertsFormat[] = ["generic", "slack", "discord"];

function isAlertFormat(value: unknown): value is AlertsFormat {
  return (ALERT_FORMATS as readonly unknown[]).includes(value);
}

function isAlertLocale(value: unknown): value is string {
  return typeof value === "string" && hasLocale(routing.locales, value);
}

/** Stored thresholds: 1-100 integers, each once, sorted; the whole list falls back together. */
function readThresholds(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value) || value.length === 0) return fallback;
  const thresholds: number[] = [];
  for (const item of value.slice(0, MAX_ALERT_THRESHOLDS)) {
    if (!isIntegerIn(item, 1, 100)) return fallback;
    if (!thresholds.includes(item)) thresholds.push(item);
  }
  return thresholds.length > 0 ? thresholds.sort((a, b) => a - b) : fallback;
}

/** A stored `alerts` document, read field by field: what does not hold up keeps its default. */
function readAlerts(doc: Record<string, unknown>, defaults: AlertsConfig): AlertsConfig {
  const webhookUrl =
    doc.webhookUrl === null
      ? null
      : typeof doc.webhookUrl === "string" &&
          doc.webhookUrl.length <= MAX_WEBHOOK_URL_LENGTH &&
          isAllowedWebhookUrl(doc.webhookUrl)
        ? doc.webhookUrl
        : defaults.webhookUrl;
  return {
    webhookUrl,
    thresholds: readThresholds(doc.thresholds, defaults.thresholds),
    perProvider: typeof doc.perProvider === "boolean" ? doc.perProvider : defaults.perProvider,
    format: isAlertFormat(doc.format) ? doc.format : defaults.format,
    locale: isAlertLocale(doc.locale) ? doc.locale : defaults.locale,
  };
}

/** The `alerts` part of the PUT body: unlike the stored document, a bad field fails the whole save. */
function parseAlertsUpdate(value: unknown, errors: string[]): AlertsConfig {
  const body = asRecord(value);
  if (!body) {
    errors.push("alerts must be a JSON object");
    return copyAlerts(DEFAULT_ALERTS);
  }

  let webhookUrl: string | null = null;
  if (body.webhookUrl !== null) {
    if (
      typeof body.webhookUrl !== "string" ||
      body.webhookUrl.length > MAX_WEBHOOK_URL_LENGTH ||
      !isAllowedWebhookUrl(body.webhookUrl)
    ) {
      errors.push("alerts.webhookUrl must be an allowed https URL, or null");
    } else {
      webhookUrl = body.webhookUrl;
    }
  }

  const rawThresholds = body.thresholds;
  const thresholds: number[] = [];
  if (!Array.isArray(rawThresholds) || rawThresholds.length < 1 || rawThresholds.length > MAX_ALERT_THRESHOLDS) {
    errors.push(`alerts.thresholds must be an array of 1-${MAX_ALERT_THRESHOLDS} integers from 1 to 100`);
  } else {
    rawThresholds.forEach((item, index) => {
      if (!isIntegerIn(item, 1, 100)) errors.push(`alerts.thresholds[${index}] must be an integer from 1 to 100`);
      else if (!thresholds.includes(item)) thresholds.push(item);
    });
    thresholds.sort((a, b) => a - b);
  }

  if (typeof body.perProvider !== "boolean") errors.push("alerts.perProvider must be true or false");
  if (!isAlertFormat(body.format)) errors.push(`alerts.format must be one of ${ALERT_FORMATS.join(", ")}`);
  if (!isAlertLocale(body.locale)) errors.push("alerts.locale must be a supported locale");

  return {
    webhookUrl,
    thresholds,
    perProvider: typeof body.perProvider === "boolean" ? body.perProvider : DEFAULT_ALERTS.perProvider,
    format: isAlertFormat(body.format) ? body.format : DEFAULT_ALERTS.format,
    locale: isAlertLocale(body.locale) ? body.locale : DEFAULT_ALERTS.locale,
  };
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
  if (typeof reset.timeZone !== "string" || !isValidTimeZone(reset.timeZone)) {
    errors.push("reset.timeZone must be a valid IANA time zone name");
  }
  const resetOverrides = parseResetOverrides(body.resetOverrides, errors);
  if (typeof body.showRemaining !== "boolean") errors.push("showRemaining must be true or false");
  const hiddenProviders = parseProviderList(body.hiddenProviders, "hiddenProviders", errors);
  const excludedProviders = parseExclusions(body.excludedProviders, errors);
  const subLimits = parseSubLimits(body.subLimits, errors);
  const alerts = parseAlertsUpdate(body.alerts, errors);

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
          timeZone: reset.timeZone as string,
        },
        resetOverrides,
        showRemaining: body.showRemaining as boolean,
        hiddenProviders,
        excludedProviders,
        subLimits,
        alerts,
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
export function resolveGroupColors(groups: IndexedGroup[], unindexedIds: string[] = []): Map<string, string> {
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
  modelsByProvider: Record<string, string[]> = {},
): SettingsView {
  const colors = resolveGroupColors(groups);
  const providers = mergeProviderIds(providerIds, Object.keys(config.providerLimits));
  return {
    settings: settingsFromConfig(config, providers),
    timeZone: config.reset.timeZone,
    providers: providers.map((id) => ({
      id,
      label: providerLabel(id),
      models: Object.hasOwn(modelsByProvider, id) ? [...modelsByProvider[id]!] : [],
    })),
    groups: [...groups].sort(byFirstAppearance).map((group) => ({
      id: group.groupId,
      color: colors.get(group.groupId) ?? NEUTRAL_COLOR,
      hasReports: group.hasReports,
    })),
  };
}

import type { AppConfig, BudgetPeriod } from "@/lib/config";
import { parseId } from "@/lib/validation";

/**
 * Everything the settings panel edits: the budget and the groups. Pure: the
 * Redis side is in lib/usage-store.ts, and the panel imports this file too.
 */

/** The budget, as stored under `usage:settings`. */
export interface UsageSettings {
  period: BudgetPeriod;
  /** Token budget of one cycle. */
  limit: number;
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
export function settingsFromConfig(config: AppConfig): UsageSettings {
  const { period, weekday, monthDay, hour, minute } = config.reset;
  return { period, limit: config.limit, reset: { weekday, monthDay, hour, minute } };
}

export function applySettings(config: AppConfig, settings: UsageSettings): AppConfig {
  return {
    ...config,
    limit: settings.limit,
    reset: { ...config.reset, period: settings.period, ...settings.reset },
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

  return {
    period: isPeriod(doc.period) ? doc.period : defaults.period,
    limit: isIntegerIn(doc.limit, 1, MAX_LIMIT) ? doc.limit : defaults.limit,
    reset: {
      weekday: isIntegerIn(reset.weekday, 0, 6) ? reset.weekday : defaults.reset.weekday,
      monthDay: isIntegerIn(reset.monthDay, 1, 31) ? reset.monthDay : defaults.reset.monthDay,
      hour: isIntegerIn(reset.hour, 0, 23) ? reset.hour : defaults.reset.hour,
      minute: isIntegerIn(reset.minute, 0, 59) ? reset.minute : defaults.reset.minute,
    },
  };
}

export function serializeSettings(settings: UsageSettings, now: Date): string {
  return JSON.stringify({ v: 1, ...settings, updatedAt: now.getTime() });
}

/** The effective configuration: deploy-time `config` under the stored settings document. */
export function resolveConfig(config: AppConfig, rawSettings: string | null): AppConfig {
  return applySettings(config, parseStoredSettings(rawSettings, settingsFromConfig(config)));
}

/** Validates the JSON body of PUT /api/settings. Unlike stored settings, nothing is defaulted. */
export function parseSettingsUpdate(input: unknown): SettingsParseResult {
  const body = asRecord(input);
  if (!body) return { ok: false, errors: ["body must be a JSON object"] };
  const errors: string[] = [];

  if (!isPeriod(body.period)) errors.push('period must be "weekly" or "monthly"');
  if (!isIntegerIn(body.limit, 1, MAX_LIMIT)) {
    errors.push(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }

  const reset = asRecord(body.reset) ?? {};
  if (!isIntegerIn(reset.weekday, 0, 6)) errors.push("reset.weekday must be 0 (Sunday) to 6 (Saturday)");
  if (!isIntegerIn(reset.monthDay, 1, 31)) errors.push("reset.monthDay must be 1 to 31");
  if (!isIntegerIn(reset.hour, 0, 23)) errors.push("reset.hour must be 0 to 23");
  if (!isIntegerIn(reset.minute, 0, 59)) errors.push("reset.minute must be 0 to 59");

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
        limit: body.limit as number,
        reset: {
          weekday: reset.weekday as number,
          monthDay: reset.monthDay as number,
          hour: reset.hour as number,
          minute: reset.minute as number,
        },
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

export function buildSettingsView(config: AppConfig, groups: KnownGroup[]): SettingsView {
  const colors = resolveGroupColors(groups);
  return {
    settings: settingsFromConfig(config),
    timeZone: config.reset.timeZone,
    groups: [...groups].sort(byFirstAppearance).map((group) => ({
      id: group.groupId,
      color: colors.get(group.groupId) ?? NEUTRAL_COLOR,
      hasReports: group.hasReports,
    })),
  };
}

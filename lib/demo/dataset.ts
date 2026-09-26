import { DEFAULT_RESET, type ResetConfig } from "@/lib/config";
import { type Cycle, getCycle, getDayEnd, getDaySegments, getDayStart, getPreviousCycle } from "@/lib/cycle";
import { type CycleSummary, HISTORY_TOP_MODELS } from "@/lib/history";
import type { OfficialUsageUpdate } from "@/lib/official-usage";
import { PRESET_COLORS, type SettingsUpdate } from "@/lib/settings";

/**
 * A synthetic account: a few machines in a few groups, two cycles of hourly
 * usage, and the settings that go with it. Pure and deterministic: the same
 * `now` and seed give byte-for-byte the same reports, so screenshots and
 * tests can rely on it. The reports are the exact JSON the client scripts
 * send (see app/api/usage/route.ts), which also makes this file a worked
 * example of the protocol.
 */

export const DEMO_SEED = 42;
export const DEMO_TIME_ZONE = "Europe/Budapest";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export interface DemoGroup {
  id: string;
  color: string;
}

export const DEMO_GROUPS: readonly DemoGroup[] = [
  { id: "Work", color: PRESET_COLORS[0] },
  { id: "Personal", color: PRESET_COLORS[1] },
  { id: "Lab", color: PRESET_COLORS[2] },
];

export interface DemoProvider {
  id: string;
  /** The token budget of one cycle on the settings panel. */
  limit: number;
  /** Its models and their relative weight in the split. */
  models: Record<string, number>;
}

export const DEMO_PROVIDERS: readonly DemoProvider[] = [
  {
    id: "claude",
    limit: 500_000,
    models: { "claude-opus-4-5-20251101": 5, "claude-sonnet-4-5-20250929": 3, "claude-fable-5-1": 2 },
  },
  { id: "openai", limit: 500_000, models: { "gpt-5-codex": 4, "gpt-5-mini": 1 } },
  { id: "deepseek", limit: 300_000, models: { "deepseek-chat": 1 } },
  { id: "gemini", limit: 200_000, models: { "gemini-2.5-pro": 1 } },
];

/** The providers whose days come split by clock hour: only Claude Code's, as `ccusage blocks` sees no other agent. */
export const DEMO_HOURLY_PROVIDERS: readonly string[] = ["claude"];

/**
 * A rough API-list-price, USD per token, for the models of the two providers
 * the demo opts into cost for (so a screenshot has something to show; ccusage
 * itself is what the real client reads this from). DeepSeek and Gemini are
 * left out on purpose: not every provider's client has to opt in.
 */
const DEMO_COST_PER_TOKEN: Record<string, number> = {
  "claude-opus-4-5-20251101": 22.5 / 1_000_000,
  "claude-sonnet-4-5-20250929": 6 / 1_000_000,
  "claude-fable-5-1": 3 / 1_000_000,
  "gpt-5-codex": 8 / 1_000_000,
  "gpt-5-mini": 1 / 1_000_000,
};

export type DemoOs = "macos" | "windows" | "linux";

export interface DemoMachine {
  id: string;
  groupId: string;
  os: DemoOs;
  /** "auto" reports on the hour whenever it is awake; "manual" whenever someone runs it. */
  mode: "auto" | "manual";
  /** Tokens per fully active hour, by provider, before the whole set is scaled to the budget. */
  rates: Record<string, number>;
  /** How busy each local clock hour is, 0–1, Monday to Friday and at the weekend. */
  weekdays: readonly number[];
  weekends: readonly number[];
  /** Its last report is this long before `now`; null keeps it reporting until `now`. */
  lastReportOffsetMs: number | null;
  /** The seconds past the hour its scheduler fires at. */
  secondsPastHour: number;
}

/** A 24-entry activity profile from `[fromHour, toHour, weight]` ranges. */
function profile(...ranges: [number, number, number][]): readonly number[] {
  const hours = new Array<number>(24).fill(0);
  for (const [from, to, weight] of ranges) for (let hour = from; hour < to; hour += 1) hours[hour] = weight;
  return hours;
}

const NOTHING = profile();

export const DEMO_MACHINES: readonly DemoMachine[] = [
  {
    id: "mac-studio",
    groupId: "Personal",
    os: "macos",
    mode: "auto",
    rates: { claude: 9_000, openai: 3_200 },
    weekdays: profile([7, 9, 0.4], [9, 12, 0.15], [12, 13, 0.05], [13, 18, 0.15], [18, 23, 0.9]),
    weekends: profile([9, 12, 0.7], [12, 13, 0.2], [13, 18, 0.8], [18, 23, 1]),
    lastReportOffsetMs: null,
    secondsPastHour: 7,
  },
  {
    id: "win-desktop",
    groupId: "Work",
    os: "windows",
    mode: "auto",
    rates: { claude: 8_000, deepseek: 2_600 },
    weekdays: profile([8, 9, 0.3], [9, 12, 1], [12, 13, 0.3], [13, 17, 1], [17, 19, 0.5]),
    weekends: profile([10, 14, 0.25]),
    lastReportOffsetMs: null,
    secondsPastHour: 23,
  },
  {
    id: "thinkpad",
    groupId: "Work",
    os: "linux",
    mode: "auto",
    rates: { claude: 6_000, gemini: 1_300 },
    weekdays: profile([8, 10, 0.6], [10, 12, 1], [12, 13, 0.2], [13, 18, 0.9], [18, 20, 0.4]),
    weekends: NOTHING,
    lastReportOffsetMs: null,
    secondsPastHour: 41,
  },
  {
    id: "build-box",
    groupId: "Lab",
    os: "linux",
    mode: "manual",
    rates: { deepseek: 4_000, openai: 2_000 },
    weekdays: profile([1, 5, 0.8], [5, 22, 0.2], [22, 24, 0.5]),
    weekends: profile([1, 5, 0.8], [5, 22, 0.2], [22, 24, 0.5]),
    lastReportOffsetMs: 5 * HOUR_MS,
    secondsPastHour: 0,
  },
  {
    id: "old-laptop",
    groupId: "Work",
    os: "macos",
    mode: "auto",
    rates: { claude: 5_000 },
    weekdays: profile([9, 12, 0.8], [12, 13, 0.3], [13, 17, 0.8]),
    weekends: NOTHING,
    lastReportOffsetMs: 6 * 24 * HOUR_MS,
    secondsPastHour: 12,
  },
];

/** What the dataset aims at: the measured share of the budget in each cycle. */
export const DEMO_TARGETS = {
  /** The reference provider the scaling is worked out on. */
  providerId: "claude",
  /** Of its limit, at `now`. */
  currentCycleShare: 0.65,
  /** Of its limit, over the whole previous cycle. */
  previousCycleShare: 0.88,
};

export interface DemoReport {
  machineId: string;
  timestampMs: number;
  /** The body of POST /api/usage, exactly as a client sends it. */
  body: Record<string, unknown>;
}

export interface DemoOfficialEntry extends OfficialUsageUpdate {
  /** When the figure was typed. */
  enteredAtMs: number;
}

export interface DemoDataset {
  timeZone: string;
  reset: ResetConfig;
  cycles: { current: Cycle; previous: Cycle };
  /** For `saveSettings` in lib/usage-store.ts; `parseSettingsUpdate` accepts its flattened form. */
  settings: SettingsUpdate;
  /** Oldest first; a machine's reports are in order among themselves. */
  reports: DemoReport[];
  official: DemoOfficialEntry[];
  /**
   * A handful of cycles before `cycles.previous`, already archived (lib/history.ts):
   * the real reports going that far back are never generated (there is nothing for
   * `ingestReport` to store, they would already be outside RETENTION_DAYS), so these
   * are written straight into `usage:history:{providerId}` by `seedStore`, the same
   * way lazy archiving would have left them. `cycles.previous` itself is not among
   * them: it still has real events, so the dashboard's own lazy archiving
   * (app/[locale]/(dashboard)/page.tsx) archives it from those on the first render, same as
   * it would for a real deployment.
   */
  history: DemoHistoryEntry[];
}

export interface DemoHistoryEntry {
  providerId: string;
  summary: CycleSummary;
}

export interface DemoOptions {
  seed?: number;
  timeZone?: string;
  /** The period, reset day and time; the time zone comes from `timeZone`. */
  reset?: Partial<Omit<ResetConfig, "timeZone">>;
}

// ── Deterministic randomness ─────────────────────────────────────────────────

/** mulberry32: a small seeded generator of numbers in [0, 1). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One number in [0, 1) for a tuple of integers, the same whatever order the tuples are asked in. */
function noise(seed: number, ...parts: number[]): number {
  let mixed = seed >>> 0;
  for (const part of parts) {
    mixed = Math.imul(mixed ^ (part >>> 0), 0x85ebca6b) >>> 0;
    mixed ^= mixed >>> 13;
    mixed = Math.imul(mixed, 0xc2b2ae35) >>> 0;
    mixed ^= mixed >>> 16;
  }
  return mulberry32(mixed)();
}

enum Salt {
  HourJitter = 1,
  DayJitter = 2,
  ModelJitter = 3,
  ManualSchedule = 4,
  HistoryShare = 5,
  HistoryGroup = 6,
  HistoryOfficial = 7,
  HistorySubLimit = 8,
  HistoryMachines = 9,
}

// ── Local time ───────────────────────────────────────────────────────────────

interface LocalParts {
  date: string;
  hour: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function localParts(ms: number, timeZone: string): LocalParts {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  const fields: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(ms))) fields[part.type] = part.value;
  return {
    date: `${fields.year}-${fields.month}-${fields.day}`,
    hour: Number(fields.hour) % 24,
    weekday: WEEKDAYS[fields.weekday ?? ""] ?? 0,
  };
}

/** "2026-09-19T11:00:00Z": how the server keys an hour. */
function hourKey(startMs: number): string {
  return new Date(startMs).toISOString().replace(".000Z", "Z");
}

// ── Usage ────────────────────────────────────────────────────────────────────

interface HourUsage {
  tokens: number;
  models: Record<string, number>;
}

/** tokens of one machine and provider in each clock hour, by the hour's start. */
type HourSeries = Map<number, HourUsage>;

function weightAt(machine: DemoMachine, local: LocalParts): number {
  const day = local.weekday === 0 || local.weekday === 6 ? machine.weekends : machine.weekdays;
  return day[local.hour] ?? 0;
}

/** Whether an automatic machine's scheduler fires at `ms`: it is awake in this hour or was in the one before. */
function isAwake(machine: DemoMachine, ms: number, timeZone: string): boolean {
  return weightAt(machine, localParts(ms, timeZone)) > 0 || weightAt(machine, localParts(ms - HOUR_MS, timeZone)) > 0;
}

/** Whether the machine is used at all on the local day that starts at `dayStartMs`. */
function isUsedOnDay(machine: DemoMachine, dayStartMs: number, timeZone: string): boolean {
  const { weekday } = localParts(dayStartMs + 12 * HOUR_MS, timeZone);
  const day = weekday === 0 || weekday === 6 ? machine.weekends : machine.weekdays;
  return day.some((weight) => weight > 0);
}

/** Splits `tokens` among the models by weight, the remainder to the heaviest, so the parts add up exactly. */
function splitModels(tokens: number, weights: Record<string, number>): Record<string, number> {
  const entries = Object.entries(weights);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  const split: Record<string, number> = {};
  let assigned = 0;
  let heaviest = entries[0]?.[0];
  for (const [model, weight] of entries) {
    const share = Math.floor((tokens * weight) / total);
    split[model] = share;
    assigned += share;
    if (weight > (weights[heaviest ?? model] ?? 0)) heaviest = model;
  }
  if (heaviest !== undefined) split[heaviest] = (split[heaviest] ?? 0) + (tokens - assigned);
  for (const [model, amount] of Object.entries(split)) if (amount === 0) delete split[model];
  return split;
}

function addInto(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, amount] of Object.entries(source)) target[key] = (target[key] ?? 0) + amount;
}

/**
 * A model split's cost ($), from DEMO_COST_PER_TOKEN; null when none of the
 * split's models has a rate (DeepSeek, Gemini): those providers' reports
 * simply carry no cost, the same as any client that never opted in.
 */
function costOfSplit(split: Record<string, number>): { total: number; byModel: Record<string, number> } | null {
  const byModel: Record<string, number> = {};
  let total = 0;
  for (const [model, tokens] of Object.entries(split)) {
    const rate = DEMO_COST_PER_TOKEN[model];
    if (!rate) continue;
    const cost = Math.round(tokens * rate * 10_000) / 10_000;
    if (cost <= 0) continue;
    byModel[model] = cost;
    total += cost;
  }
  return Object.keys(byModel).length > 0 ? { total: Math.round(total * 10_000) / 10_000, byModel } : null;
}

// ── History (archived cycles) ───────────────────────────────────────────────

/** How many cycles before `cycles.previous` the demo pre-archives. */
const DEMO_HISTORY_CYCLES = 6;

/** Which providers have an official percentage typed in a given past cycle, for variety. */
function hasOfficialFigure(providerId: string, cycleIndex: number): boolean {
  if (providerId === "deepseek") return false; // never: shows the "measured tokens" fallback in the chart
  if (providerId === "claude") return true; // always
  if (providerId === "openai") return cycleIndex % 2 === 0; // sometimes: a mix of recorded and "not recorded" bars
  return cycleIndex % 3 !== 0; // gemini: mostly
}

/**
 * A handful of plausible archived cycles before `previousCycle`, so the
 * "Previous cycles" section has something to show without waiting for real
 * dashboard reads to build up history (lazy archiving only ever reaches one
 * cycle back at a time; see lib/history.ts). Deterministic: reuses the same
 * seeded noise as the rest of the dataset, and the same `splitModels` integer
 * split for the groups' and models' shares of each cycle's total.
 */
function buildDemoHistory(previousCycle: Cycle, reset: ResetConfig, seed: number): DemoHistoryEntry[] {
  const entries: DemoHistoryEntry[] = [];
  let cycle = previousCycle;
  for (let cycleIndex = 1; cycleIndex <= DEMO_HISTORY_CYCLES; cycleIndex += 1) {
    cycle = getPreviousCycle(cycle, reset);
    for (const [providerIndex, provider] of DEMO_PROVIDERS.entries()) {
      const share = 0.4 + 0.55 * noise(seed, providerIndex, cycleIndex, Salt.HistoryShare);
      const total = Math.max(0, Math.round(provider.limit * share));

      // "Lab" never counts openai's usage (see the demo settings' excludedProviders below).
      const eligibleGroups = DEMO_GROUPS.filter((group) => provider.id !== "openai" || group.id !== "Lab");
      const groupWeights = Object.fromEntries(
        eligibleGroups.map((group, groupIndex) => [
          group.id,
          0.3 + noise(seed, providerIndex, cycleIndex, groupIndex, Salt.HistoryGroup),
        ]),
      );
      const groups = splitModels(total, groupWeights);

      const models = Object.fromEntries(
        Object.entries(splitModels(total, provider.models))
          .sort(([, a], [, b]) => b - a)
          .slice(0, HISTORY_TOP_MODELS),
      );
      // Same rough per-model rates the live reports use, so an archived cycle's cost lines
      // up with what it would have shown at the time (Claude, OpenAI only; see costOfSplit).
      const cost = costOfSplit(models);

      const subLimits: Record<string, number> =
        provider.id === "claude"
          ? { fable: Math.round(total * (0.15 + 0.2 * noise(seed, providerIndex, cycleIndex, Salt.HistorySubLimit))) }
          : {};

      const official = hasOfficialFigure(provider.id, cycleIndex)
        ? Math.round((40 + 65 * noise(seed, providerIndex, cycleIndex, Salt.HistoryOfficial)) * 10) / 10
        : null;

      entries.push({
        providerId: provider.id,
        summary: {
          v: 1,
          start: cycle.start.getTime(),
          end: cycle.end.getTime(),
          total,
          ...(cost && { cost: cost.total }),
          limit: null, // the demo ships with the token limits switched off (see `settings` below)
          official,
          groups,
          machines: 2 + Math.floor(noise(seed, providerIndex, cycleIndex, Salt.HistoryMachines) * 3),
          models,
          subLimits,
          archivedAt: cycle.end.getTime(),
        },
      });
    }
  }
  return entries;
}

// ── The dataset ──────────────────────────────────────────────────────────────

export function buildDemoDataset(now: Date, options: DemoOptions = {}): DemoDataset {
  const seed = options.seed ?? DEMO_SEED;
  const timeZone = options.timeZone ?? DEMO_TIME_ZONE;
  const reset: ResetConfig = { ...DEFAULT_RESET, ...options.reset, timeZone };
  const nowMs = now.getTime();
  const current = getCycle(now, reset);
  const previous = getPreviousCycle(current, reset);
  const cycleOf = (ms: number): Cycle => (ms < current.start.getTime() ? previous : current);
  const providerIndex = new Map(DEMO_PROVIDERS.map((provider, index) => [provider.id, index]));

  // The moments each machine reports at, oldest first.
  const schedules = DEMO_MACHINES.map((machine, machineIndex) => {
    const cutoff = nowMs - (machine.lastReportOffsetMs ?? 0);
    const moments: number[] = [];
    if (machine.mode === "auto") {
      // Last cycle: one snapshot at 23:30 of every day it was used; this cycle: on the hour, while awake.
      for (const segment of getDaySegments(previous, timeZone)) {
        const moment = segment.end.getTime() - 30 * MINUTE_MS;
        if (moment <= cutoff && isUsedOnDay(machine, segment.start.getTime(), timeZone)) moments.push(moment);
      }
      for (let hour = current.start.getTime(); hour + machine.secondsPastHour * 1000 <= cutoff; hour += HOUR_MS) {
        if (isAwake(machine, hour, timeZone)) moments.push(hour + machine.secondsPastHour * 1000);
      }
    } else {
      // Run by hand once or twice a day, at some hour of the working day; the last time exactly at the cutoff.
      const random = mulberry32(noise(seed, machineIndex, Salt.ManualSchedule) * 4294967296);
      for (const segment of [...getDaySegments(previous, timeZone), ...getDaySegments(current, timeZone)]) {
        const runs = random() < 0.55 ? 1 : 2;
        for (let run = 0; run < runs; run += 1) {
          const moment =
            segment.start.getTime() + (8 + Math.floor(random() * 14)) * HOUR_MS + Math.floor(random() * 60) * MINUTE_MS;
          if (moment >= segment.end.getTime() || moment >= cutoff - HOUR_MS) continue;
          moments.push(moment);
        }
      }
      if (cutoff >= previous.start.getTime()) moments.push(cutoff);
    }
    return moments.sort((a, b) => a - b);
  });

  // Every clock hour of both cycles, before scaling: how busy the machine was, with a bit of noise.
  const firstHour = Math.ceil(previous.start.getTime() / HOUR_MS) * HOUR_MS;
  const raw = DEMO_MACHINES.map((machine, machineIndex) => {
    const byProvider = new Map<string, Map<number, number>>();
    for (const [providerId, rate] of Object.entries(machine.rates)) {
      const series = new Map<number, number>();
      const providerNo = providerIndex.get(providerId) ?? 0;
      for (let hour = firstHour; hour + HOUR_MS <= nowMs; hour += HOUR_MS) {
        const local = localParts(hour, timeZone);
        const weight = weightAt(machine, local);
        if (weight === 0) continue;
        const hourNo = Math.floor(hour / HOUR_MS);
        const dayNo = Math.floor(hour / (24 * HOUR_MS));
        const dayJitter = 0.6 + 0.8 * noise(seed, machineIndex, providerNo, dayNo, Salt.DayJitter);
        const hourJitter = 0.4 + 1.2 * noise(seed, machineIndex, providerNo, hourNo, Salt.HourJitter);
        series.set(hour, rate * weight * dayJitter * hourJitter);
      }
      byProvider.set(providerId, series);
    }
    return byProvider;
  });

  // Scale each cycle so the reference provider's measured total lands on its target.
  const reference = DEMO_PROVIDERS.find((provider) => provider.id === DEMO_TARGETS.providerId);
  const factorFor = (cycle: Cycle, share: number): number => {
    let visible = 0;
    DEMO_MACHINES.forEach((_machine, machineIndex) => {
      const last = schedules[machineIndex]!.filter((moment) => cycleOf(moment) === cycle).at(-1);
      if (last === undefined) return;
      for (const [hour, tokens] of raw[machineIndex]!.get(DEMO_TARGETS.providerId) ?? []) {
        if (hour >= cycle.start.getTime() && hour + HOUR_MS <= last) visible += tokens;
      }
    });
    if (!reference || visible === 0) return 1;
    return Math.min(5, Math.max(0.2, (share * reference.limit) / visible));
  };
  const factors = new Map<Cycle, number>([
    [previous, factorFor(previous, DEMO_TARGETS.previousCycleShare)],
    [current, factorFor(current, DEMO_TARGETS.currentCycleShare)],
  ]);

  const usage = DEMO_MACHINES.map((_machine, machineIndex) => {
    const byProvider = new Map<string, HourSeries>();
    for (const [providerId, series] of raw[machineIndex]!) {
      const provider = DEMO_PROVIDERS.find((candidate) => candidate.id === providerId);
      const providerNo = providerIndex.get(providerId) ?? 0;
      const scaled: HourSeries = new Map();
      for (const [hour, amount] of series) {
        const tokens = Math.round(amount * (factors.get(cycleOf(hour)) ?? 1));
        if (tokens === 0) continue;
        // Each day leans on its models a little differently.
        const dayNo = Math.floor(hour / (24 * HOUR_MS));
        const weights = Object.fromEntries(
          Object.entries(provider?.models ?? {}).map(([model, weight], modelNo) => [
            model,
            weight * (0.7 + 0.6 * noise(seed, machineIndex, providerNo, dayNo, modelNo, Salt.ModelJitter)),
          ]),
        );
        scaled.set(hour, { tokens, models: splitModels(tokens, weights) });
      }
      byProvider.set(providerId, scaled);
    }
    return byProvider;
  });

  // The cycle-to-date snapshot a machine sends at `moment`: what it had counted by then.
  const reportAt = (machine: DemoMachine, machineIndex: number, moment: number): DemoReport => {
    const cycle = cycleOf(moment);
    const providers: Record<string, number> = {};
    const models: Record<string, Record<string, number>> = {};
    const costs: Record<string, number> = {};
    const modelCosts: Record<string, Record<string, number>> = {};
    const days = new Map<
      string,
      {
        providers: Record<string, number>;
        models: Record<string, Record<string, number>>;
        hours: Record<string, Record<string, number>>;
      }
    >();

    for (const providerId of Object.keys(machine.rates)) {
      let total = 0;
      const split: Record<string, number> = {};
      const series = usage[machineIndex]!.get(providerId) ?? new Map<number, HourUsage>();
      for (const [hour, entry] of [...series].sort(([a], [b]) => a - b)) {
        if (hour < cycle.start.getTime() || hour + HOUR_MS > moment) continue;
        total += entry.tokens;
        addInto(split, entry.models);

        const { date } = localParts(hour, timeZone);
        const day = days.get(date) ?? { providers: {}, models: {}, hours: {} };
        days.set(date, day);
        day.providers[providerId] = (day.providers[providerId] ?? 0) + entry.tokens;
        addInto((day.models[providerId] ??= {}), entry.models);
        const insideDay =
          hour >= getDayStart(date, timeZone).getTime() && hour + HOUR_MS <= getDayEnd(date, timeZone).getTime();
        if (DEMO_HOURLY_PROVIDERS.includes(providerId) && insideDay) {
          (day.hours[providerId] ??= {})[hourKey(hour)] = entry.tokens;
        }
      }
      providers[providerId] = total;
      if (Object.keys(split).length > 0) {
        models[providerId] = split;
        // The two providers with a demo opt-in (Claude, OpenAI): a plausible cost estimate,
        // computed from the very same split by model rather than a whole separate reading.
        const cost = costOfSplit(split);
        if (cost) {
          costs[providerId] = cost.total;
          modelCosts[providerId] = cost.byModel;
        }
      }
    }

    const daysBody: Record<string, unknown> = {};
    for (const date of [...days.keys()].sort()) {
      const day = days.get(date)!;
      const dayModels = Object.fromEntries(
        Object.entries(day.models).filter(([, split]) => Object.keys(split).length > 0),
      );
      const dayHours = Object.fromEntries(
        Object.entries(day.hours).filter(([, hours]) => Object.keys(hours).length > 0),
      );
      daysBody[date] = {
        providers: day.providers,
        ...(Object.keys(dayModels).length > 0 && { models: dayModels }),
        ...(Object.keys(dayHours).length > 0 && { hours: dayHours }),
      };
    }

    return {
      machineId: machine.id,
      timestampMs: moment,
      body: {
        machineId: machine.id,
        groupId: machine.groupId,
        providers,
        ...(Object.keys(models).length > 0 && { models }),
        ...(Object.keys(daysBody).length > 0 && { days: daysBody }),
        ...(Object.keys(costs).length > 0 && { costs }),
        ...(Object.keys(modelCosts).length > 0 && { modelCosts }),
        timestamp: new Date(moment).toISOString(),
      },
    };
  };

  const reports = DEMO_MACHINES.flatMap((machine, machineIndex) =>
    schedules[machineIndex]!.map((moment) => reportAt(machine, machineIndex, moment)),
  ).sort((a, b) => a.timestampMs - b.timestampMs || a.machineId.localeCompare(b.machineId));

  const settings: SettingsUpdate = {
    settings: {
      period: reset.period,
      useTokenLimits: false,
      limits: Object.fromEntries(DEMO_PROVIDERS.map((provider) => [provider.id, provider.limit])),
      reset: {
        weekday: reset.weekday,
        monthDay: reset.monthDay,
        hour: reset.hour,
        minute: reset.minute,
        timeZone: reset.timeZone,
      },
      showRemaining: true,
      hiddenProviders: [],
      excludedProviders: { Lab: ["openai"] },
      subLimits: {
        claude: [{ id: "fable", name: "Fable", models: ["fable"], mode: "share", sharePercent: 40, limit: 200_000 }],
      },
    },
    groups: DEMO_GROUPS.map((group) => ({ id: group.id, color: group.color })),
    removedGroups: [],
  };

  const cycleStartMs = current.start.getTime();
  const official: DemoOfficialEntry[] = [
    { providerId: "claude", subLimitId: null, raw: "62.5", cycleStartMs, enteredAtMs: nowMs - 2 * HOUR_MS },
    { providerId: "claude", subLimitId: "fable", raw: "48", cycleStartMs, enteredAtMs: nowMs - 2 * HOUR_MS },
  ];

  const history = buildDemoHistory(previous, reset, seed);

  return { timeZone, reset, cycles: { current, previous }, settings, reports, official, history };
}

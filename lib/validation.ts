import { getDayEnd, getDayStart } from "@/lib/cycle";
import { HOUR_MS, MAX_DAY_HOURS, MAX_REPORT_DAYS } from "@/lib/days";
import { MAX_MODELS_PER_PROVIDER, MAX_MODELS_PER_REPORT, normalizeModelId } from "@/lib/models";
import { MAX_PROVIDERS, normalizeProviderId } from "@/lib/providers";

/** One calendar day of a report's snapshot. */
export interface DayUsage {
  /** "YYYY-MM-DD", in the cycle's time zone (the client got it from GET /api/usage). */
  date: string;
  /** The providers' tokens used that day; each is in the report's `providers`. */
  providers: Record<string, number>;
  /** Those tokens split by model, like the report's `models`. */
  models: Record<string, Record<string, number>>;
  /** Some providers' tokens that day by clock hour, oldest first: providerId → hours. */
  hours: Record<string, HourUsage[]>;
}

export interface HourUsage {
  /** The start of the clock hour, epoch ms. */
  startMs: number;
  tokens: number;
}

/** How a client is scheduled to report; decides its machine's health on the dashboard. */
export type ReportMode = "auto" | "manual";

/** A validated multi-provider snapshot, as sent by the client scripts. */
export interface UsageReport {
  machineId: string;
  groupId: string;
  /** Empty (`{}`) is a heartbeat: a fresh machine with nothing to report yet. */
  providers: Record<string, number>;
  /**
   * The providers' tokens split by model: providerId → modelId → tokens. Empty
   * for clients that do not send a split; a provider may be missing from it.
   */
  models: Record<string, Record<string, number>>;
  /**
   * `providers` split by calendar day, oldest first: see lib/days.ts. Empty
   * for clients that do not send the split.
   */
  days: DayUsage[];
  /**
   * An API-list-price estimate of what the tokens would have cost, in USD,
   * cycle-to-date: providerId → dollars. Only from a client that opted in
   * (lib/setup.ts COST); empty `{}` otherwise, or from an older client that
   * never sends it. Fictional for a subscription plan (Claude Max, ChatGPT
   * Pro...) — the dashboard must label it as an estimate, never a bill.
   */
  costs: Record<string, number>;
  /**
   * `costs` split by model, like `models`: providerId → modelId → dollars.
   * Empty for clients that do not send one, or did not opt into cost at all.
   */
  modelCosts: Record<string, Record<string, number>>;
  /** Event time in epoch milliseconds. */
  timestampMs: number;
  /** Event time normalized to UTC ISO 8601. */
  timestamp: string;
  /**
   * Optional (and treated as "auto" wherever it is read) so code building a
   * `UsageReport` outside `parseUsageReport` — tests, mainly — need not set it.
   * `parseUsageReport` always fills it in: "auto" when the client's own field
   * is absent (older clients, and the one-shot report, only ever ran manually).
   */
  mode?: ReportMode;
  /** The auto client's own reporting interval in minutes; absent/null unless `mode` is "auto". */
  intervalMinutes?: number | null;
}

export type ParseResult = { ok: true; report: UsageReport } | { ok: false; errors: string[] };

export interface ParseOptions {
  now: Date;
  maxClockSkewMinutes: number;
  retentionDays: number;
  /** The one the clients split their days in: every hour of a day must lie inside it. */
  timeZone: string;
}

const MAX_ID_LENGTH = 64;
// Letters and digits of any script, plus space . _ - (the ids end up in Redis key names).
const ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/;
const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** A machine or group id, trimmed. Problems are appended to `errors` under the name `field`. */
export function parseId(value: unknown, field: string, errors: string[]): string {
  if (typeof value !== "string") {
    errors.push(`${field} must be a string`);
    return "";
  }
  const id = value.trim();
  if (id.length === 0 || id.length > MAX_ID_LENGTH) {
    errors.push(`${field} must be 1-${MAX_ID_LENGTH} characters long`);
  } else if (!ID_PATTERN.test(id)) {
    errors.push(`${field} may only contain letters, digits, spaces, dots, dashes and underscores`);
  }
  return id;
}

/** Strict ISO 8601 date-time with a zone designator → epoch ms, or null. */
export function parseIsoTimestamp(value: string): number | null {
  const match = ISO_PATTERN.exec(value);
  if (!match) return null;

  const [, y, mo, d, h, mi, s = "0", fraction = "", zone = "Z"] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const millisecond = Number(fraction.padEnd(3, "0").slice(0, 3));
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;

  let offsetMinutes = 0;
  if (zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMins = Number(zone.slice(4, 6));
    if (offsetHours > 14 || offsetMins > 59) return null;
    offsetMinutes = (zone.startsWith("-") ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }

  const wallClock = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  // Date.UTC silently rolls "Feb 30" over into March; reject instead.
  if (new Date(wallClock).getUTCDate() !== day) return null;
  return wallClock - offsetMinutes * 60_000;
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** "YYYY-MM-DD" naming a day that exists. */
function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * A `{ provider: tokens }` object, found in the body under the name `field`.
 * Empty (`{}`) is accepted: a heartbeat from a fresh machine with nothing to
 * report yet (lib/ingest.ts / lib/usage-store.ts `storeReport` register its
 * group and nothing else for it).
 */
function parseProviders(input: unknown, field: string, errors: string[]): Record<string, number> {
  const providers: Record<string, number> = {};
  if (!isObject(input)) {
    errors.push(`${field} must be a JSON object`);
    return providers;
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_PROVIDERS) {
    errors.push(`${field} must contain at most ${MAX_PROVIDERS} entries`);
  }
  for (const [rawProvider, tokens] of entries) {
    const provider = normalizeProviderId(rawProvider);
    if (!provider) {
      errors.push(`provider ${JSON.stringify(rawProvider)} must be 1-64 letters, digits, dots, dashes or underscores`);
    } else if (Object.hasOwn(providers, provider)) {
      errors.push(`provider ${JSON.stringify(rawProvider)} is listed twice after normalization`);
    } else if (!isTokenCount(tokens)) {
      errors.push(`${field}.${rawProvider} must be a non-negative integer (a JSON number)`);
    } else {
      providers[provider] = tokens;
    }
  }
  return providers;
}

/**
 * The optional `models` object: `{ "claude": { "claude-opus-4-5": 1200 } }`.
 * Every provider in it must be in `providers` too, and its models may not add
 * up to more than the provider's own total (they may to less: not every
 * token can be tied to a model).
 */
function parseModels(
  input: unknown,
  providers: Record<string, number>,
  errors: string[],
  field = "models",
  providersField = "providers",
): Record<string, Record<string, number>> {
  const models: Record<string, Record<string, number>> = {};
  if (input === undefined) return models;
  if (!isObject(input)) {
    errors.push(`${field} must be a JSON object`);
    return models;
  }

  let count = 0;
  for (const [rawProvider, rawModels] of Object.entries(input)) {
    const provider = normalizeProviderId(rawProvider);
    if (!provider || !Object.hasOwn(providers, provider)) {
      errors.push(`${field}.${rawProvider} must name a provider listed in ${providersField}`);
      continue;
    }
    if (Object.hasOwn(models, provider)) {
      errors.push(`${field}.${rawProvider} is listed twice after normalization`);
      continue;
    }
    if (!isObject(rawModels)) {
      errors.push(`${field}.${rawProvider} must be a JSON object`);
      continue;
    }

    const entries = Object.entries(rawModels);
    if (entries.length > MAX_MODELS_PER_PROVIDER) {
      errors.push(`${field}.${rawProvider} may contain at most ${MAX_MODELS_PER_PROVIDER} models`);
      continue;
    }
    count += entries.length;

    const split: Record<string, number> = {};
    let sum = 0;
    for (const [rawModel, tokens] of entries) {
      const model = normalizeModelId(rawModel);
      if (!model) {
        errors.push(`model ${JSON.stringify(rawModel)} must be 1-64 letters, digits, dots, dashes or underscores`);
      } else if (Object.hasOwn(split, model)) {
        errors.push(`model ${JSON.stringify(rawModel)} is listed twice after normalization`);
      } else if (!isTokenCount(tokens)) {
        errors.push(`${field}.${rawProvider}.${rawModel} must be a non-negative integer (a JSON number)`);
      } else {
        split[model] = tokens;
        sum += tokens;
      }
    }
    if (sum > providers[provider]!) {
      errors.push(`${field}.${rawProvider} adds up to more tokens than ${providersField}.${rawProvider}`);
    }
    models[provider] = split;
  }

  if (count > MAX_MODELS_PER_REPORT) {
    errors.push(`${field} may contain at most ${MAX_MODELS_PER_REPORT} models in total`);
  }
  return models;
}

// A subscription is never billed by the token, so this is generous headroom for an
// API-list-price estimate, not a real budget: it only guards against a garbled report.
const MAX_COST_USD = 1e7;
// Rounding across many models' costs (each already rounded to 4 decimals by the
// client) may push their sum a hair past the provider's own total.
const COST_EPSILON = 0.01;

function isCostAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_COST_USD;
}

/**
 * The optional `costs` object: `{ "claude": 12.3456 }`, providerId → USD,
 * cycle-to-date. Every provider in it must be one already in `providers`.
 */
function parseCosts(input: unknown, providers: Record<string, number>, errors: string[]): Record<string, number> {
  const costs: Record<string, number> = {};
  if (input === undefined) return costs;
  if (!isObject(input)) {
    errors.push("costs must be a JSON object");
    return costs;
  }

  for (const [rawProvider, amount] of Object.entries(input)) {
    const provider = normalizeProviderId(rawProvider);
    if (!provider || !Object.hasOwn(providers, provider)) {
      errors.push(`costs.${rawProvider} must name a provider listed in providers`);
    } else if (Object.hasOwn(costs, provider)) {
      errors.push(`costs.${rawProvider} is listed twice after normalization`);
    } else if (!isCostAmount(amount)) {
      errors.push(`costs.${rawProvider} must be a non-negative number of at most ${MAX_COST_USD} (a JSON number)`);
    } else {
      costs[provider] = amount;
    }
  }
  return costs;
}

/**
 * The optional `modelCosts` object: `{ "claude": { "claude-opus-4-5": 8.5 } }`.
 * Every provider in it must be in `costs` too, capped like `models`, and its
 * models may not add up to more than the provider's own cost there (past a
 * small epsilon of rounding slack).
 */
function parseModelCosts(
  input: unknown,
  costs: Record<string, number>,
  errors: string[],
): Record<string, Record<string, number>> {
  const modelCosts: Record<string, Record<string, number>> = {};
  if (input === undefined) return modelCosts;
  if (!isObject(input)) {
    errors.push("modelCosts must be a JSON object");
    return modelCosts;
  }

  for (const [rawProvider, rawModels] of Object.entries(input)) {
    const provider = normalizeProviderId(rawProvider);
    if (!provider || !Object.hasOwn(costs, provider)) {
      errors.push(`modelCosts.${rawProvider} must name a provider listed in costs`);
      continue;
    }
    if (Object.hasOwn(modelCosts, provider)) {
      errors.push(`modelCosts.${rawProvider} is listed twice after normalization`);
      continue;
    }
    if (!isObject(rawModels)) {
      errors.push(`modelCosts.${rawProvider} must be a JSON object`);
      continue;
    }

    const entries = Object.entries(rawModels);
    if (entries.length > MAX_MODELS_PER_PROVIDER) {
      errors.push(`modelCosts.${rawProvider} may contain at most ${MAX_MODELS_PER_PROVIDER} models`);
      continue;
    }

    const split: Record<string, number> = {};
    let sum = 0;
    for (const [rawModel, amount] of entries) {
      const model = normalizeModelId(rawModel);
      if (!model) {
        errors.push(`model ${JSON.stringify(rawModel)} must be 1-64 letters, digits, dots, dashes or underscores`);
      } else if (Object.hasOwn(split, model)) {
        errors.push(`model ${JSON.stringify(rawModel)} is listed twice after normalization`);
      } else if (!isCostAmount(amount)) {
        errors.push(
          `modelCosts.${rawProvider}.${rawModel} must be a non-negative number of at most ${MAX_COST_USD} (a JSON number)`,
        );
      } else {
        split[model] = amount;
        sum += amount;
      }
    }
    if (sum > costs[provider]! + COST_EPSILON) {
      errors.push(`modelCosts.${rawProvider} adds up to more cost than costs.${rawProvider}`);
    }
    modelCosts[provider] = split;
  }
  return modelCosts;
}

/**
 * A day's optional `hours`: `{ "claude": { "2026-09-21T08:00:00Z": 300 } }`,
 * each key the start of a clock hour of that day (in UTC). Every provider in
 * it must be one of the day's, and its hours may not add up to more than its
 * day (they may to less on the day in progress).
 */
function parseHours(
  input: unknown,
  date: string,
  providers: Record<string, number>,
  field: string,
  timeZone: string,
  errors: string[],
): Record<string, HourUsage[]> {
  const hours: Record<string, HourUsage[]> = {};
  if (input === undefined) return hours;
  if (!isObject(input)) {
    errors.push(`${field} must be a JSON object`);
    return hours;
  }
  const dayStartMs = getDayStart(date, timeZone).getTime();
  const dayEndMs = getDayEnd(date, timeZone).getTime();

  for (const [rawProvider, rawHours] of Object.entries(input)) {
    const provider = normalizeProviderId(rawProvider);
    if (!provider || !Object.hasOwn(providers, provider)) {
      errors.push(`${field}.${rawProvider} must name a provider of the day`);
      continue;
    }
    if (Object.hasOwn(hours, provider)) {
      errors.push(`${field}.${rawProvider} is listed twice after normalization`);
      continue;
    }
    if (!isObject(rawHours)) {
      errors.push(`${field}.${rawProvider} must be a JSON object`);
      continue;
    }
    const entries = Object.entries(rawHours);
    if (entries.length > MAX_DAY_HOURS) {
      errors.push(`${field}.${rawProvider} may contain at most ${MAX_DAY_HOURS} hours`);
      continue;
    }

    const list: HourUsage[] = [];
    let sum = 0;
    for (const [key, tokens] of entries) {
      const startMs = HOUR_PATTERN.test(key) ? Date.parse(key) : NaN;
      if (!Number.isFinite(startMs) || new Date(startMs).toISOString() !== key.replace("Z", ".000Z")) {
        errors.push(
          `${field}.${rawProvider} must be keyed by hours like "2026-09-21T08:00:00Z", got ${JSON.stringify(key)}`,
        );
      } else if (startMs < dayStartMs || startMs + HOUR_MS > dayEndMs) {
        errors.push(`${field}.${rawProvider}.${key} is not an hour of ${date} in ${timeZone}`);
      } else if (!isTokenCount(tokens)) {
        errors.push(`${field}.${rawProvider}.${key} must be a non-negative integer (a JSON number)`);
      } else {
        list.push({ startMs, tokens });
        sum += tokens;
      }
    }
    if (sum > providers[provider]!) {
      errors.push(`${field}.${rawProvider} adds up to more tokens than the day`);
    }
    hours[provider] = list.sort((a, b) => a.startMs - b.startMs);
  }
  return hours;
}

/**
 * The optional `days` object: the `providers` snapshot split by calendar day,
 * `{ "2026-09-21": { "providers": { "claude": 900 }, "models": { "claude": { "claude-opus-4-5": 800 } },
 * "hours": { "claude": { "2026-09-21T08:00:00Z": 300, "2026-09-21T09:00:00Z": 600 } } } }`.
 * Every provider of a day must be in `providers`, and a provider's days may
 * not add up to more than its total there.
 */
function parseDays(input: unknown, providers: Record<string, number>, timeZone: string, errors: string[]): DayUsage[] {
  if (input === undefined) return [];
  if (!isObject(input)) {
    errors.push("days must be a JSON object");
    return [];
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_REPORT_DAYS) {
    errors.push(`days may contain at most ${MAX_REPORT_DAYS} days`);
    return [];
  }

  const days: DayUsage[] = [];
  const totals: Record<string, number> = {};
  for (const [date, rawDay] of entries) {
    const field = `days.${date}`;
    if (!isCalendarDate(date)) {
      errors.push(`days must be keyed by dates like "2026-09-21", got ${JSON.stringify(date)}`);
      continue;
    }
    if (!isObject(rawDay)) {
      errors.push(`${field} must be a JSON object`);
      continue;
    }
    const dayProviders = parseProviders(rawDay.providers, `${field}.providers`, errors);
    for (const [provider, tokens] of Object.entries(dayProviders)) {
      if (!Object.hasOwn(providers, provider)) {
        errors.push(`${field}.providers.${provider} must name a provider listed in providers`);
      }
      totals[provider] = (totals[provider] ?? 0) + tokens;
    }
    const models = parseModels(rawDay.models, dayProviders, errors, `${field}.models`, `${field}.providers`);
    const hours = parseHours(rawDay.hours, date, dayProviders, `${field}.hours`, timeZone, errors);
    days.push({ date, providers: dayProviders, models, hours });
  }

  for (const [provider, total] of Object.entries(totals)) {
    if (Object.hasOwn(providers, provider) && total > providers[provider]!) {
      errors.push(`days add up to more tokens than providers.${provider}`);
    }
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
}

const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 1440;

/** Optional; "auto" (what every machine health check treats a missing field as) when absent. */
function parseReportMode(input: unknown, errors: string[]): ReportMode {
  if (input === undefined) return "auto";
  if (input === "auto" || input === "manual") return input;
  errors.push('mode must be "auto" or "manual"');
  return "auto";
}

/**
 * Optional; null when absent. An auto client's own reporting interval, in
 * minutes: lib/dashboard.ts machine health uses it instead of the server's
 * default when present, so a machine on a non-default schedule (a custom
 * install-task.ps1 -IntervalMinutes) is not flagged "late" between reports.
 */
function parseIntervalMinutes(input: unknown, errors: string[]): number | null {
  if (input === undefined) return null;
  if (
    typeof input === "number" &&
    Number.isInteger(input) &&
    input >= MIN_INTERVAL_MINUTES &&
    input <= MAX_INTERVAL_MINUTES
  ) {
    return input;
  }
  errors.push(
    `intervalMinutes must be a whole number of minutes between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`,
  );
  return null;
}

/** Validates the JSON body of POST /api/usage. */
export function parseUsageReport(input: unknown, options: ParseOptions): ParseResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const body = input as Record<string, unknown>;
  const errors: string[] = [];

  const machineId = parseId(body.machineId, "machineId", errors);
  const groupId = parseId(body.groupId, "groupId", errors);

  const providers = parseProviders(body.providers, "providers", errors);
  const models = parseModels(body.models, providers, errors);
  const days = parseDays(body.days, providers, options.timeZone, errors);
  const costs = parseCosts(body.costs, providers, errors);
  const modelCosts = parseModelCosts(body.modelCosts, costs, errors);
  const mode = parseReportMode(body.mode, errors);
  const intervalMinutes = parseIntervalMinutes(body.intervalMinutes, errors);

  let timestampMs: number | null = null;
  if (typeof body.timestamp === "string") timestampMs = parseIsoTimestamp(body.timestamp.trim());
  if (timestampMs === null) {
    errors.push('timestamp must be an ISO 8601 date-time with a zone, e.g. "2026-09-21T10:00:00Z"');
  } else {
    const nowMs = options.now.getTime();
    if (timestampMs > nowMs + options.maxClockSkewMinutes * 60_000) {
      errors.push(
        `timestamp is more than ${options.maxClockSkewMinutes} minutes in the future (check the machine's clock)`,
      );
    } else if (timestampMs < nowMs - options.retentionDays * 86_400_000) {
      errors.push(`timestamp is older than the ${options.retentionDays}-day retention window`);
    }
  }

  if (errors.length > 0 || timestampMs === null) return { ok: false, errors };
  return {
    ok: true,
    report: {
      machineId,
      groupId,
      providers,
      models,
      days,
      costs,
      modelCosts,
      timestampMs,
      timestamp: new Date(timestampMs).toISOString(),
      mode,
      intervalMinutes,
    },
  };
}

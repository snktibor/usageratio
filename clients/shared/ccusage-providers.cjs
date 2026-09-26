#!/usr/bin/env node
"use strict";

/**
 * Converts ccusage's JSON output to the compact provider snapshot accepted by
 * /api/usage, and to its optional splits by model, by day and (for Claude Code,
 * from `ccusage blocks`) by hour. Kept in one dependency-free
 * file so Bash and PowerShell use the exact same classification rules. Node
 * is already required by npx/ccusage.
 */

const fs = require("node:fs");

const MAX_PROVIDERS = 20;
// The server's limits for the optional split by model (lib/models.ts).
const MAX_MODELS_PER_PROVIDER = 20;
const MAX_MODELS = 60;
// The server's limit for the optional split by day (lib/days.ts): a monthly cycle touches up to 32 days.
const MAX_DAYS = 32;
// The split by day (with its hours) stays well inside the server's 64 KB body limit, next to everything else.
const MAX_DAYS_BYTES = 48_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HOUR_MS = 3_600_000;

function asObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function tokenNumber(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function tokenTotal(value) {
  const item = asObject(value);
  if (!item) return 0;

  for (const key of ["totalTokens", "total_tokens", "tokens"]) {
    const total = tokenNumber(item[key]);
    if (total !== null) return total;
  }

  let found = false;
  let total = 0;
  for (const key of [
    "inputTokens",
    "input_tokens",
    "outputTokens",
    "output_tokens",
    "cacheCreationTokens",
    "cache_creation_tokens",
    "cacheReadTokens",
    "cache_read_tokens",
  ]) {
    const amount = tokenNumber(item[key]);
    if (amount !== null) {
      found = true;
      total += amount;
    }
  }
  if (!Number.isSafeInteger(total)) throw new Error("ccusage token total exceeds JavaScript's safe integer range");
  return found ? total : 0;
}

function slug(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\[.+?\]\s*/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
}

/** Prefer the actual model vendor; use the collecting agent only as fallback. */
function providerFrom(value, fallback = "") {
  const text = String(value ?? "").toLowerCase();
  if (/deepseek/.test(text)) return "deepseek";
  if (/claude|anthropic/.test(text)) return "claude";
  if (/openai|chatgpt|codex|gpt[-_. ]?\d|(^|[^a-z])o[134]($|[-_. ])/i.test(text)) return "openai";
  if (/gemini|google[-_. /]?(ai)?/.test(text)) return "gemini";
  if (/grok|xai|x-ai/.test(text)) return "xai";
  if (/qwen|alibaba/.test(text)) return "qwen";
  if (/kimi|moonshot/.test(text)) return "kimi";
  if (/mistral|codestral/.test(text)) return "mistral";
  if (/llama|meta[-_. /]?ai/.test(text)) return "meta";

  const source = slug(fallback || value);
  const aliases = {
    anthropic: "claude",
    claude: "claude",
    codex: "openai",
    openai: "openai",
    gemini: "gemini",
    google: "gemini",
    grok: "xai",
    qwen: "qwen",
    kimi: "kimi",
  };
  return aliases[source] || source || "unknown";
}

function breakdownsOf(value) {
  const item = asObject(value);
  if (!item) return [];
  if (Array.isArray(item.modelBreakdowns)) return item.modelBreakdowns;
  if (Array.isArray(item.model_breakdowns)) return item.model_breakdowns;

  const breakdown = asObject(item.breakdown);
  if (!breakdown) return [];
  return Object.entries(breakdown).map(([modelName, totals]) => ({
    ...(asObject(totals) || {}),
    modelName,
  }));
}

function add(providers, provider, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error(`invalid token count for provider ${provider}`);
  }
  const next = (providers.get(provider) || 0) + amount;
  if (!Number.isSafeInteger(next)) throw new Error(`token total for provider ${provider} is too large`);
  providers.set(provider, next);
}

/** `models`: provider → Map(model → tokens). Tokens that cannot be tied to one model stay out of it. */
function addModel(models, provider, modelName, amount) {
  const model = slug(modelName);
  if (!model || amount === 0) return;
  const byModel = models.get(provider) || new Map();
  models.set(provider, byModel);
  add(byModel, model, amount);
}

function addUsage(usage, value, inheritedSource = "") {
  const item = asObject(value);
  if (!item) return;
  const source = item.provider ?? item.providerName ?? item.vendor ?? item.agent ?? item.source ?? inheritedSource;
  const breakdowns = breakdownsOf(item);

  if (breakdowns.length > 0) {
    for (const entry of breakdowns) {
      const detail = asObject(entry) || {};
      const modelName = detail.modelName ?? detail.model_name ?? detail.model ?? "";
      const model = detail.provider ?? detail.providerName ?? detail.vendor ?? modelName;
      const provider = providerFrom(model, source);
      const tokens = tokenTotal(detail);
      add(usage.providers, provider, tokens);
      addModel(usage.models, provider, modelName, tokens);
    }
    return;
  }

  const models = Array.isArray(item.modelsUsed) ? item.modelsUsed : Array.isArray(item.models) ? item.models : [];
  const provider = providerFrom(models[0] ?? source, source);
  const tokens = tokenTotal(item);
  add(usage.providers, provider, tokens);
  // Without a breakdown, a row's tokens belong to a model only when it used just the one.
  if (models.length === 1) addModel(usage.models, provider, models[0], tokens);
}

function reportRows(document) {
  if (Array.isArray(document.daily)) return document.daily;
  if (Array.isArray(document.data)) return document.data;
  if (Array.isArray(document)) return document;

  const projects = asObject(document.projects);
  if (projects) return Object.values(projects).flatMap((rows) => (Array.isArray(rows) ? rows : []));
  return [];
}

function normalizeProviderMap(input) {
  const value = asObject(input);
  if (!value) throw new Error("providers must be a JSON object");
  const providers = new Map();

  for (const [rawProvider, rawTokens] of Object.entries(value)) {
    const provider = slug(rawProvider);
    if (!provider) throw new Error(`invalid provider name: ${JSON.stringify(rawProvider)}`);
    if (providers.has(provider)) throw new Error(`provider is listed twice after normalization: ${provider}`);
    const tokens = tokenNumber(rawTokens);
    if (tokens === null) throw new Error(`provider ${provider} must have a non-negative whole token count`);
    providers.set(provider, tokens);
  }

  // Empty is accepted: a heartbeat, when ccusage found no usage and there was
  // no fallback provider to zero out either (a brand new machine's first report).
  if (providers.size > MAX_PROVIDERS) throw new Error(`providers contains more than ${MAX_PROVIDERS} entries`);
  return Object.fromEntries([...providers].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The provider split of a report ({ provider: model: tokens }), cut to the
 * server's limits by dropping the smallest models: their tokens still count
 * in the provider totals, just not under a model. Providers not in
 * `providers` are dropped.
 */
function normalizeModelMap(input, providers) {
  const value = asObject(input) || {};
  const entries = [];
  for (const [rawProvider, rawModels] of Object.entries(value)) {
    const provider = slug(rawProvider);
    if (!provider || !Object.hasOwn(providers, provider)) continue;
    for (const [rawModel, rawTokens] of Object.entries(asObject(rawModels) || {})) {
      const model = slug(rawModel);
      const tokens = tokenNumber(rawTokens);
      if (model && tokens !== null && tokens > 0) entries.push({ provider, model, tokens });
    }
  }
  entries.sort((a, b) => b.tokens - a.tokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));

  const models = {};
  let count = 0;
  for (const { provider, model, tokens } of entries) {
    const byModel = models[provider] || (models[provider] = {});
    if (count === MAX_MODELS || Object.keys(byModel).length === MAX_MODELS_PER_PROVIDER) continue;
    if (Object.hasOwn(byModel, model)) continue;
    byModel[model] = tokens;
    count += 1;
  }

  const sorted = {};
  for (const provider of Object.keys(models).sort()) {
    const byModel = Object.entries(models[provider]).sort(([a], [b]) => a.localeCompare(b));
    const total = byModel.reduce((sum, [, tokens]) => sum + tokens, 0);
    // A split may not claim more tokens than its provider has; such a split is left out whole.
    if (byModel.length > 0 && total <= providers[provider]) sorted[provider] = Object.fromEntries(byModel);
  }
  return sorted;
}

function newUsage() {
  return { providers: new Map(), models: new Map() };
}

/** One row of a report (a day of a daily report, or a row of an older format) into `usage`. */
function addRow(usage, item, documentSource) {
  if (Array.isArray(item.agents) && item.agents.length > 0) {
    for (const agent of item.agents) addUsage(usage, agent, item.agent ?? item.source ?? documentSource);
  } else {
    addUsage(usage, item, documentSource);
  }
}

function mergeUsage(target, part) {
  for (const [provider, tokens] of part.providers) add(target.providers, provider, tokens);
  for (const [provider, byModel] of part.models) {
    const targetModels = target.models.get(provider) || new Map();
    target.models.set(provider, targetModels);
    for (const [model, tokens] of byModel) add(targetModels, model, tokens);
  }
}

function modelObject(models) {
  return Object.fromEntries([...models].map(([provider, byModel]) => [provider, Object.fromEntries(byModel)]));
}

/** A daily row's calendar day ("YYYY-MM-DD"), or "" for rows without one. */
function rowDate(item) {
  for (const key of ["period", "date", "day"]) {
    const value = item[key];
    if (typeof value === "string" && DATE_PATTERN.test(value)) return value;
  }
  return "";
}

const dateFormatters = new Map();

/** The calendar day ("YYYY-MM-DD") an instant falls on in `timeZone`. */
function localDate(ms, timeZone) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(timeZone, formatter);
  }
  const parts = {};
  for (const part of formatter.formatToParts(new Date(ms))) parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** "2026-09-19T11:00:00Z": how the server expects an hour. */
function hourKey(startMs) {
  return new Date(startMs).toISOString().replace(".000Z", "Z");
}

function sumTokens(hours) {
  return hours.reduce((total, hour) => total + hour.tokens, 0);
}

/**
 * ccusage's one-hour blocks (`blocks --session-length 1`, which only sees
 * Claude Code) → Map(date → Map(provider → [{ startMs, tokens }])), plus the
 * "date provider" pairs whose blocks cannot be pinned down: a block that used
 * models of two providers, or one that runs over midnight (a time zone off
 * UTC by half an hour). Null when the blocks are not whole clock hours, as
 * from a ccusage that ignored --session-length.
 */
function hourlyBlocks(input, timeZone) {
  const blocks = asObject(input)?.blocks;
  if (!Array.isArray(blocks)) return null;
  const byDate = new Map();
  const unclear = new Set();

  for (const raw of blocks) {
    const block = asObject(raw);
    if (!block || block.isGap === true) continue;
    const startMs = Date.parse(block.startTime);
    const endMs = Date.parse(block.endTime);
    if (!Number.isFinite(startMs) || endMs - startMs !== HOUR_MS || startMs % HOUR_MS !== 0) return null;
    const tokens = tokenTotal(block);
    if (tokens === 0) continue;

    const models = Array.isArray(block.models) ? block.models : [];
    const providers = new Set(models.map((model) => providerFrom(model, "claude")));
    if (providers.size === 0) providers.add("claude");
    const date = localDate(startMs, timeZone);
    const lastDate = localDate(endMs - 1, timeZone);
    if (providers.size > 1 || date !== lastDate) {
      for (const provider of providers) {
        unclear.add(`${date} ${provider}`);
        unclear.add(`${lastDate} ${provider}`);
      }
      continue;
    }

    const [provider] = providers;
    const byProvider = byDate.get(date) || new Map();
    byDate.set(date, byProvider);
    const hours = byProvider.get(provider) || [];
    byProvider.set(provider, hours);
    hours.push({ startMs, tokens });
  }
  return { byDate, unclear };
}

/** Takes `amount` of `provider`'s tokens off `usage`, and scales its split by model down to what is left. */
function trimProvider(usage, provider, amount) {
  const total = usage.providers.get(provider) || 0;
  const left = total - amount;
  usage.providers.set(provider, left);
  const byModel = usage.models.get(provider);
  if (!byModel || total === 0) return;
  for (const [model, tokens] of byModel) {
    // Integer arithmetic: the scaled models never add up to more than what is left.
    byModel.set(model, Number((BigInt(tokens) * BigInt(left)) / BigInt(total)));
  }
}

/**
 * Lays the one-hour blocks of `hourly` over the days of a daily report
 * (`days`: date → usage, changed in place) and returns each day's hours by
 * provider. The blocks are read a moment before the daily report, so on the
 * last day they may miss a little of the hour in progress; on every other
 * day a provider's hours are kept only when they add up to its day exactly
 * (another agent may have used the same provider's models).
 *
 * On the day of the reset, the hours before the cycle's start are taken off
 * the provider's day, so they no longer count in both cycles; the day's split
 * by model is scaled down in proportion (the blocks carry no split of their
 * own). The providers without hours keep the whole day.
 */
function applyHourly(days, hourly) {
  const hoursByDate = new Map();
  const blocks = hourly && hourlyBlocks(hourly.blocks, hourly.timeZone);
  if (!blocks) return hoursByDate;
  const firstDate = localDate(hourly.cycleStartMs, hourly.timeZone);
  const lastDate = [...days.keys()].sort().at(-1);

  for (const [date, usage] of days) {
    for (const [provider, blockHours] of blocks.byDate.get(date) || []) {
      const total = usage.providers.get(provider) || 0;
      const blockTotal = sumTokens(blockHours);
      // More in the blocks than in the day: not the same reading, so neither is trusted.
      if (blockTotal > total) continue;

      let hours = blockHours;
      if (date === firstDate) {
        const before = sumTokens(blockHours.filter((hour) => hour.startMs + HOUR_MS <= hourly.cycleStartMs));
        if (before > 0) trimProvider(usage, provider, before);
        hours = blockHours.filter((hour) => hour.startMs + HOUR_MS > hourly.cycleStartMs);
      }

      const complete = blockTotal === total || date === lastDate;
      if (!complete || blocks.unclear.has(`${date} ${provider}`) || hours.length === 0) continue;
      const byProvider = hoursByDate.get(date) || new Map();
      hoursByDate.set(date, byProvider);
      byProvider.set(provider, hours);
    }
  }
  return hoursByDate;
}

/** A report's rows gathered by calendar day (and those without one), with `hourly` laid over the days. */
function collectUsage(input, hourly) {
  const document = asObject(input) || (Array.isArray(input) ? input : null);
  if (!document) throw new Error("ccusage did not return a JSON object");
  const documentSource = document.agent ?? document.source ?? document.provider ?? "";
  const days = new Map();
  const undated = newUsage();

  for (const row of reportRows(document)) {
    const item = asObject(row);
    if (!item) continue;
    const date = rowDate(item);
    let usage = undated;
    if (date) {
      usage = days.get(date) || newUsage();
      days.set(date, usage);
    }
    addRow(usage, item, documentSource);
  }
  return { document, documentSource, days, undated, hoursByDate: applyHourly(days, hourly) };
}

/** { "YYYY-MM-DD": { providers, models?, hours? } }, days without tokens left out. */
function dayMap(days, hoursByDate) {
  const result = {};
  for (const date of [...days.keys()].sort()) {
    const usage = days.get(date);
    const providers = Object.fromEntries(
      [...usage.providers].filter(([, tokens]) => tokens > 0).sort(([a], [b]) => a.localeCompare(b)),
    );
    if (Object.keys(providers).length === 0) continue;
    const day = { providers };
    const models = normalizeModelMap(modelObject(usage.models), providers);
    if (Object.keys(models).length > 0) day.models = models;

    const hours = {};
    for (const [provider, list] of [...(hoursByDate.get(date) || [])].sort(([a], [b]) => a.localeCompare(b))) {
      if (!Object.hasOwn(providers, provider)) continue;
      const sorted = [...list].sort((a, b) => a.startMs - b.startMs);
      hours[provider] = Object.fromEntries(sorted.map((hour) => [hourKey(hour.startMs), hour.tokens]));
    }
    if (Object.keys(hours).length > 0) day.hours = hours;
    result[date] = day;
  }
  return result;
}

/**
 * ccusage's daily JSON → { providers: { provider: tokens }, models: { provider: { model: tokens } } }.
 * `hourly` ({ blocks, cycleStartMs, timeZone }, optional) lays Claude Code's
 * hours over the days first: see applyHourly.
 */
function parseCcusageUsage(input, fallbackProviders = [], hourly = null) {
  const { document, documentSource, days, undated } = collectUsage(input, hourly);
  const usage = newUsage();
  for (const part of [...days.values(), undated]) mergeUsage(usage, part);

  // Focused/older ccusage formats can contain only a totals/summary object.
  if (usage.providers.size === 0) {
    const totals = asObject(document.totals) || asObject(document.summary);
    if (totals && tokenTotal(totals) > 0) {
      addUsage(usage, totals, documentSource || "unknown");
    }
  }

  if (usage.providers.size === 0) {
    for (const fallback of fallbackProviders) add(usage.providers, providerFrom(fallback), 0);
  }

  const providers = normalizeProviderMap(Object.fromEntries(usage.providers));
  return { providers, models: normalizeModelMap(modelObject(usage.models), providers) };
}

function parseCcusageProviders(input, fallbackProviders = [], hourly = null) {
  return parseCcusageUsage(input, fallbackProviders, hourly).providers;
}

/**
 * ccusage's daily JSON → { "YYYY-MM-DD": { providers, models, hours } }: the
 * snapshot of parseCcusageUsage split by calendar day, and with `hourly`
 * Claude Code's days by hour too ({ provider: { "2026-09-19T11:00:00Z": tokens } }).
 * When it would not fit the server's limits, the days lose their split by
 * model first, then their hours, then the whole split is given up ({}): the
 * report itself goes out either way.
 */
function parseCcusageDays(input, hourly = null) {
  const { days, hoursByDate } = collectUsage(input, hourly);
  const split = dayMap(days, hoursByDate);
  if (Object.keys(split).length > MAX_DAYS) return {};

  const fits = (value) => Buffer.byteLength(JSON.stringify(value)) <= MAX_DAYS_BYTES;
  const without = (...keys) =>
    Object.fromEntries(
      Object.entries(split).map(([date, day]) => [
        date,
        Object.fromEntries(Object.entries(day).filter(([key]) => !keys.includes(key))),
      ]),
    );
  for (const candidate of [split, without("models"), without("models", "hours")]) {
    if (fits(candidate)) return candidate;
  }
  return {};
}

/** The `hourly` input of the parse commands; null when any part of it is missing or unreadable. */
function readHourly(blocksPath, cycleStart, timeZone) {
  if (!blocksPath || !cycleStart || !timeZone) return null;
  const cycleStartMs = Date.parse(cycleStart);
  if (!Number.isFinite(cycleStartMs)) return null;
  try {
    localDate(cycleStartMs, timeZone);
    const blocks = JSON.parse(fs.readFileSync(blocksPath, "utf8").replace(/^﻿/, ""));
    return { blocks, cycleStartMs, timeZone };
  } catch {
    return null;
  }
}

/** The split saved by `parse-models`; a missing or unreadable file only means no split is sent. */
function readModelFile(path, providers) {
  if (!path) return {};
  try {
    return normalizeModelMap(JSON.parse(fs.readFileSync(path, "utf8").replace(/^\uFEFF/, "")), providers);
  } catch {
    return {};
  }
}

/**
 * The split saved by `parse-days`, when it matches `providers`: every day's
 * providers listed there, no provider's days adding up to more than its
 * total, and no day's hours to more than the day. Anything else sends no
 * split by day at all.
 */
function readDaysFile(path, providers) {
  if (!path) return {};
  try {
    const days = asObject(JSON.parse(fs.readFileSync(path, "utf8").replace(/^\uFEFF/, "")));
    if (!days) return {};
    const totals = {};
    for (const [date, day] of Object.entries(days)) {
      const dayProviders = asObject(asObject(day)?.providers);
      if (!DATE_PATTERN.test(date) || !dayProviders) return {};
      for (const [provider, tokens] of Object.entries(dayProviders)) {
        if (!Object.hasOwn(providers, provider) || tokenNumber(tokens) === null) return {};
        totals[provider] = (totals[provider] || 0) + tokens;
      }
      const hours = asObject(day).hours;
      if (hours === undefined) continue;
      if (!asObject(hours)) return {};
      for (const [provider, byHour] of Object.entries(hours)) {
        const counts = Object.values(asObject(byHour) || {}).map(tokenNumber);
        if (!Object.hasOwn(dayProviders, provider) || counts.includes(null)) return {};
        if (counts.reduce((total, tokens) => total + tokens, 0) > dayProviders[provider]) return {};
      }
    }
    if (Object.entries(totals).some(([provider, total]) => total > providers[provider])) return {};
    return days;
  } catch {
    return {};
  }
}

function cycleField(input, field) {
  const document = asObject(input);
  const cycle = asObject(document?.cycle);
  const value = cycle?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`server response has no cycle.${field}`);
  }
  return value;
}

function cycleProviders(input) {
  const document = asObject(input);
  if (!Array.isArray(document?.providers)) throw new Error("server response has no providers array");
  return document.providers.map(slug).filter(Boolean).join(",");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const command = process.argv[2] || "parse";
  const raw = await readStdin();
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  // parse, parse-models, parse-days: <fallback providers> [<blocks file> <cycle start> <time zone>]
  const fallbacks = String(process.argv[3] ?? "")
    .split(",")
    .filter(Boolean);
  const hourly = readHourly(process.argv[4], process.argv[5], process.argv[6]);
  if (command === "parse") {
    process.stdout.write(JSON.stringify(parseCcusageProviders(parsed, fallbacks, hourly)));
    return;
  }
  if (command === "parse-models") {
    process.stdout.write(JSON.stringify(parseCcusageUsage(parsed, fallbacks, hourly).models));
    return;
  }
  if (command === "parse-days") {
    process.stdout.write(JSON.stringify(parseCcusageDays(parsed, hourly)));
    return;
  }
  if (command === "validate") {
    process.stdout.write(JSON.stringify(normalizeProviderMap(parsed)));
    return;
  }
  if (command === "count") {
    process.stdout.write(String(Object.keys(normalizeProviderMap(parsed)).length));
    return;
  }
  if (command === "payload") {
    const [, , , machineId, groupId, timestamp, modelFile, daysFile] = process.argv;
    if (!machineId || !groupId || !timestamp) throw new Error("payload needs machineId, groupId and timestamp");
    const providers = normalizeProviderMap(parsed);
    const models = readModelFile(modelFile, providers);
    const days = readDaysFile(daysFile, providers);
    const payload = { machineId, groupId, timestamp, providers };
    if (Object.keys(models).length > 0) payload.models = models;
    if (Object.keys(days).length > 0) payload.days = days;
    process.stdout.write(JSON.stringify(payload));
    return;
  }
  if (command === "cycle-start") {
    process.stdout.write(cycleField(parsed, "start"));
    return;
  }
  if (command === "cycle-since") {
    process.stdout.write(cycleField(parsed, "sinceDate"));
    return;
  }
  if (command === "cycle-timezone") {
    process.stdout.write(cycleField(parsed, "timeZone"));
    return;
  }
  if (command === "cycle-providers") {
    process.stdout.write(cycleProviders(parsed));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`ccusage parser: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  normalizeModelMap,
  normalizeProviderMap,
  parseCcusageDays,
  parseCcusageProviders,
  parseCcusageUsage,
  providerFrom,
  tokenTotal,
};

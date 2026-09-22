#!/usr/bin/env node
"use strict";

/**
 * Converts ccusage's JSON output to the compact provider snapshot accepted by
 * /api/usage, and to its optional splits by model and by day. Kept in one dependency-free
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
// The split by day stays well inside the server's 64 KB body limit, next to everything else.
const MAX_DAYS_BYTES = 40_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

  const models = Array.isArray(item.modelsUsed)
    ? item.modelsUsed
    : Array.isArray(item.models)
      ? item.models
      : [];
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

  if (providers.size === 0) throw new Error("providers is empty; ccusage did not return any usage source");
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

/** ccusage's JSON → { providers: { provider: tokens }, models: { provider: { model: tokens } } }. */
function parseCcusageUsage(input, fallbackProviders = []) {
  const document = asObject(input) || (Array.isArray(input) ? input : null);
  if (!document) throw new Error("ccusage did not return a JSON object");
  const usage = { providers: new Map(), models: new Map() };
  const documentSource = document.agent ?? document.source ?? document.provider ?? "";

  for (const row of reportRows(document)) {
    const item = asObject(row);
    if (!item) continue;
    if (Array.isArray(item.agents) && item.agents.length > 0) {
      for (const agent of item.agents) {
        addUsage(usage, agent, item.agent ?? item.source ?? documentSource);
      }
    } else {
      addUsage(usage, item, documentSource);
    }
  }

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
  const models = Object.fromEntries(
    [...usage.models].map(([provider, byModel]) => [provider, Object.fromEntries(byModel)]),
  );
  return { providers, models: normalizeModelMap(models, providers) };
}

function parseCcusageProviders(input, fallbackProviders = []) {
  return parseCcusageUsage(input, fallbackProviders).providers;
}

/** A daily row's calendar day ("YYYY-MM-DD"), or "" for rows without one. */
function rowDate(item) {
  for (const key of ["period", "date", "day"]) {
    const value = item[key];
    if (typeof value === "string" && DATE_PATTERN.test(value)) return value;
  }
  return "";
}

/**
 * ccusage's daily JSON → { "YYYY-MM-DD": { providers, models } }: the snapshot
 * of parseCcusageUsage split by calendar day. Days without tokens are left
 * out. When it would not fit the server's limits, the days lose their split
 * by model first, then the whole split is given up ({}): the report itself
 * goes out either way.
 */
function parseCcusageDays(input) {
  const document = asObject(input) || (Array.isArray(input) ? input : null);
  if (!document) throw new Error("ccusage did not return a JSON object");
  const documentSource = document.agent ?? document.source ?? document.provider ?? "";
  const byDate = new Map();

  for (const row of reportRows(document)) {
    const item = asObject(row);
    const date = item && rowDate(item);
    if (!date) continue;
    const usage = byDate.get(date) || { providers: new Map(), models: new Map() };
    byDate.set(date, usage);
    if (Array.isArray(item.agents) && item.agents.length > 0) {
      for (const agent of item.agents) addUsage(usage, agent, item.agent ?? item.source ?? documentSource);
    } else {
      addUsage(usage, item, documentSource);
    }
  }

  const days = {};
  for (const date of [...byDate.keys()].sort()) {
    const usage = byDate.get(date);
    const providers = Object.fromEntries(
      [...usage.providers].filter(([, tokens]) => tokens > 0).sort(([a], [b]) => a.localeCompare(b)),
    );
    if (Object.keys(providers).length === 0) continue;
    const models = normalizeModelMap(
      Object.fromEntries([...usage.models].map(([provider, byModel]) => [provider, Object.fromEntries(byModel)])),
      providers,
    );
    days[date] = Object.keys(models).length > 0 ? { providers, models } : { providers };
  }

  if (Object.keys(days).length > MAX_DAYS) return {};
  if (Buffer.byteLength(JSON.stringify(days)) <= MAX_DAYS_BYTES) return days;
  const withoutModels = Object.fromEntries(
    Object.entries(days).map(([date, day]) => [date, { providers: day.providers }]),
  );
  return Buffer.byteLength(JSON.stringify(withoutModels)) <= MAX_DAYS_BYTES ? withoutModels : {};
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
 * providers listed there, and no provider's days adding up to more than its
 * total. Anything else sends no split by day at all.
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
    process.stdin.on("data", (chunk) => { input += chunk; });
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

  if (command === "parse") {
    const fallbacks = String(process.argv[3] ?? "").split(",").filter(Boolean);
    process.stdout.write(JSON.stringify(parseCcusageProviders(parsed, fallbacks)));
    return;
  }
  if (command === "parse-models") {
    const fallbacks = String(process.argv[3] ?? "").split(",").filter(Boolean);
    process.stdout.write(JSON.stringify(parseCcusageUsage(parsed, fallbacks).models));
    return;
  }
  if (command === "parse-days") {
    process.stdout.write(JSON.stringify(parseCcusageDays(parsed)));
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

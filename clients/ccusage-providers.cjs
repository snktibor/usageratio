#!/usr/bin/env node
"use strict";

/**
 * Converts ccusage's JSON output to the compact provider snapshot accepted by
 * /api/usage. Kept in one dependency-free file so Bash and PowerShell use the
 * exact same classification rules. Node is already required by npx/ccusage.
 */

const MAX_PROVIDERS = 20;

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

function addUsage(providers, value, inheritedSource = "") {
  const item = asObject(value);
  if (!item) return;
  const source = item.provider ?? item.providerName ?? item.vendor ?? item.agent ?? item.source ?? inheritedSource;
  const breakdowns = breakdownsOf(item);

  if (breakdowns.length > 0) {
    for (const entry of breakdowns) {
      const detail = asObject(entry) || {};
      const model = detail.provider ?? detail.providerName ?? detail.vendor ?? detail.modelName ?? detail.model ?? "";
      add(providers, providerFrom(model, source), tokenTotal(detail));
    }
    return;
  }

  const models = Array.isArray(item.modelsUsed)
    ? item.modelsUsed
    : Array.isArray(item.models)
      ? item.models
      : [];
  add(providers, providerFrom(models[0] ?? source, source), tokenTotal(item));
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

function parseCcusageProviders(input, fallbackProviders = []) {
  const document = asObject(input) || (Array.isArray(input) ? input : null);
  if (!document) throw new Error("ccusage did not return a JSON object");
  const providers = new Map();
  const documentSource = document.agent ?? document.source ?? document.provider ?? "";

  for (const row of reportRows(document)) {
    const item = asObject(row);
    if (!item) continue;
    if (Array.isArray(item.agents) && item.agents.length > 0) {
      for (const agent of item.agents) {
        addUsage(providers, agent, item.agent ?? item.source ?? documentSource);
      }
    } else {
      addUsage(providers, item, documentSource);
    }
  }

  // Focused/older ccusage formats can contain only a totals/summary object.
  if (providers.size === 0) {
    const totals = asObject(document.totals) || asObject(document.summary);
    if (totals && tokenTotal(totals) > 0) {
      addUsage(providers, totals, documentSource || "unknown");
    }
  }

  if (providers.size === 0) {
    for (const fallback of fallbackProviders) add(providers, providerFrom(fallback), 0);
  }

  return normalizeProviderMap(Object.fromEntries(providers));
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
  if (command === "validate") {
    process.stdout.write(JSON.stringify(normalizeProviderMap(parsed)));
    return;
  }
  if (command === "payload") {
    const [, , , machineId, groupId, timestamp] = process.argv;
    if (!machineId || !groupId || !timestamp) throw new Error("payload needs machineId, groupId and timestamp");
    process.stdout.write(JSON.stringify({ machineId, groupId, timestamp, providers: normalizeProviderMap(parsed) }));
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

module.exports = { normalizeProviderMap, parseCcusageProviders, providerFrom, tokenTotal };

#!/usr/bin/env node
// Keeps the clients' pinned ccusage version current (.github/workflows/ccusage-update.yml).
//
//   node scripts/ccusage-update.mjs current              the version the clients pin (lib/setup.ts)
//   node scripts/ccusage-update.mjs candidate [days]     the newest release newer than that and at
//                                                        least <days> (default 3) days old; empty if none
//   node scripts/ccusage-update.mjs smoke <version> [<baseline>]
//                                                        runs that ccusage on synthetic Claude Code and
//                                                        Codex logs, exactly as the clients do, through
//                                                        the clients' own parser; with a baseline, the
//                                                        two versions must also read the logs the same way
//   node scripts/ccusage-update.mjs bump <version>       rewrites the pin everywhere it lives
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const parserPath = path.join(root, "clients/shared/ccusage-providers.cjs");

/** Every place the pinned version lives; tests/setup.test.ts checks they agree. */
export const PIN_SITES = [
  { file: "lib/setup.ts", pattern: /(export const CCUSAGE_VERSION = ")([^"]+)(";)/ },
  {
    file: "clients/shared/report-usage-core.sh",
    pattern: /(CCUSAGE_VERSION="\$\{USAGERATIO_CCUSAGE_VERSION:-)([^}]+)(\}")/,
  },
  {
    file: "clients/shared/report-usage-core.ps1",
    pattern: /(if \(-not \$ccusageVersion\) \{ \$ccusageVersion = ')([^']+)(' \})/,
  },
];

const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Orders two x.y.z versions (negative when a < b). */
export function compareVersions(a, b) {
  const [, ...left] = STABLE.exec(a) ?? [];
  const [, ...right] = STABLE.exec(b) ?? [];
  if (left.length === 0 || right.length === 0) throw new Error(`not a stable version: ${left.length ? b : a}`);
  for (let i = 0; i < 3; i++) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The newest stable release above `current` published at least `cooldownDays` ago,
 * from npm's `time` map ({ "<version>": "<ISO date>", created, modified }), or null.
 * The cooldown matches .github/dependabot.yml: a broken or pulled release usually
 * gets fixed within days, before the clients ever pin it.
 */
export function pickCandidate(times, current, cooldownDays, now = Date.now()) {
  const cutoff = now - cooldownDays * 86_400_000;
  let best = null;
  for (const [version, published] of Object.entries(times)) {
    if (!STABLE.test(version) || Date.parse(published) > cutoff) continue;
    if (compareVersions(version, current) <= 0) continue;
    if (best === null || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

/** The pinned version, after checking every pin site agrees on it. */
export function currentVersion(read = (file) => readFileSync(path.join(root, file), "utf8")) {
  const versions = PIN_SITES.map(({ file, pattern }) => {
    const match = pattern.exec(read(file));
    if (!match) throw new Error(`no ccusage pin found in ${file}`);
    return match[2];
  });
  if (new Set(versions).size !== 1) throw new Error(`the ccusage pins disagree: ${versions.join(", ")}`);
  return versions[0];
}

/** Each pin site's content with `version` in place of the old pin. */
export function bumpedSources(version, read = (file) => readFileSync(path.join(root, file), "utf8")) {
  if (!STABLE.test(version)) throw new Error(`not a stable version: ${version}`);
  return PIN_SITES.map(({ file, pattern }) => ({
    file,
    content: read(file).replace(pattern, (_, before, _old, after) => `${before}${version}${after}`),
  }));
}

// ─── Smoke test ───────────────────────────────────────────────────────────────

// Two days of synthetic logs, read in UTC from the first day on.
const SINCE = "2026-11-02";
const CYCLE_START = `${SINCE}T00:00:00.000Z`;

function claudeLine(id, timestamp, model, input, output, cacheCreation, cacheRead) {
  return JSON.stringify({
    timestamp,
    sessionId: "smoke-session",
    requestId: `req_${id}`,
    type: "assistant",
    cwd: "/work/smoke",
    version: "2.0.0",
    message: {
      id: `msg_${id}`,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
      },
    },
  });
}

function codexSession(start, model, usage) {
  const total = { ...usage, total_tokens: usage.input_tokens + usage.output_tokens };
  return [
    { timestamp: start, type: "session_meta", payload: { id: "smoke", timestamp: start, cwd: "/work/smoke" } },
    { timestamp: start, type: "turn_context", payload: { cwd: "/work/smoke", model } },
    {
      timestamp: start,
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: total } },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
}

/** A home folder holding only the synthetic logs, so nothing of the machine's own leaks in. */
function writeFixtureHome(home) {
  const claude = path.join(home, ".claude/projects/-work-smoke");
  mkdirSync(claude, { recursive: true });
  writeFileSync(
    path.join(claude, "smoke-session.jsonl"),
    [
      claudeLine(1, "2026-11-02T10:15:00.000Z", "claude-sonnet-4-5-20250929", 1000, 500, 200, 3000),
      claudeLine(2, "2026-11-02T11:20:00.000Z", "claude-opus-4-1-20250805", 400, 100, 0, 0),
      claudeLine(3, "2026-11-03T09:05:00.000Z", "claude-sonnet-4-5-20250929", 600, 250, 0, 1500),
    ].join("\n"),
  );
  const codex = path.join(home, ".codex/sessions/2026/11/03");
  mkdirSync(codex, { recursive: true });
  writeFileSync(
    path.join(codex, "rollout-2026-11-03T14-00-00-smoke.jsonl"),
    codexSession("2026-11-03T14:00:00.000Z", "gpt-5-codex", {
      input_tokens: 2000,
      cached_input_tokens: 500,
      output_tokens: 300,
      reasoning_output_tokens: 100,
    }),
  );
  // What GET /api/usage answers the clients with (only the parts the parser reads).
  const cycle = { providers: ["claude", "openai"], cycle: { start: CYCLE_START, providers: {} } };
  writeFileSync(path.join(home, "cycle.json"), JSON.stringify(cycle));
}

// What the synthetic logs add up to: Claude Code 1000+500+200+3000, 400+100 and 600+250+1500
// (cache writes and reads included, as ccusage counts them); Codex 2000 input (500 of it cached)
// + 300 output.
const EXPECTED_PROVIDERS = { claude: 7550, openai: 2300 };
const EXPECTED_MODELS = {
  claude: ["claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929"],
  openai: ["gpt-5-codex"],
};
// Each day's providers, and Claude Code's hours from `ccusage blocks`.
const EXPECTED_DAYS = {
  "2026-11-02": {
    providers: { claude: 5200 },
    hours: { claude: { "2026-11-02T10:00:00Z": 4700, "2026-11-02T11:00:00Z": 500 } },
  },
  "2026-11-03": {
    providers: { claude: 2350, openai: 2300 },
    hours: { claude: { "2026-11-03T09:00:00Z": 2350 } },
  },
};

/** Runs `ccusage@<version>` with the clients' arguments (clients/shared/report-usage-core.sh). */
function runCcusage(version, home, args) {
  const npmCache = execFileSync("npm", ["config", "get", "cache"], { encoding: "utf8" }).trim();
  const result = spawnSync("npx", ["--yes", `ccusage@${version}`, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: home, TZ: "UTC", NO_COLOR: "1", npm_config_cache: npmCache },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  });
  if (result.status !== 0) {
    throw new Error(`ccusage@${version} ${args[0]} exited with ${result.status ?? result.signal}:\n${result.stderr}`);
  }
  try {
    JSON.parse(result.stdout);
  } catch {
    throw new Error(`ccusage@${version} ${args[0]} did not print JSON:\n${result.stdout.slice(0, 500)}`);
  }
  return result.stdout;
}

function runParser(command, input, home) {
  const args = [parserPath, command, "claude,openai", path.join(home, "blocks.json"), CYCLE_START, "UTC"];
  args.push(path.join(home, "cycle.json"));
  return JSON.parse(execFileSync(process.execPath, args, { input, encoding: "utf8" }));
}

/** What `version` makes of the synthetic logs, as the clients would send it. */
export function readWith(version) {
  const home = mkdtempSync(path.join(tmpdir(), "usageratio-ccusage-"));
  try {
    writeFixtureHome(home);
    const blocks = runCcusage(version, home, [
      "blocks",
      "--json",
      "--offline",
      "--session-length",
      "1",
      "--since",
      SINCE.replaceAll("-", ""),
      "--timezone",
      "UTC",
    ]);
    writeFileSync(path.join(home, "blocks.json"), blocks);
    const daily = runCcusage(version, home, [
      "daily",
      "--json",
      "--by-agent",
      "--breakdown",
      "--offline",
      "--since",
      SINCE,
      "--timezone",
      "UTC",
    ]);
    return {
      providers: runParser("parse", daily, home),
      models: runParser("parse-models", daily, home),
      days: runParser("parse-days", daily, home),
      costs: runParser("parse-costs", daily, home),
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Everything wrong with one version's reading; empty when it reads the logs as expected. */
export function checkReading(reading) {
  const problems = [];
  if (!isDeepStrictEqual(reading.providers, EXPECTED_PROVIDERS)) {
    problems.push(
      `providers: expected ${JSON.stringify(EXPECTED_PROVIDERS)}, got ${JSON.stringify(reading.providers)}`,
    );
  }
  for (const [provider, names] of Object.entries(EXPECTED_MODELS)) {
    const models = reading.models?.[provider] ?? {};
    if (!isDeepStrictEqual(Object.keys(models).sort(), names)) {
      problems.push(`models of ${provider}: expected ${names.join(", ")}, got ${JSON.stringify(models)}`);
    }
    const sum = Object.values(models).reduce((total, tokens) => total + tokens, 0);
    if (sum !== EXPECTED_PROVIDERS[provider]) {
      problems.push(`models of ${provider} add up to ${sum}, not ${EXPECTED_PROVIDERS[provider]}`);
    }
  }
  const days = Object.fromEntries(
    Object.entries(reading.days ?? {}).map(([date, day]) => [date, { providers: day?.providers, hours: day?.hours }]),
  );
  if (!isDeepStrictEqual(days, EXPECTED_DAYS)) {
    problems.push(`days: expected ${JSON.stringify(EXPECTED_DAYS)}, got ${JSON.stringify(days)}`);
  }
  for (const provider of Object.keys(EXPECTED_PROVIDERS)) {
    if (!(reading.costs?.costs?.[provider] > 0)) {
      problems.push(`no cost for ${provider}: ${JSON.stringify(reading.costs)}`);
    }
  }
  return problems;
}

function smoke(version, baseline) {
  console.log(`Reading the synthetic logs with ccusage@${version}…`);
  let reading;
  try {
    reading = readWith(version);
  } catch (error) {
    console.error(`ccusage@${version} breaks the clients: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
  const problems = checkReading(reading);
  if (baseline && baseline !== version) {
    console.log(`…and with ccusage@${baseline}, to compare.`);
    const before = readWith(baseline);
    for (const key of ["providers", "models", "days"]) {
      if (!isDeepStrictEqual(reading[key], before[key])) {
        problems.push(
          `${key} differ from ccusage@${baseline}:\n  ${JSON.stringify(before[key])}\n  ${JSON.stringify(reading[key])}`,
        );
      }
    }
    // Prices may legitimately change with the bundled price list; only report it.
    if (!isDeepStrictEqual(reading.costs, before.costs)) {
      console.log(`Note: the costs changed from ${JSON.stringify(before.costs)} to ${JSON.stringify(reading.costs)}`);
    }
  }
  if (problems.length > 0) {
    console.error(`ccusage@${version} breaks the clients:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.log(`ccusage@${version} works: ${JSON.stringify(reading.providers)}`);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "current") {
    console.log(currentVersion());
  } else if (command === "candidate") {
    const times = JSON.parse(execFileSync("npm", ["view", "ccusage", "time", "--json"], { encoding: "utf8" }));
    console.log(pickCandidate(times, currentVersion(), Number(args[0] ?? 3)) ?? "");
  } else if (command === "smoke" && args[0]) {
    smoke(args[0], args[1]);
  } else if (command === "bump" && args[0]) {
    const before = currentVersion();
    for (const { file, content } of bumpedSources(args[0])) writeFileSync(path.join(root, file), content);
    console.log(`ccusage ${before} -> ${currentVersion()}`);
  } else {
    console.error(
      "usage: ccusage-update.mjs current | candidate [days] | smoke <version> [<baseline>] | bump <version>",
    );
    process.exit(2);
  }
}

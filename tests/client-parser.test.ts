import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_REPORT_DAYS } from "@/lib/days";
import { MAX_MODELS_PER_REPORT, MAX_MODELS_PER_PROVIDER as SERVER_MAX_MODELS_PER_PROVIDER } from "@/lib/models";
import { PROVIDER_LABELS, MAX_PROVIDERS as SERVER_MAX_PROVIDERS } from "@/lib/providers";

const require = createRequire(import.meta.url);
type ModelMap = Record<string, Record<string, number>>;
type DayMap = Record<
  string,
  { providers: Record<string, number>; models?: ModelMap; hours?: Record<string, Record<string, number>> }
>;
type Hourly = { blocks: unknown; cycleStartMs: number; timeZone: string } | null;
const PARSER = join(__dirname, "../clients/shared/ccusage-providers.cjs");
const {
  MAX_DAYS,
  MAX_MODELS,
  MAX_MODELS_PER_PROVIDER,
  MAX_PROVIDERS,
  normalizeModelMap,
  normalizeProviderMap,
  parseCcusageDays,
  parseCcusageProviders,
  parseCcusageUsage,
  PROVIDERS,
  providerFrom,
} = require("../clients/shared/ccusage-providers.cjs") as {
  MAX_DAYS: number;
  MAX_MODELS: number;
  MAX_MODELS_PER_PROVIDER: number;
  MAX_PROVIDERS: number;
  normalizeModelMap: (input: unknown, providers: Record<string, number>) => ModelMap;
  normalizeProviderMap: (input: unknown) => Record<string, number>;
  parseCcusageDays: (input: unknown, hourly?: Hourly) => DayMap;
  parseCcusageProviders: (input: unknown, fallbackProviders?: string[], hourly?: Hourly) => Record<string, number>;
  parseCcusageUsage: (
    input: unknown,
    fallbackProviders?: string[],
    hourly?: Hourly,
  ) => { providers: Record<string, number>; models: ModelMap };
  PROVIDERS: { id: string; test: RegExp }[];
  providerFrom: (value: unknown, fallback?: string) => string;
};

describe("ccusage provider parser", () => {
  it("normalizes provider maps used by the reporters", () => {
    expect(normalizeProviderMap({ OpenAI: 12, Claude: 8 })).toEqual({ claude: 8, openai: 12 });
  });

  it("accepts an empty provider map: a heartbeat when there is nothing to report and no fallback either", () => {
    expect(normalizeProviderMap({})).toEqual({});
    // No rows, and no fallback providers to zero out: {} goes out rather than an error.
    expect(parseCcusageProviders({ daily: [] })).toEqual({});
    expect(parseCcusageUsage({ daily: [] })).toEqual({ providers: {}, models: {} });
  });

  it("splits unified daily rows by model vendor and falls back to the agent", () => {
    expect(
      parseCcusageProviders({
        daily: [
          {
            date: "2026-09-21",
            agent: "all",
            agents: [
              {
                agent: "claude",
                modelBreakdowns: [
                  { modelName: "claude-sonnet-4", inputTokens: 10, outputTokens: 5 },
                  { modelName: "deepseek-v3", inputTokens: 20, outputTokens: 8 },
                ],
              },
              { agent: "codex", inputTokens: 7, outputTokens: 3 },
            ],
          },
        ],
      }),
    ).toEqual({ claude: 15, deepseek: 28, openai: 10 });
  });

  it("understands the older data/summary shape", () => {
    expect(
      parseCcusageProviders({
        source: "claude",
        data: [{ date: "2026-09-21", totalTokens: 42 }],
        summary: { totalTokens: 42 },
      }),
    ).toEqual({ claude: 42 });
  });

  it("emits zero snapshots for known providers when the cycle has no rows yet", () => {
    expect(parseCcusageProviders({ daily: [], totals: { totalTokens: 0 } }, ["claude", "openai"])).toEqual({
      claude: 0,
      openai: 0,
    });
  });

  it("splits every provider by model, summing a model's days and skipping empty ones", () => {
    expect(
      parseCcusageUsage({
        daily: [
          {
            date: "2026-09-21",
            agents: [
              {
                agent: "claude",
                modelBreakdowns: [
                  { modelName: "claude-opus-4-5-20251101", inputTokens: 10, outputTokens: 5 },
                  { modelName: "<synthetic>", inputTokens: 0, outputTokens: 0 },
                  { modelName: "deepseek-chat", inputTokens: 20, outputTokens: 8 },
                ],
              },
            ],
          },
          {
            date: "2026-09-22",
            agents: [{ agent: "claude", modelBreakdowns: [{ modelName: "claude-opus-4-5-20251101", totalTokens: 7 }] }],
          },
        ],
      }),
    ).toEqual({
      providers: { claude: 22, deepseek: 28 },
      models: { claude: { "claude-opus-4-5-20251101": 22 }, deepseek: { "deepseek-chat": 28 } },
    });
  });

  it("ties a row without a breakdown to a model only when it used just one", () => {
    const usage = parseCcusageUsage({
      daily: [
        { agent: "codex", modelsUsed: ["gpt-5-codex"], totalTokens: 10 },
        { agent: "codex", modelsUsed: ["gpt-5", "gpt-5-codex"], totalTokens: 4 },
      ],
    });
    expect(usage).toEqual({ providers: { openai: 14 }, models: { openai: { "gpt-5-codex": 10 } } });
  });

  it("builds a heartbeat payload (providers: {}) when there is nothing to report", () => {
    const payload = execFileSync("node", [PARSER, "payload", "mac", "Personal", "2026-09-22T11:49:28Z"], {
      input: "{}",
      encoding: "utf8",
    });
    expect(JSON.parse(payload)).toEqual({
      machineId: "mac",
      groupId: "Personal",
      providers: {},
      timestamp: "2026-09-22T11:49:28Z",
    });
  });

  it.each([
    [[], {}],
    [["auto"], {}],
    [["auto", "60"], { intervalMinutes: 60 }],
    [["auto", "3"], {}], // out of the server's 5-1440 range: left out
    [["manual"], { mode: "manual" }],
    [["manual", "60"], { mode: "manual" }], // an interval is only ever sent for "auto"
  ])("adds mode/intervalMinutes to the payload the way report-usage-core.sh derives them: %j", (args, extra) => {
    const payload = execFileSync(
      "node",
      [PARSER, "payload", "mac", "Personal", "2026-09-22T11:49:28Z", "", "", ...args],
      {
        input: "{}",
        encoding: "utf8",
      },
    );
    expect(JSON.parse(payload)).toEqual({
      machineId: "mac",
      groupId: "Personal",
      providers: {},
      timestamp: "2026-09-22T11:49:28Z",
      ...extra,
    });
  });

  it("keeps a split within the server's limits and its provider's total", () => {
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`model-${i}`, i + 1]));
    const models = normalizeModelMap(
      { claude: many, openai: { "gpt-5": 99 }, ghost: { x: 1 } },
      {
        claude: 10_000,
        openai: 50,
      },
    );
    // The 20 largest models stay; openai's split claims more than its total and is dropped.
    expect(Object.keys(models)).toEqual(["claude"]);
    expect(Object.keys(models.claude!)).toHaveLength(20);
    expect(models.claude!["model-0"]).toBeUndefined();
    expect(models.claude!["model-24"]).toBe(25);
  });
});

// One real model name each registry entry's pattern actually matches (unlike the
// others, "meta"'s test needs "llama" or "…ai", not just the id itself).
const PROVIDER_PROBES: Record<string, string> = {
  deepseek: "deepseek-chat",
  claude: "claude-opus-4-5",
  openai: "gpt-5-codex",
  gemini: "gemini-2.5-pro",
  xai: "grok-4",
  qwen: "qwen-2.5-max",
  kimi: "kimi-k2",
  mistral: "mistral-large",
  meta: "llama-3.1-405b",
};

describe("provider registry", () => {
  it("matches providerFrom's precedence: the first entry to test true wins", () => {
    expect(PROVIDERS.map((provider) => provider.id)).toEqual([
      "deepseek",
      "claude",
      "openai",
      "gemini",
      "xai",
      "qwen",
      "kimi",
      "mistral",
      "meta",
    ]);
    for (const provider of PROVIDERS) {
      const probe = PROVIDER_PROBES[provider.id];
      expect(probe, `missing a probe model name for ${provider.id}`).toBeDefined();
      expect(providerFrom(probe)).toBe(provider.id);
    }
  });

  it("gives every registry provider a display label on the dashboard", () => {
    for (const provider of PROVIDERS) {
      expect(Object.hasOwn(PROVIDER_LABELS, provider.id), provider.id).toBe(true);
    }
  });

  it("keeps its limits equal to the server's (lib/providers.ts, lib/models.ts, lib/days.ts)", () => {
    expect(MAX_PROVIDERS).toBe(SERVER_MAX_PROVIDERS);
    expect(MAX_MODELS_PER_PROVIDER).toBe(SERVER_MAX_MODELS_PER_PROVIDER);
    expect(MAX_MODELS).toBe(MAX_MODELS_PER_REPORT);
    expect(MAX_DAYS).toBe(MAX_REPORT_DAYS);
  });
});

describe("ccusage split by day", () => {
  // The shape of ccusage 20's unified daily report: the day is in `period`.
  const report = {
    daily: [
      {
        period: "2026-09-19",
        agents: [
          {
            agent: "claude",
            modelBreakdowns: [
              { modelName: "claude-opus-5", inputTokens: 100, outputTokens: 50 },
              { modelName: "claude-sonnet-5", totalTokens: 10 },
            ],
          },
        ],
      },
      { period: "2026-09-20", agents: [{ agent: "claude", totalTokens: 0 }] },
      {
        period: "2026-09-21",
        agents: [
          { agent: "claude", modelBreakdowns: [{ modelName: "claude-opus-5", totalTokens: 300 }] },
          { agent: "codex", modelsUsed: ["gpt-5-codex"], totalTokens: 40 },
        ],
      },
    ],
    totals: { totalTokens: 500 },
  };

  it("splits the snapshot by day, leaving out days without tokens", () => {
    expect(parseCcusageDays(report)).toEqual({
      "2026-09-19": { providers: { claude: 160 }, models: { claude: { "claude-opus-5": 150, "claude-sonnet-5": 10 } } },
      "2026-09-21": {
        providers: { claude: 300, openai: 40 },
        models: { claude: { "claude-opus-5": 300 }, openai: { "gpt-5-codex": 40 } },
      },
    });
    // The days add up to the snapshot itself.
    expect(parseCcusageProviders(report)).toEqual({ claude: 460, openai: 40 });
  });

  it("reads the older `date` key and ignores rows without a day", () => {
    expect(
      parseCcusageDays({
        daily: [
          { date: "2026-09-21", agent: "claude", totalTokens: 7 },
          { period: "2026-W38", agent: "claude", totalTokens: 9 },
        ],
      }),
    ).toEqual({ "2026-09-21": { providers: { claude: 7 } } });
  });

  it("gives up the models, then the whole split, when it would not fit the server's limits", () => {
    // 20 models with long ids on each of 31 days: about 51 KB of split by model.
    const models = Array.from({ length: 20 }, (_, i) => ({
      modelName: `claude-model-with-a-very-long-and-rather-descriptive-name-no-${String(i).padStart(2, "0")}`,
      totalTokens: 1_000_000_000_000 + i,
    }));
    const day = (period: string) => ({ period, agents: [{ agent: "claude", modelBreakdowns: models }] });
    const month = Array.from({ length: 31 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, "0")}`));
    const days = parseCcusageDays({ daily: month });
    expect(Object.keys(days)).toHaveLength(31);
    expect(Object.values(days).every((entry) => entry.models === undefined)).toBe(true);

    const tooMany = Array.from({ length: 33 }, (_, i) =>
      day(new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10)),
    );
    expect(parseCcusageDays({ daily: tooMany })).toEqual({});
  });

  it("puts the split into the payload only when it matches the providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "usageratio-days-"));
    try {
      const daysFile = join(dir, "days.json");
      const payload = (providers: Record<string, number>) =>
        JSON.parse(
          execFileSync(
            "node",
            [PARSER, "payload", "mac", "Personal", "2026-09-22T11:49:28Z", join(dir, "none.json"), daysFile],
            {
              input: JSON.stringify(providers),
              encoding: "utf8",
            },
          ),
        ) as Record<string, unknown>;

      writeFileSync(daysFile, JSON.stringify(parseCcusageDays(report)));
      expect(payload({ claude: 460, openai: 40 }).days).toEqual(parseCcusageDays(report));
      // A snapshot that does not come from the same reading (an override) goes out without it.
      expect(payload({ claude: 100, openai: 40 })).not.toHaveProperty("days");
      expect(payload({ claude: 460 })).not.toHaveProperty("days");
      rmSync(daysFile);
      expect(payload({ claude: 460, openai: 40 })).not.toHaveProperty("days");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("ccusage split by hour", () => {
  const opus = (totalTokens: number) => ({ modelName: "claude-opus-5", totalTokens });
  const daily = {
    daily: [
      {
        period: "2026-09-19",
        agents: [{ agent: "claude", modelBreakdowns: [opus(100), { modelName: "claude-sonnet-5", totalTokens: 20 }] }],
      },
      {
        period: "2026-09-20",
        agents: [
          { agent: "claude", modelBreakdowns: [opus(50)] },
          { agent: "codex", modelsUsed: ["gpt-5-codex"], totalTokens: 10 },
        ],
      },
      // Today.
      { period: "2026-09-21", agents: [{ agent: "claude", modelBreakdowns: [opus(80)] }] },
    ],
  };
  const block = (start: string, totalTokens: number, models = ["claude-opus-5"]) => {
    const startMs = Date.parse(start);
    return {
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(startMs + 3_600_000).toISOString(),
      isGap: false,
      models,
      totalTokens,
    };
  };
  const blocks = [
    // 11:00 in Budapest: before the reset at 13:00 (11:00 UTC).
    block("2026-09-19T09:00:00Z", 20),
    block("2026-09-19T11:00:00Z", 60, ["claude-opus-5", "claude-sonnet-5"]),
    { ...block("2026-09-19T15:00:00Z", 0), isGap: true },
    block("2026-09-19T20:00:00Z", 40),
    block("2026-09-20T08:00:00Z", 30),
    block("2026-09-20T10:00:00Z", 20),
    // The hour in progress was read a moment before the daily report: 10 tokens short.
    block("2026-09-21T07:00:00Z", 70),
  ];
  const hourly = (list: unknown[] = blocks): Hourly => ({
    blocks: { blocks: list },
    cycleStartMs: Date.parse("2026-09-19T11:00:00Z"),
    timeZone: "Europe/Budapest",
  });

  it("takes the hours before the reset off its day, scaling the day's models down with it", () => {
    expect(parseCcusageUsage(daily, [], hourly())).toEqual({
      providers: { claude: 230, openai: 10 },
      // 100 of 120 tokens are left of Saturday: opus 100 → 83, sonnet 20 → 16.
      models: { claude: { "claude-opus-5": 213, "claude-sonnet-5": 16 }, openai: { "gpt-5-codex": 10 } },
    });
    // Without the blocks the whole Saturday counts, as before.
    expect(parseCcusageProviders(daily)).toEqual({ claude: 250, openai: 10 });
  });

  it("splits the days by hour where the hours add up to the day", () => {
    const days = parseCcusageDays(daily, hourly());
    expect(days["2026-09-19"]).toEqual({
      providers: { claude: 100 },
      models: { claude: { "claude-opus-5": 83, "claude-sonnet-5": 16 } },
      hours: { claude: { "2026-09-19T11:00:00Z": 60, "2026-09-19T20:00:00Z": 40 } },
    });
    expect(days["2026-09-20"]!.hours).toEqual({ claude: { "2026-09-20T08:00:00Z": 30, "2026-09-20T10:00:00Z": 20 } });
    // Today's hours may fall short of the day: the rest is in the hour in progress.
    expect(days["2026-09-21"]!.hours).toEqual({ claude: { "2026-09-21T07:00:00Z": 70 } });
    // The days still add up to the snapshot.
    const total = Object.values(days).reduce((sum, day) => sum + (day.providers.claude ?? 0), 0);
    expect(total).toBe(parseCcusageProviders(daily, [], hourly()).claude);
  });

  it("gives up the hours of a past day they do not add up to", () => {
    // Another agent used Claude on Sunday too: Claude Code's hours are only part of the day.
    const days = parseCcusageDays(
      daily,
      hourly(blocks.filter((entry) => entry.startTime !== "2026-09-20T10:00:00.000Z")),
    );
    expect(days["2026-09-20"]).not.toHaveProperty("hours");
    expect(days["2026-09-20"]!.providers.claude).toBe(50);
    expect(days["2026-09-19"]).toHaveProperty("hours");
  });

  it("trusts nothing of a day whose hours claim more than the day", () => {
    const extra = [...blocks, block("2026-09-19T12:00:00Z", 1)];
    const days = parseCcusageDays(daily, hourly(extra));
    expect(days["2026-09-19"]).toEqual({
      providers: { claude: 120 },
      models: { claude: { "claude-opus-5": 100, "claude-sonnet-5": 20 } },
    });
  });

  it("keeps no hours for a provider on a day an hour mixed it with another", () => {
    const mixed = blocks.map((entry) =>
      entry.startTime === "2026-09-20T08:00:00.000Z" ? { ...entry, models: ["claude-opus-5", "deepseek-chat"] } : entry,
    );
    expect(parseCcusageDays(daily, hourly(mixed))["2026-09-20"]).not.toHaveProperty("hours");
  });

  it("ignores blocks that are not clock hours", () => {
    const fiveHours = blocks.map((entry) => ({
      ...entry,
      endTime: new Date(Date.parse(entry.startTime) + 5 * 3_600_000).toISOString(),
    }));
    expect(parseCcusageUsage(daily, [], hourly(fiveHours))).toEqual(parseCcusageUsage(daily));
    expect(parseCcusageDays(daily, hourly(fiveHours))).toEqual(parseCcusageDays(daily));
  });

  it("reads the blocks from the command line and sends the hours", () => {
    const dir = mkdtempSync(join(tmpdir(), "usageratio-hours-"));
    try {
      const dailyFile = join(dir, "daily.json");
      const blocksFile = join(dir, "blocks.json");
      writeFileSync(dailyFile, JSON.stringify(daily));
      writeFileSync(blocksFile, JSON.stringify({ blocks }));
      const run = (...args: string[]) =>
        execFileSync("node", [PARSER, ...args], { input: JSON.stringify(daily), encoding: "utf8" });
      const hourlyArgs = [blocksFile, "2026-09-19T11:00:00.000Z", "Europe/Budapest"];

      expect(JSON.parse(run("parse", "claude", ...hourlyArgs))).toEqual({ claude: 230, openai: 10 });
      writeFileSync(join(dir, "days.json"), run("parse-days", "claude", ...hourlyArgs));
      writeFileSync(join(dir, "models.json"), run("parse-models", "claude", ...hourlyArgs));
      const payload = JSON.parse(
        execFileSync(
          "node",
          [
            PARSER,
            "payload",
            "mac",
            "Personal",
            "2026-09-21T08:30:00Z",
            join(dir, "models.json"),
            join(dir, "days.json"),
          ],
          { input: JSON.stringify({ claude: 230, openai: 10 }), encoding: "utf8" },
        ),
      );
      expect(payload.days["2026-09-19"].hours.claude).toEqual({
        "2026-09-19T11:00:00Z": 60,
        "2026-09-19T20:00:00Z": 40,
      });
      expect(payload.models.claude).toEqual({ "claude-opus-5": 213, "claude-sonnet-5": 16 });
      // A missing blocks file only means no hours.
      expect(JSON.parse(run("parse", "claude", join(dir, "none.json"), hourlyArgs[1]!, hourlyArgs[2]!))).toEqual({
        claude: 250,
        openai: 10,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type ModelMap = Record<string, Record<string, number>>;
type DayMap = Record<string, { providers: Record<string, number>; models?: ModelMap }>;
const PARSER = join(__dirname, "../clients/shared/ccusage-providers.cjs");
const { normalizeModelMap, normalizeProviderMap, parseCcusageDays, parseCcusageProviders, parseCcusageUsage } =
  require("../clients/shared/ccusage-providers.cjs") as {
    normalizeModelMap: (input: unknown, providers: Record<string, number>) => ModelMap;
    normalizeProviderMap: (input: unknown) => Record<string, number>;
    parseCcusageDays: (input: unknown) => DayMap;
    parseCcusageProviders: (input: unknown, fallbackProviders?: string[]) => Record<string, number>;
    parseCcusageUsage: (
      input: unknown,
      fallbackProviders?: string[],
    ) => { providers: Record<string, number>; models: ModelMap };
  };

describe("ccusage provider parser", () => {
  it("normalizes provider maps used by the reporters", () => {
    expect(normalizeProviderMap({ OpenAI: 12, Claude: 8 })).toEqual({ claude: 8, openai: 12 });
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
            agents: [
              { agent: "claude", modelBreakdowns: [{ modelName: "claude-opus-4-5-20251101", totalTokens: 7 }] },
            ],
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

  it("keeps a split within the server's limits and its provider's total", () => {
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`model-${i}`, i + 1]));
    const models = normalizeModelMap({ claude: many, openai: { "gpt-5": 99 }, ghost: { x: 1 } }, {
      claude: 10_000,
      openai: 50,
    });
    // The 20 largest models stay; openai's split claims more than its total and is dropped.
    expect(Object.keys(models)).toEqual(["claude"]);
    expect(Object.keys(models.claude!)).toHaveLength(20);
    expect(models.claude!["model-0"]).toBeUndefined();
    expect(models.claude!["model-24"]).toBe(25);
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
    // 20 models with long ids on each of 31 days: about 45 KB of split by model.
    const models = Array.from({ length: 20 }, (_, i) => ({
      modelName: `claude-model-with-a-very-long-descriptive-name-number-${i}`,
      totalTokens: 1_000_000_000_000 + i,
    }));
    const day = (period: string) => ({ period, agents: [{ agent: "claude", modelBreakdowns: models }] });
    const month = Array.from({ length: 31 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, "0")}`));
    const days = parseCcusageDays({ daily: month });
    expect(Object.keys(days)).toHaveLength(31);
    expect(Object.values(days).every((entry) => entry.models === undefined)).toBe(true);

    const tooMany = Array.from({ length: 33 }, (_, i) => day(new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10)));
    expect(parseCcusageDays({ daily: tooMany })).toEqual({});
  });

  it("puts the split into the payload only when it matches the providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "usageratio-days-"));
    try {
      const daysFile = join(dir, "days.json");
      const payload = (providers: Record<string, number>) =>
        JSON.parse(
          execFileSync("node", [PARSER, "payload", "mac", "Personal", "2026-09-22T11:49:28Z", join(dir, "none.json"), daysFile], {
            input: JSON.stringify(providers),
            encoding: "utf8",
          }),
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
  });
});

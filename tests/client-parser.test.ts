import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
type ModelMap = Record<string, Record<string, number>>;
const { normalizeModelMap, normalizeProviderMap, parseCcusageProviders, parseCcusageUsage } =
  require("../clients/shared/ccusage-providers.cjs") as {
    normalizeModelMap: (input: unknown, providers: Record<string, number>) => ModelMap;
    normalizeProviderMap: (input: unknown) => Record<string, number>;
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

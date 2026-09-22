import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { normalizeProviderMap, parseCcusageProviders } = require("../clients/shared/ccusage-providers.cjs") as {
  normalizeProviderMap: (input: unknown) => Record<string, number>;
  parseCcusageProviders: (input: unknown, fallbackProviders?: string[]) => Record<string, number>;
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
});

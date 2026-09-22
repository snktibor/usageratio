import { describe, expect, it } from "vitest";
import { getDayEnd } from "@/lib/cycle";
import { dayCheckpoints } from "@/lib/days";
import type { DayUsage, UsageReport } from "@/lib/validation";

const ZONE = "Europe/Budapest";

function report(timestamp: string, days: DayUsage[]): UsageReport {
  const providers: Record<string, number> = {};
  for (const day of days) {
    for (const [providerId, tokens] of Object.entries(day.providers)) {
      providers[providerId] = (providers[providerId] ?? 0) + tokens;
    }
  }
  return {
    machineId: "mac",
    groupId: "Personal",
    providers,
    models: {},
    days,
    timestampMs: Date.parse(timestamp),
    timestamp,
  };
}

describe("getDayEnd", () => {
  it("is the local midnight after the day", () => {
    expect(getDayEnd("2026-09-19", ZONE).toISOString()).toBe("2026-09-19T22:00:00.000Z");
  });

  it("follows daylight saving time and month ends", () => {
    // The clocks go back on 25 October: that day lasts 25 hours, and the next midnight is in winter time.
    expect(getDayEnd("2026-10-25", ZONE).toISOString()).toBe("2026-10-25T23:00:00.000Z");
    expect(getDayEnd("2026-12-31", ZONE).toISOString()).toBe("2026-12-31T23:00:00.000Z");
  });
});

describe("dayCheckpoints", () => {
  const days: DayUsage[] = [
    {
      date: "2026-09-19",
      providers: { claude: 200 },
      models: { claude: { "claude-opus-5": 150, "claude-sonnet-5": 50 } },
    },
    // A day without usage of its own has no row at all.
    { date: "2026-09-21", providers: { claude: 500, openai: 40 }, models: { claude: { "claude-opus-5": 500 } } },
    { date: "2026-09-22", providers: { claude: 400 }, models: {} },
  ];

  it("gives the running totals at the end of every finished day", () => {
    expect(dayCheckpoints(report("2026-09-22T11:49:28Z", days), ZONE)).toEqual([
      {
        ts: Date.parse("2026-09-19T22:00:00Z"),
        providers: { claude: 200 },
        models: { claude: { "claude-opus-5": 150, "claude-sonnet-5": 50 } },
      },
      {
        ts: Date.parse("2026-09-21T22:00:00Z"),
        providers: { claude: 700, openai: 40 },
        models: { claude: { "claude-opus-5": 650, "claude-sonnet-5": 50 } },
      },
    ]);
  });

  it("leaves the day in progress to the report itself", () => {
    expect(dayCheckpoints(report("2026-09-21T21:59:59Z", days), ZONE)).toHaveLength(1);
    // A report made right at midnight already closes the day before it.
    expect(dayCheckpoints(report("2026-09-22T22:00:00Z", days), ZONE)).toHaveLength(3);
  });

  it("keeps each checkpoint's totals apart from the later ones", () => {
    const [first, second] = dayCheckpoints(report("2026-09-22T11:49:28Z", days), ZONE);
    expect(first!.models.claude!["claude-opus-5"]).toBe(150);
    expect(second!.models.claude!["claude-opus-5"]).toBe(650);
  });

  it("has nothing for a report without a split by day", () => {
    expect(dayCheckpoints(report("2026-09-22T11:49:28Z", []), ZONE)).toEqual([]);
  });
});

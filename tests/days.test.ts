import { describe, expect, it } from "vitest";
import { getDayEnd, getDayStart } from "@/lib/cycle";
import { reportCheckpoints } from "@/lib/days";
import type { DayUsage, UsageReport } from "@/lib/validation";

const ZONE = "Europe/Budapest";
const HOUR = 3_600_000;
// Saturday 13:00 in Budapest: the cycle's start.
const CYCLE_START = Date.parse("2026-09-19T11:00:00Z");

function day(date: string, providers: Record<string, number>, extra: Partial<DayUsage> = {}): DayUsage {
  return { date, providers, models: {}, hours: {}, ...extra };
}

function hours(...list: [string, number][]) {
  return list.map(([start, tokens]) => ({ startMs: Date.parse(start), tokens }));
}

function report(timestamp: string, days: DayUsage[]): UsageReport {
  const providers: Record<string, number> = {};
  for (const entry of days) {
    for (const [providerId, tokens] of Object.entries(entry.providers)) {
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

describe("getDayStart and getDayEnd", () => {
  it("are the local midnights around the day", () => {
    expect(getDayStart("2026-09-19", ZONE).toISOString()).toBe("2026-09-18T22:00:00.000Z");
    expect(getDayEnd("2026-09-19", ZONE).toISOString()).toBe("2026-09-19T22:00:00.000Z");
  });

  it("follow daylight saving time and month ends", () => {
    // The clocks go back on 25 October: that day lasts 25 hours, and the next midnight is in winter time.
    expect(getDayEnd("2026-10-25", ZONE).getTime() - getDayStart("2026-10-25", ZONE).getTime()).toBe(25 * HOUR);
    expect(getDayEnd("2026-12-31", ZONE).toISOString()).toBe("2026-12-31T23:00:00.000Z");
  });
});

describe("reportCheckpoints", () => {
  const days: DayUsage[] = [
    day("2026-09-19", { claude: 200 }, { models: { claude: { "claude-opus-5": 150, "claude-sonnet-5": 50 } } }),
    // A day without usage of its own has no row at all.
    day("2026-09-21", { claude: 500, openai: 40 }, { models: { claude: { "claude-opus-5": 500 } } }),
    day("2026-09-22", { claude: 400 }),
  ];

  it("gives each provider's running total at the end of every finished day", () => {
    expect(reportCheckpoints(report("2026-09-22T11:49:28Z", days), ZONE, CYCLE_START)).toEqual([
      {
        providerId: "claude",
        ts: Date.parse("2026-09-19T22:00:00Z"),
        tokens: 200,
        models: { "claude-opus-5": 150, "claude-sonnet-5": 50 },
      },
      {
        providerId: "claude",
        ts: Date.parse("2026-09-21T22:00:00Z"),
        tokens: 700,
        models: { "claude-opus-5": 650, "claude-sonnet-5": 50 },
      },
      { providerId: "openai", ts: Date.parse("2026-09-21T22:00:00Z"), tokens: 40 },
    ]);
  });

  it("leaves the day in progress to the report itself", () => {
    expect(reportCheckpoints(report("2026-09-21T21:59:59Z", days), ZONE, CYCLE_START)).toHaveLength(1);
    // A report made right at midnight already closes the day before it: for both providers.
    const closed = reportCheckpoints(report("2026-09-22T22:00:00Z", days), ZONE, CYCLE_START);
    expect(closed.filter((checkpoint) => checkpoint.ts === Date.parse("2026-09-22T22:00:00Z"))).toEqual([
      {
        providerId: "claude",
        ts: Date.parse("2026-09-22T22:00:00Z"),
        tokens: 1_100,
        models: { "claude-opus-5": 650, "claude-sonnet-5": 50 },
      },
      { providerId: "openai", ts: Date.parse("2026-09-22T22:00:00Z"), tokens: 40 },
    ]);
  });

  it("adds the finished hours, without a split by model, the day's last one left to the day", () => {
    const hourly = [
      day(
        "2026-09-19",
        { claude: 60, openai: 5 },
        {
          models: { claude: { "claude-opus-5": 60 } },
          hours: {
            claude: hours(["2026-09-19T11:00:00Z", 10], ["2026-09-19T15:00:00Z", 30], ["2026-09-19T21:00:00Z", 20]),
          },
        },
      ),
      // Today: the 09:00 hour is still in progress at the report's time.
      day(
        "2026-09-20",
        { claude: 100 },
        { hours: { claude: hours(["2026-09-20T07:00:00Z", 40], ["2026-09-20T09:00:00Z", 55]) } },
      ),
    ];
    const at = (iso: string) => Date.parse(iso);
    expect(reportCheckpoints(report("2026-09-20T09:30:00Z", hourly), ZONE, CYCLE_START)).toEqual([
      { providerId: "claude", ts: at("2026-09-19T12:00:00Z"), tokens: 10 },
      { providerId: "claude", ts: at("2026-09-19T16:00:00Z"), tokens: 40 },
      { providerId: "claude", ts: at("2026-09-19T22:00:00Z"), tokens: 60, models: { "claude-opus-5": 60 } },
      { providerId: "openai", ts: at("2026-09-19T22:00:00Z"), tokens: 5 },
      { providerId: "claude", ts: at("2026-09-20T08:00:00Z"), tokens: 100 },
    ]);
  });

  it("keeps only what falls after the start of the report's cycle", () => {
    const early = [day("2026-09-19", { claude: 30 }, { hours: { claude: hours(["2026-09-19T09:00:00Z", 30]) } })];
    expect(reportCheckpoints(report("2026-09-19T12:00:00Z", early), ZONE, CYCLE_START)).toEqual([]);
  });

  it("has nothing for a report without a split by day", () => {
    expect(reportCheckpoints(report("2026-09-22T11:49:28Z", []), ZONE, CYCLE_START)).toEqual([]);
  });
});

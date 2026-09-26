import { describe, expect, it } from "vitest";
import { parseUsageReport } from "@/lib/validation";

const NOW = new Date("2026-09-21T10:00:30Z");
const OPTIONS = { now: NOW, maxClockSkewMinutes: 10, retentionDays: 35, timeZone: "Europe/Budapest" };

const VALID = {
  machineId: "mac-studio",
  groupId: "Personal",
  providers: { deepseek: 1234, claude: 5678 },
  timestamp: "2026-09-21T10:00:00Z",
};

function errorsOf(input: unknown): string[] {
  const result = parseUsageReport(input, OPTIONS);
  if (result.ok) throw new Error("expected the payload to be rejected");
  return result.errors;
}

describe("parseUsageReport", () => {
  it("accepts a valid report and normalizes the timestamp", () => {
    const result = parseUsageReport(VALID, OPTIONS);
    expect(result).toEqual({
      ok: true,
      report: {
        machineId: "mac-studio",
        groupId: "Personal",
        providers: { deepseek: 1234, claude: 5678 },
        models: {},
        days: [],
        timestampMs: Date.parse("2026-09-21T10:00:00Z"),
        timestamp: "2026-09-21T10:00:00.000Z",
        mode: "auto",
        intervalMinutes: null,
      },
    });
  });

  it("trims identifiers and allows accented letters, spaces, dots, dashes and underscores", () => {
    const result = parseUsageReport({ ...VALID, machineId: "  Tibor gépe_2.0-win  ", groupId: "Munka" }, OPTIONS);
    expect(result.ok && result.report.machineId).toBe("Tibor gépe_2.0-win");
  });

  it("accepts a zero-token provider snapshot (idle heartbeat)", () => {
    expect(parseUsageReport({ ...VALID, providers: { claude: 0 } }, OPTIONS).ok).toBe(true);
  });

  it("accepts timestamps with an offset or with .NET's 7 fractional digits", () => {
    const withOffset = parseUsageReport({ ...VALID, timestamp: "2026-09-21T12:00:00+02:00" }, OPTIONS);
    expect(withOffset.ok && withOffset.report.timestamp).toBe("2026-09-21T10:00:00.000Z");

    const dotnet = parseUsageReport({ ...VALID, timestamp: "2026-09-21T10:00:00.1234567Z" }, OPTIONS);
    expect(dotnet.ok && dotnet.report.timestamp).toBe("2026-09-21T10:00:00.123Z");
  });

  it.each([null, undefined, "text", 42, [VALID]])("rejects a non-object body: %j", (input) => {
    expect(errorsOf(input)).toHaveLength(1);
  });

  it("reports every invalid field at once", () => {
    const errors = errorsOf({ machineId: "", groupId: 7, providers: "12", timestamp: "yesterday" });
    expect(errors).toHaveLength(4);
  });

  it.each(["", "   ", "a".repeat(65), "work:1", "a/b", "tab\there", "line\nbreak", "{x}"])(
    "rejects the identifier %j",
    (id) => {
      expect(errorsOf({ ...VALID, machineId: id })).toHaveLength(1);
      expect(errorsOf({ ...VALID, groupId: id })).toHaveLength(1);
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "100", null])(
    "rejects a provider token count = %j",
    (tokens) => {
      expect(errorsOf({ ...VALID, providers: { claude: tokens } })).toHaveLength(1);
    },
  );

  it("normalizes provider ids and rejects invalid or duplicate provider maps", () => {
    const normalized = parseUsageReport({ ...VALID, providers: { Claude: 12, OpenAI: 8 } }, OPTIONS);
    expect(normalized.ok && normalized.report.providers).toEqual({ claude: 12, openai: 8 });
    expect(errorsOf({ ...VALID, providers: { "bad/provider": 1 } })).toHaveLength(1);
    expect(errorsOf({ ...VALID, providers: { Claude: 1, claude: 2 } })).toHaveLength(1);
  });

  it("accepts an empty provider map: a heartbeat from a fresh machine with nothing to report yet", () => {
    const result = parseUsageReport({ ...VALID, providers: {} }, OPTIONS);
    expect(result.ok && result.report.providers).toEqual({});
    // Still bounded, and still rejects unrelated garbage in the same field.
    expect(
      errorsOf({ ...VALID, providers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, i])) }),
    ).toHaveLength(1);
  });

  it.each([
    "2026-09-21 10:00:00",
    "2026-09-21T10:00:00", // no zone designator
    "2026-09-21",
    "2026-02-30T10:00:00Z", // no such day
    "2026-13-01T10:00:00Z",
    "2026-09-21T25:00:00Z",
    "Mon, 21 Sep 2026 10:00:00 GMT",
    1790000000000,
  ])("rejects the timestamp %j", (timestamp) => {
    expect(errorsOf({ ...VALID, timestamp })).toHaveLength(1);
  });

  it("tolerates small clock skew but rejects timestamps far in the future", () => {
    expect(parseUsageReport({ ...VALID, timestamp: "2026-09-21T10:09:00Z" }, OPTIONS).ok).toBe(true);
    expect(errorsOf({ ...VALID, timestamp: "2026-09-21T10:11:00Z" })[0]).toMatch(/future/);
  });

  it("rejects timestamps older than the retention window", () => {
    expect(parseUsageReport({ ...VALID, timestamp: "2026-08-20T10:00:00Z" }, OPTIONS).ok).toBe(true);
    expect(errorsOf({ ...VALID, timestamp: "2026-08-10T10:00:00Z" })[0]).toMatch(/older/);
  });

  it("accepts a split by model and normalizes its ids", () => {
    const result = parseUsageReport(
      { ...VALID, models: { Claude: { "Claude-Opus-4-5-20251101": 5000, "claude-haiku-4-5": 678 } } },
      OPTIONS,
    );
    expect(result.ok && result.report.models).toEqual({
      claude: { "claude-opus-4-5-20251101": 5000, "claude-haiku-4-5": 678 },
    });
  });

  it("accepts a split that covers only part of a provider's tokens", () => {
    expect(parseUsageReport({ ...VALID, models: { claude: { "claude-opus-4-5": 10 } } }, OPTIONS).ok).toBe(true);
  });

  it.each([
    ["not an object", []],
    ["a provider not in providers", { openai: { "gpt-5": 1 } }],
    ["a provider's models not an object", { claude: 5678 }],
    ["an invalid model id", { claude: { "bad/model": 1 } }],
    ["a duplicate model id", { claude: { "Claude-Opus": 1, "claude-opus": 2 } }],
    ["a fractional token count", { claude: { "claude-opus": 1.5 } }],
    ["more tokens than the provider", { claude: { "claude-opus": 5000, "claude-haiku": 679 } }],
    ["too many models", { claude: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`model-${i}`, 1])) }],
  ])("rejects models with %s", (_, models) => {
    expect(errorsOf({ ...VALID, models })).toHaveLength(1);
  });

  it("accepts a split by day, sorts the days and normalizes their ids", () => {
    const result = parseUsageReport(
      {
        ...VALID,
        days: {
          "2026-09-21": { providers: { Claude: 600 } },
          "2026-09-20": {
            providers: { claude: 5000, deepseek: 1234 },
            models: { claude: { "Claude-Opus-4-5": 4000 } },
          },
        },
      },
      OPTIONS,
    );
    expect(result.ok && result.report.days).toEqual([
      {
        date: "2026-09-20",
        providers: { claude: 5000, deepseek: 1234 },
        models: { claude: { "claude-opus-4-5": 4000 } },
        hours: {},
      },
      { date: "2026-09-21", providers: { claude: 600 }, models: {}, hours: {} },
    ]);
  });

  it("accepts a day's hours, sorted, even when they cover only part of the day", () => {
    const result = parseUsageReport(
      {
        ...VALID,
        days: {
          "2026-09-21": {
            providers: { claude: 600 },
            // 00:00 and 01:00 in Budapest, which is two hours ahead of UTC in September.
            hours: { Claude: { "2026-09-20T23:00:00Z": 200, "2026-09-20T22:00:00Z": 300 } },
          },
        },
      },
      OPTIONS,
    );
    expect(result.ok && result.report.days[0]!.hours).toEqual({
      claude: [
        { startMs: Date.parse("2026-09-20T22:00:00Z"), tokens: 300 },
        { startMs: Date.parse("2026-09-20T23:00:00Z"), tokens: 200 },
      ],
    });
  });

  it.each([
    ["not an object", 5],
    ["a provider not of the day", { deepseek: { "2026-09-21T08:00:00Z": 1 } }],
    ["hours not an object", { claude: 5 }],
    ["a key that is not a whole hour", { claude: { "2026-09-21T08:30:00Z": 1 } }],
    ["a key that is not in UTC", { claude: { "2026-09-21T10:00:00+02:00": 1 } }],
    ["an hour that does not exist", { claude: { "2026-09-21T24:00:00Z": 1 } }],
    ["an hour of the day before", { claude: { "2026-09-20T21:00:00Z": 1 } }],
    ["an hour of the day after", { claude: { "2026-09-21T22:00:00Z": 1 } }],
    ["a fractional token count", { claude: { "2026-09-21T08:00:00Z": 1.5 } }],
    ["more tokens than the day", { claude: { "2026-09-21T08:00:00Z": 400, "2026-09-21T09:00:00Z": 201 } }],
    [
      "too many hours",
      {
        claude: Object.fromEntries(
          Array.from({ length: 26 }, (_, i) => [
            `2026-09-${i < 2 ? 20 : 21}T${String((22 + i) % 24).padStart(2, "0")}:00:00Z`,
            1,
          ]),
        ),
      },
    ],
  ])("rejects hours with %s", (_, hours) => {
    expect(errorsOf({ ...VALID, days: { "2026-09-21": { providers: { claude: 600 }, hours } } })).toHaveLength(1);
  });

  it.each([
    ["not an object", []],
    ["a key that is not a date", { yesterday: { providers: { claude: 1 } } }],
    ["a date that does not exist", { "2026-02-30": { providers: { claude: 1 } } }],
    ["a day that is not an object", { "2026-09-20": 5 }],
    ["a day without providers", { "2026-09-20": { models: {} } }],
    ["a provider not in providers", { "2026-09-20": { providers: { openai: 1 } } }],
    ["a fractional token count", { "2026-09-20": { providers: { claude: 1.5 } } }],
    [
      "a model split larger than its day",
      { "2026-09-20": { providers: { claude: 10 }, models: { claude: { "claude-opus": 11 } } } },
    ],
    [
      "days adding up to more than the provider",
      { "2026-09-20": { providers: { claude: 5000 } }, "2026-09-21": { providers: { claude: 679 } } },
    ],
    [
      "too many days",
      Object.fromEntries(
        Array.from({ length: 33 }, (_, i) => [
          new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10),
          { providers: { claude: 1 } },
        ]),
      ),
    ],
  ])("rejects days with %s", (_, days) => {
    expect(errorsOf({ ...VALID, days })).toHaveLength(1);
  });

  it("ignores unknown extra fields", () => {
    expect(parseUsageReport({ ...VALID, hostname: "x", extra: { a: 1 } }, OPTIONS).ok).toBe(true);
  });

  it("defaults mode to auto and intervalMinutes to null when both are absent", () => {
    const result = parseUsageReport(VALID, OPTIONS);
    expect(result.ok && result.report.mode).toBe("auto");
    expect(result.ok && result.report.intervalMinutes).toBeNull();
  });

  it("accepts an explicit mode and, for auto, an interval within range", () => {
    const manual = parseUsageReport({ ...VALID, mode: "manual" }, OPTIONS);
    expect(manual.ok && manual.report.mode).toBe("manual");
    expect(manual.ok && manual.report.intervalMinutes).toBeNull();

    const auto = parseUsageReport({ ...VALID, mode: "auto", intervalMinutes: 30 }, OPTIONS);
    expect(auto.ok && auto.report.mode).toBe("auto");
    expect(auto.ok && auto.report.intervalMinutes).toBe(30);

    for (const intervalMinutes of [5, 1440]) {
      const boundary = parseUsageReport({ ...VALID, mode: "auto", intervalMinutes }, OPTIONS);
      expect(boundary.ok && boundary.report.intervalMinutes, String(intervalMinutes)).toBe(intervalMinutes);
    }
  });

  it.each(["Auto", "AUTO", "", "silent", 1, null])("rejects an invalid mode: %j", (mode) => {
    expect(errorsOf({ ...VALID, mode })).toHaveLength(1);
  });

  it.each([4, 1441, 0, -5, 1.5, Number.NaN, "60", null])(
    "rejects an intervalMinutes outside 5-1440 or not a whole number: %j",
    (intervalMinutes) => {
      expect(errorsOf({ ...VALID, intervalMinutes })).toHaveLength(1);
    },
  );

  it("accepts intervalMinutes sent alongside mode manual (unused, but not an error)", () => {
    const result = parseUsageReport({ ...VALID, mode: "manual", intervalMinutes: 60 }, OPTIONS);
    expect(result.ok && result.report.mode).toBe("manual");
    expect(result.ok && result.report.intervalMinutes).toBe(60);
  });
});

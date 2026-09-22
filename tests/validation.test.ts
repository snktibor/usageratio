import { describe, expect, it } from "vitest";
import { parseUsageReport } from "@/lib/validation";

const NOW = new Date("2026-09-21T10:00:30Z");
const OPTIONS = { now: NOW, maxClockSkewMinutes: 10, retentionDays: 35 };

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
        timestampMs: Date.parse("2026-09-21T10:00:00Z"),
        timestamp: "2026-09-21T10:00:00.000Z",
      },
    });
  });

  it("trims identifiers and allows accented letters, spaces, dots, dashes and underscores", () => {
    const result = parseUsageReport(
      { ...VALID, machineId: "  Tibor gépe_2.0-win  ", groupId: "Munka" },
      OPTIONS,
    );
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

  it("normalizes provider ids and rejects invalid, empty or duplicate provider maps", () => {
    const normalized = parseUsageReport({ ...VALID, providers: { Claude: 12, OpenAI: 8 } }, OPTIONS);
    expect(normalized.ok && normalized.report.providers).toEqual({ claude: 12, openai: 8 });
    expect(errorsOf({ ...VALID, providers: {} })).toHaveLength(1);
    expect(errorsOf({ ...VALID, providers: { "bad/provider": 1 } })).toHaveLength(1);
    expect(errorsOf({ ...VALID, providers: { Claude: 1, claude: 2 } })).toHaveLength(1);
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

  it("ignores unknown extra fields", () => {
    expect(parseUsageReport({ ...VALID, hostname: "x", extra: { a: 1 } }, OPTIONS).ok).toBe(true);
  });
});
